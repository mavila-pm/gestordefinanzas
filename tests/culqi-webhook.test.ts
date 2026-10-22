import { describe, expect, it } from 'vitest';
import { handleCulqiWebhook } from '../src/infrastructure/billing/culqi-webhook';
import { charge, FakeProvider, MemoryStore, ORDER, providerError, subscription, USER } from './billing-fakes';

/**
 * Culqi webhook (ADR-0018). Culqi does not sign webhooks: Basic auth, then the body is only a hint — the object is
 * RE-FETCHED with the secret key and only Culqi's own copy is acted on. A replay has one effect.
 */
const USERNAME = 'culqi-hook';
const PASSWORD = 'p'.repeat(32);
const auth = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
const body = (type: string, id: string, eventId = 'evt_test_E1v2E3n4T5o6K7a8', asString = false) => {
  const data = { object: 'x', id, amount: 1, metadata: { order_id: ORDER } };
  return JSON.stringify({ object: 'event', id: eventId, type, data: asString ? JSON.stringify(data) : data });
};
function setup(order: Parameters<MemoryStore['addOrder']>[0] = { status: 'processing', provider: 'culqi', livemode: false }) {
  const store = new MemoryStore();
  const provider = new FakeProvider();
  store.addOrder(order);
  const deps = { store, provider, auth: { user: USERNAME, password: PASSWORD } };
  const send = (raw: string, header: string | null = auth) => handleCulqiWebhook({ headers: new Headers(header ? { authorization: header } : {}), rawBody: raw }, deps);
  return { store, provider, send };
}

describe('Culqi webhook: authenticity and limits', () => {
  it('401 without the right Basic credentials (and nothing is read or stored)', async () => {
    const { send, store, provider } = setup();
    for (const h of [null, 'Basic ' + Buffer.from(`${USERNAME}:wrong`).toString('base64'), `Bearer ${PASSWORD}`]) {
      expect((await send(body('charge.creation.succeeded', 'chr_test_A1b2C3d4E5f6G7h8'), h)).status).toBe(401);
    }
    expect(store.receipts.size).toBe(0);
    expect(provider.calls).toEqual([]);
  });
  it('413 above 64 KB, 400 for a body that is not an event', async () => {
    const { send } = setup();
    expect((await send('x'.repeat(65 * 1024))).status).toBe(413);
    for (const raw of ['', 'not json', '{"type":1}', '{"type":"<script>"}']) expect((await send(raw)).status).toBe(400);
  });
});

