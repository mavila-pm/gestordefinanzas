import { describe, expect, it } from 'vitest';
import { handleCulqiWebhook } from '../src/infrastructure/billing/culqi-webhook';
import { charge, FakeProvider, MemoryStore, ORDER, providerError, subscription, USER } from './billing-fakes';

/**
 * Culqi webhook (ADR-0019). Culqi does not sign webhooks: Basic auth, then the body is only a hint — the object is
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
  it('a refund made in CulqiPanel: re-fetched refund and charge → Vitalicio refunded, Plus removed; replay once', async () => {
    const { send, store, provider } = setup();
    await send(body('charge.creation.succeeded', 'chr_test_A1b2C3d4E5f6G7h8'));
    expect(store.plusUsers.has(USER)).toBe(true);
    expect(await send(body('refund.creation.succeeded', 'ref_test_R1e2F3u4N5d6O7k8', 'evt_test_Refund000000000'))).toEqual({ status: 200, body: { status: 'processed' } });
    expect(provider.calls.slice(-2)).toEqual(['getRefund', 'getCharge']);
    expect(store.orders.get(ORDER)?.status).toBe('refunded');
    expect(store.plusUsers.has(USER)).toBe(false);
    expect(await send(body('refund.creation.succeeded', 'ref_test_R1e2F3u4N5d6O7k8', 'evt_test_Refund000000001'))).toEqual({ status: 200, body: { status: 'processed' } });
    expect(store.events.filter((e) => e.startsWith('refund:'))).toHaveLength(1);
    // A refund of a charge Velsuno never recorded: acknowledged, nothing changes.
    provider.answers.getRefund = { ok: true, value: { id: 'ref_test_Unknown000000000', chargeRef: 'chr_test_Unknown000000000', amountMinor: 100, livemode: false } };
    expect(await send(body('refund.creation.succeeded', 'ref_test_Unknown000000000', 'evt_test_Refund000000002'))).toEqual({ status: 200, body: { status: 'ignored' } });
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

describe('Culqi webhook: periods only from charges; charges no row holds are never ignored (review F 1–4)', () => {
  const SXN = 'sxn_test_S1u2B3s4C5r6I7p8';
  const monthly = { status: 'processing', provider: 'culqi', livemode: false, planCode: 'monthly', amountMinor: 400, trialDays: 14 } as const;
  const days = (n: number) => new Date(Date.now() + n * 86_400_000);

  it('a subscription event never grants a period: past_due + a later next billing date → still past_due, ignored', async () => {
    const { send, store, provider } = setup(monthly);
    await send(body('subscription.creation.succeeded', SXN));
    const s = store.subs.get(SXN)!;
    s.status = 'past_due';
    const end = s.periodEnd;
    provider.answers.getSubscription = { ok: true, value: subscription({ nextBillingDate: days(44) }) };
    expect(await send(body('subscription.update.succeeded', SXN, 'evt_test_SubUpd000000000'))).toEqual({ status: 200, body: { status: 'ignored' } });
    expect(store.subs.get(SXN)).toMatchObject({ status: 'past_due', periodEnd: end });
    expect(store.events.some((e) => e.startsWith('renewal:'))).toBe(false);
    expect(store.receipts.get('evt_test_SubUpd000000000')).toMatchObject({ outcome: 'ignored', detail: 'subscription_event' });
  });

  it('a period charge that also carries the order id takes the period path (renewal / past_due), never the Vitalicio one', async () => {
    const { send, store, provider } = setup(monthly);
    await send(body('subscription.creation.succeeded', SXN));
    const next = days(44);
    provider.answers.getSubscription = { ok: true, value: subscription({ nextBillingDate: next }) };
    provider.answers.getCharge = { ok: true, value: charge({ id: 'chr_test_Both000000000000', amountMinor: 400, orderId: ORDER, subscriptionRef: SXN }) };
    expect(await send(body('charge.creation.succeeded', 'chr_test_Both000000000000', 'evt_test_Both000000000000'))).toEqual({ status: 200, body: { status: 'processed' } });
    expect(store.subs.get(SXN)).toMatchObject({ status: 'active', periodEnd: next });
    // Only the order id (no subscription id on the charge): the order's subscription reference is used.
    provider.answers.getSubscription = { ok: true, value: subscription({ nextBillingDate: days(74) }) };
    provider.answers.getCharge = { ok: true, value: charge({ id: 'chr_test_OrderOnly0000000', amountMinor: 400, orderId: ORDER, subscriptionRef: null }) };
    await send(body('charge.creation.succeeded', 'chr_test_OrderOnly0000000', 'evt_test_OrderOnly0000000'));
    expect(store.events).toContain('renewal:chr_test_OrderOnly0000000');
    provider.answers.getCharge = { ok: true, value: charge({ id: 'chr_test_BothFail00000000', amountMinor: 400, orderId: ORDER, subscriptionRef: SXN, succeeded: false }) };
    await send(body('charge.creation.failed', 'chr_test_BothFail00000000', 'evt_test_BothFail00000000'));
    expect(store.subs.get(SXN)?.status).toBe('past_due');
    expect(store.orders.get(ORDER)?.status).toBe('trialing');
  });

  it('a successful charge of a subscription nothing links to Velsuno → needs_refund for the owner, no automatic refund', async () => {
    const { send, store, provider } = setup();
    provider.answers.getCharge = { ok: true, value: charge({ id: 'chr_test_Nobody00000000', amountMinor: 400, orderId: null, subscriptionRef: 'sxn_test_Nobody00000000' }) };
    provider.answers.getSubscription = { ok: true, value: subscription({ id: 'sxn_test_Nobody00000000', orderId: null }) };
    expect(await send(body('charge.creation.succeeded', 'chr_test_Nobody00000000', 'evt_test_Nobody00000000'))).toEqual({ status: 200, body: { status: 'needs_refund' } });
    expect(provider.calls).not.toContain('refund');
    expect(provider.calls).not.toContain('cancelSubscription');
    expect(store.events).toContain('orphan:chr_test_Nobody00000000');
    // Delivered again: recorded once.
    expect(await send(body('charge.creation.succeeded', 'chr_test_Nobody00000000', 'evt_test_Nobody00000001'))).toEqual({ status: 200, body: { status: 'ignored' } });
    expect(store.events.filter((e) => e.startsWith('orphan:'))).toHaveLength(1);
  });

  it('refused no-trial subscription whose cancel failed: the next event retries the cancel; its charge is refunded once', async () => {
    const { send, store, provider } = setup({ ...monthly, trialDays: 0 });
    // The checkout's answer was lost; Culqi's subscription has no usable date → activation refused; the cancel fails.
    provider.answers.getSubscription = { ok: true, value: subscription({ trialEnd: null, nextBillingDate: null }) };
    provider.answers.cancelSubscription = providerError('unavailable', 'network');
    expect(await send(body('subscription.creation.succeeded', SXN, 'evt_test_SubNew000000000'))).toEqual({ status: 200, body: { status: 'needs_refund' } });
    expect(store.orders.get(ORDER)).toMatchObject({ status: 'failed', providerRef: SXN });
    expect(store.plusUsers.size).toBe(0);
    // Its next event: the cancel is retried (500 while Culqi keeps failing; Culqi redelivers), then done.
    expect((await send(body('subscription.update.succeeded', SXN, 'evt_test_SubUpd000000001'))).status).toBe(500);
    provider.answers.cancelSubscription = undefined;
    expect(await send(body('subscription.update.succeeded', SXN, 'evt_test_SubUpd000000001'))).toEqual({ status: 200, body: { status: 'processed' } });
    // Its first charge (the plan charged at creation): flagged, the subscription stopped again, refunded once.
    provider.calls = [];
    provider.answers.getCharge = { ok: true, value: charge({ id: 'chr_test_FirstNoTrial00000', amountMinor: 400, orderId: ORDER, subscriptionRef: null }) };
    expect(await send(body('charge.creation.succeeded', 'chr_test_FirstNoTrial00000', 'evt_test_ChrFirst00000000'))).toEqual({ status: 200, body: { status: 'processed' } });
    expect(provider.calls).toEqual(['getCharge', 'cancelSubscription', 'refund']);
    expect(store.events).toContain('orphan:chr_test_FirstNoTrial00000');
    await send(body('charge.creation.succeeded', 'chr_test_FirstNoTrial00000', 'evt_test_ChrFirst00000001'));
    expect(provider.calls.filter((c) => c === 'refund')).toHaveLength(1);
    expect(store.events.filter((e) => e.startsWith('refund:'))).toHaveLength(1);
    expect(store.plusUsers.size).toBe(0);
  });

  it('a refund that fails leaves needs_refund; a cancel that fails after the refund is retried without refunding again', async () => {
    const a = setup({ ...monthly, status: 'failed', providerRef: SXN });
    a.provider.answers.getCharge = { ok: true, value: charge({ id: 'chr_test_Unheld000000000', amountMinor: 400, orderId: ORDER, subscriptionRef: SXN }) };
    a.provider.answers.refund = providerError('unavailable', 'network');
    expect(await a.send(body('charge.creation.succeeded', 'chr_test_Unheld000000000'))).toEqual({ status: 200, body: { status: 'needs_refund' } });
    const b = setup({ ...monthly, status: 'failed', providerRef: SXN });
    b.provider.answers.getCharge = a.provider.answers.getCharge;
    b.provider.answers.cancelSubscription = providerError('unavailable', 'network');
    expect((await b.send(body('charge.creation.succeeded', 'chr_test_Unheld000000000'))).status).toBe(500);
    b.provider.answers.cancelSubscription = undefined;
    expect(await b.send(body('charge.creation.succeeded', 'chr_test_Unheld000000000'))).toEqual({ status: 200, body: { status: 'processed' } });
    expect(b.provider.calls.filter((c) => c === 'refund')).toHaveLength(1);
  });

  it('a charge whose subscription is still being activated (order processing) is retried later, never flagged', async () => {
    const { send, store, provider } = setup({ ...monthly, trialDays: 0 });
    provider.answers.getCharge = { ok: true, value: charge({ id: 'chr_test_Early00000000000', amountMinor: 400, orderId: ORDER, subscriptionRef: null }) };
    expect((await send(body('charge.creation.succeeded', 'chr_test_Early00000000000', 'evt_test_Early00000000000'))).status).toBe(500);
    provider.answers.getCharge = { ok: true, value: charge({ id: 'chr_test_Early00000000001', amountMinor: 400, orderId: null, subscriptionRef: SXN }) };
    expect((await send(body('charge.creation.succeeded', 'chr_test_Early00000000001', 'evt_test_Early00000000001'))).status).toBe(500);
    expect(store.orders.get(ORDER)?.status).toBe('processing');
    expect(store.events.some((e) => e.startsWith('orphan:'))).toBe(false);
  });
});