describe('Culqi webhook: the body is a hint, Culqi is re-asked', () => {
  it('charge succeeded → re-fetch → activation of the order in flight (data as JSON string too)', async () => {
    const { send, store, provider } = setup();
    const r = await send(body('charge.creation.succeeded', 'chr_test_A1b2C3d4E5f6G7h8', 'evt_test_E1v2E3n4T5o6K7a8', true));
    expect(r).toEqual({ status: 200, body: { status: 'processed' } });
    expect(provider.calls).toEqual(['getCharge']);
    expect(store.orders.get(ORDER)?.status).toBe('paid');
  });
  it('a forged "charge succeeded" whose re-fetch shows a failure or another amount → no activation', async () => {
    const a = setup();
    a.provider.answers.getCharge = { ok: true, value: charge({ succeeded: false }) };
    expect((await a.send(body('charge.creation.succeeded', 'chr_test_A1b2C3d4E5f6G7h8'))).status).toBe(200);
    expect(a.store.orders.get(ORDER)?.status).toBe('failed');
    expect(a.store.plusUsers.size).toBe(0);
    const b = setup();
    b.provider.answers.getCharge = { ok: true, value: charge({ amountMinor: 100 }) };
    await b.send(body('charge.creation.succeeded', 'chr_test_A1b2C3d4E5f6G7h8'));
    expect(b.store.plusUsers.size).toBe(0);
    expect(b.provider.calls).toEqual(['getCharge', 'refund']);
    const c = setup();
    c.provider.answers.getCharge = providerError('not_found');
    expect(await c.send(body('charge.creation.succeeded', 'chr_test_A1b2C3d4E5f6G7h8'))).toEqual({ status: 200, body: { status: 'rejected' } });
    expect(c.store.plusUsers.size).toBe(0);
  });
  it('a replay (same event id) has one effect: duplicate, no second fetch', async () => {
    const { send, store, provider } = setup();
    await send(body('charge.creation.succeeded', 'chr_test_A1b2C3d4E5f6G7h8'));
    expect(await send(body('charge.creation.succeeded', 'chr_test_A1b2C3d4E5f6G7h8'))).toEqual({ status: 200, body: { status: 'duplicate' } });
    expect(provider.calls).toEqual(['getCharge']);
    expect(store.events.filter((e) => e.startsWith('activate:'))).toHaveLength(1);
    // Another delivery for the same charge (new event id): re-fetched, still one activation (SQL idempotency).
    await send(body('charge.creation.succeeded', 'chr_test_A1b2C3d4E5f6G7h8', 'evt_test_Other0000000000'));
    expect(store.events.filter((e) => e.startsWith('activate:'))).toHaveLength(1);
  });
  it('Culqi or the database failing → 500 (the receipt stays open; Culqi retries and it is processed)', async () => {
    const { send, provider, store } = setup();
    provider.answers.getCharge = providerError('unavailable', 'network');
    expect((await send(body('charge.creation.succeeded', 'chr_test_A1b2C3d4E5f6G7h8'))).status).toBe(500);
    provider.answers.getCharge = undefined;
    expect((await send(body('charge.creation.succeeded', 'chr_test_A1b2C3d4E5f6G7h8'))).status).toBe(200);
    expect(store.orders.get(ORDER)?.status).toBe('paid');
  });
  it('unknown types, objects of the other mode and unmatched charges are acknowledged and ignored', async () => {
    const { send, provider } = setup();
    expect(await send(body('token.creation.succeeded', 'tkn_test_Z9y8X7w6V5u4T3s2'))).toEqual({ status: 200, body: { status: 'ignored' } });
    expect(await send(body('charge.creation.succeeded', 'chr_live_A1b2C3d4E5f6G7h8', 'evt_test_Live000000000000'))).toEqual({ status: 200, body: { status: 'ignored' } });
    provider.answers.getCharge = { ok: true, value: charge({ orderId: null }) };
    expect(await send(body('charge.creation.succeeded', 'chr_test_A1b2C3d4E5f6G7h8', 'evt_test_Unmatched0000000'))).toEqual({ status: 200, body: { status: 'ignored' } });
  });
  it('a lost subscription answer is healed: the re-fetched subscription carries our order id → activation', async () => {
    const { send, store, provider } = setup({ status: 'processing', provider: 'culqi', livemode: false, planCode: 'monthly', amountMinor: 400, trialDays: 14 });
    expect(await send(body('subscription.creation.succeeded', 'sxn_test_S1u2B3s4C5r6I7p8'))).toEqual({ status: 200, body: { status: 'processed' } });
    expect(provider.calls).toEqual(['getSubscription']);
    expect(store.orders.get(ORDER)?.status).toBe('trialing');
  });
  it('a period charge of a known subscription renews it (re-fetched date); a failed one marks past_due; refunds are recorded', async () => {
    const { send, store, provider } = setup({ status: 'processing', provider: 'culqi', livemode: false, planCode: 'monthly', amountMinor: 400, trialDays: 14 });
    await send(body('subscription.creation.succeeded', 'sxn_test_S1u2B3s4C5r6I7p8'));
    const next = new Date(Date.now() + 44 * 86_400_000);
    provider.answers.getSubscription = { ok: true, value: subscription({ nextBillingDate: next }) };
    provider.answers.getCharge = { ok: true, value: charge({ id: 'chr_test_Renewal000000000', amountMinor: 400, orderId: null, subscriptionRef: 'sxn_test_S1u2B3s4C5r6I7p8' }) };
    expect(await send(body('charge.creation.succeeded', 'chr_test_Renewal000000000', 'evt_test_Renewal000000000'))).toEqual({ status: 200, body: { status: 'processed' } });
    expect(store.subs.get('sxn_test_S1u2B3s4C5r6I7p8')).toMatchObject({ status: 'active', periodEnd: next });
    provider.answers.getCharge = { ok: true, value: charge({ id: 'chr_test_Failed0000000000', amountMinor: 400, orderId: null, subscriptionRef: 'sxn_test_S1u2B3s4C5r6I7p8', succeeded: false }) };
    await send(body('charge.creation.failed', 'chr_test_Failed0000000000', 'evt_test_Failed0000000000'));
    expect(store.subs.get('sxn_test_S1u2B3s4C5r6I7p8')?.status).toBe('past_due');
    expect(store.events).toContain('past_due:chr_test_Failed0000000000');
    expect(USER).toBe(store.subs.get('sxn_test_S1u2B3s4C5r6I7p8')?.userId);
  });
  it('a renewal charged after the person cancelled is refunded at once', async () => {
    const { send, store, provider } = setup({ status: 'processing', provider: 'culqi', livemode: false, planCode: 'monthly', amountMinor: 400, trialDays: 14 });
    await send(body('subscription.creation.succeeded', 'sxn_test_S1u2B3s4C5r6I7p8'));
    store.subs.get('sxn_test_S1u2B3s4C5r6I7p8')!.cancel = true;
    provider.answers.getSubscription = { ok: true, value: subscription({ nextBillingDate: new Date(Date.now() + 44 * 86_400_000) }) };
    provider.answers.getCharge = { ok: true, value: charge({ id: 'chr_test_AfterCancel00000', amountMinor: 400, orderId: null, subscriptionRef: 'sxn_test_S1u2B3s4C5r6I7p8' }) };
    await send(body('charge.creation.succeeded', 'chr_test_AfterCancel00000', 'evt_test_AfterCancel00000'));
    expect(provider.calls.at(-1)).toBe('refund');
  });
});
