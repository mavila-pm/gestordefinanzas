import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { cancelRenewal, payLifetime, paySubscription } from '../../src/billing/checkout';
import { PgBillingStore } from '../../src/infrastructure/billing/pg-billing-store';
import { handleCulqiWebhook } from '../../src/infrastructure/billing/culqi-webhook';
import { charge, FakeProvider, subscription } from '../billing-fakes';
import { effectivePlan, orderFor, resetBilling } from './billing-helpers';
import { DATABASE_URL, makePool, USER_A, USER_B } from './helpers';

/**
 * The checkout and webhook flows against the REAL SQL (migrations 054–056) through PgBillingStore — the store the
 * server uses over DATABASE_URL — with Culqi mocked (never the real API). Sandbox mode (test keys) like Preview:
 * only demo accounts may pay.
 */
const TKN = 'tkn_test_Z9y8X7w6V5u4T3s2';
const customer = { firstName: 'Ana', lastName: 'Pérez', phoneNumber: '987654321', address: 'Av. Arequipa 123', addressCity: 'Lima' };
const plans = { 'monthly:400:trial': 'pln_test_M1o2N3t4H5l6Y7t8', 'annual:5900:trial': 'pln_test_A1n2N3u4A5l6T7r8' };
const PW = 'p'.repeat(32);
const auth = `Basic ${Buffer.from(`culqi-hook:${PW}`).toString('base64')}`;
const hook = (type: string, id: string, eventId: string) => JSON.stringify({ object: 'event', id: eventId, type, data: { id } });

describe.skipIf(!DATABASE_URL)('billing checkout + webhook over the real SQL (ADR-0018)', () => {
  let pool: pg.Pool;
  let store: PgBillingStore;
  beforeAll(() => { pool = makePool(); store = new PgBillingStore(pool); });
  beforeEach(async () => {
    await resetBilling(pool);
    await pool.query(`insert into public.demo_access (user_id) values ($1)`, [USER_A]);
  });
  afterAll(async () => { await pool?.end(); });
  const order = async (id: string) => (await pool.query('select status, provider, provider_ref, livemode, failure from public.billing_orders where id = $1', [id])).rows[0];
  const sub = async (user: string) => (await pool.query('select status, billing_plan, provider_ref, livemode, cancel_at_period_end, trial_ends_at, current_period_end from public.subscriptions where user_id = $1', [user])).rows[0];
  const events = async () => (await pool.query(`select event_ref, outcome, detail from public.billing_events order by id`)).rows as Array<{ event_ref: string; outcome: string; detail: string | null }>;

  it('Vitalicio in the sandbox: one charge of the stored amount → paid → Plus, with the ledger', async () => {
    const id = await orderFor(pool, USER_A, 'lifetime');
    const provider = new FakeProvider();
    provider.answers.charge = () => ({ ok: true, value: charge({ orderId: id }) });
    expect(await payLifetime({ store, provider }, { orderId: id, userId: USER_A, email: 'a@test.local', tokenRef: TKN })).toEqual({ status: 'paid', orderId: id });
    expect(await order(id)).toMatchObject({ status: 'paid', provider: 'culqi', provider_ref: 'chr_test_A1b2C3d4E5f6G7h8', livemode: false });
    expect(await sub(USER_A)).toMatchObject({ status: 'active', billing_plan: 'lifetime', livemode: false });
    expect(await effectivePlan(pool, USER_A)).toBe('plus');
    expect((await events()).map((e) => e.event_ref)).toEqual([`begin:${id}`, `activate:${id}`]);
  });

  it('double submit against the real lock: exactly one charge reaches Culqi', async () => {
    const id = await orderFor(pool, USER_A, 'lifetime');
    const provider = new FakeProvider();
    provider.answers.charge = () => ({ ok: true, value: charge({ orderId: id }) });
    const r = await Promise.all([1, 2, 3].map(() => payLifetime({ store, provider }, { orderId: id, userId: USER_A, email: 'a@test.local', tokenRef: TKN })));
    expect(r.filter((x) => x.status === 'paid')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'refused')).toHaveLength(2);
    expect(provider.calls.filter((c) => c === 'charge')).toHaveLength(1);
  });

  it('a test-mode charge for a real (non-demo) account is refused before Culqi is called', async () => {
    const id = await orderFor(pool, USER_B, 'lifetime');
    const provider = new FakeProvider();
    expect(await payLifetime({ store, provider }, { orderId: id, userId: USER_B, email: 'b@test.local', tokenRef: TKN })).toEqual({ status: 'refused', code: 'test_mode_demo_only' });
    expect(provider.calls).toEqual([]);
    expect(await sub(USER_B)).toBeUndefined();
  });

  it('declined → failed, no Plus; charged-but-refused → refunded in SQL (order refunded, ledger needs_refund then refund)', async () => {
    const a = await orderFor(pool, USER_A, 'lifetime');
    const p1 = new FakeProvider();
    p1.answers.charge = { ok: false, kind: 'declined', code: 'insufficient_funds', status: 402 };
    expect((await payLifetime({ store, provider: p1 }, { orderId: a, userId: USER_A, email: 'a@test.local', tokenRef: TKN })).status).toBe('declined');
    expect(await order(a)).toMatchObject({ status: 'failed', failure: 'insufficient_funds' });
    expect(await effectivePlan(pool, USER_A)).toBe('free');
    // A charge of another amount: never activated, given back.
    const b = await orderFor(pool, USER_A, 'lifetime');
    const p2 = new FakeProvider();
    p2.answers.charge = () => ({ ok: true, value: charge({ orderId: b, amountMinor: 100, id: 'chr_test_Wrong0000000000' }) });
    p2.answers.refund = { ok: true, value: { id: 'ref_test_Wrong0000000000', chargeRef: 'chr_test_Wrong0000000000', amountMinor: 100, livemode: false } };
    expect((await payLifetime({ store, provider: p2 }, { orderId: b, userId: USER_A, email: 'a@test.local', tokenRef: TKN })).status).toBe('refunded');
    expect(await order(b)).toMatchObject({ status: 'failed', provider_ref: 'chr_test_Wrong0000000000' });
    expect((await events()).filter((e) => e.outcome === 'needs_refund').map((e) => e.event_ref)).toEqual([`fail:${b}`]);
    expect(await effectivePlan(pool, USER_A)).toBe('free');
  });

  it('a full refund of Vitalicio made in CulqiPanel (webhook) → order refunded, plan canceled → Free; data kept', async () => {
    const id = await orderFor(pool, USER_A, 'lifetime');
    const provider = new FakeProvider();
    provider.answers.charge = () => ({ ok: true, value: charge({ orderId: id }) });
    await payLifetime({ store, provider }, { orderId: id, userId: USER_A, email: 'a@test.local', tokenRef: TKN });
    const deps = { store, provider, auth: { user: 'culqi-hook', password: PW } };
    const r = await handleCulqiWebhook({ headers: new Headers({ authorization: auth }), rawBody: hook('refund.creation.succeeded', 'ref_test_R1e2F3u4N5d6O7k8', 'evt_test_Ref0000000000001') }, deps);
    expect(r).toEqual({ status: 200, body: { status: 'processed' } });
    expect((await order(id)).status).toBe('refunded');
    expect(await sub(USER_A)).toMatchObject({ status: 'canceled', billing_plan: 'lifetime' });
    expect(await effectivePlan(pool, USER_A)).toBe('free');
    expect((await events()).filter((e) => e.event_ref === 'refund:ref_test_R1e2F3u4N5d6O7k8')).toEqual([{ event_ref: 'refund:ref_test_R1e2F3u4N5d6O7k8', outcome: 'processed', detail: 'full' }]);
  });

  it('Mensual with trial: customer saved, trialing with Culqi dates; cancel keeps Plus until the trial end', async () => {
    const id = await orderFor(pool, USER_A, 'monthly');
    const provider = new FakeProvider();
    provider.answers.createSubscription = () => ({ ok: true, value: subscription({ orderId: id }) });
    expect(await paySubscription({ store, provider, plans }, { orderId: id, userId: USER_A, email: 'a@test.local', tokenRef: TKN, customer })).toEqual({ status: 'trialing', orderId: id });
    expect((await pool.query('select customer_ref, card_ref, livemode from public.billing_customers where user_id = $1', [USER_A])).rows[0])
      .toEqual({ customer_ref: 'cus_test_C1u2S3t4O5m6E7r8', card_ref: 'crd_test_C1a2R3d4O5k6A7b8', livemode: false });
    expect(await sub(USER_A)).toMatchObject({ status: 'trialing', billing_plan: 'monthly', provider_ref: 'sxn_test_S1u2B3s4C5r6I7p8', cancel_at_period_end: false });
    expect(await effectivePlan(pool, USER_A)).toBe('trial');
    const c = await cancelRenewal({ store, provider }, { userId: USER_A, subRef: 'sxn_test_S1u2B3s4C5r6I7p8' });
    expect(c.ok && c.until?.toISOString()).toBe((await sub(USER_A)).trial_ends_at.toISOString());
    expect(await sub(USER_A)).toMatchObject({ cancel_at_period_end: true });
    expect(await effectivePlan(pool, USER_A)).toBe('trial');
  });

  it('webhook: Basic auth, re-fetch, one effect per delivery; heals a lost subscription answer; renews a period', async () => {
    const id = await orderFor(pool, USER_A, 'monthly');
    const provider = new FakeProvider();
    // The checkout's createSubscription answer was lost (timeout): the order stays processing.
    provider.answers.createSubscription = { ok: false, kind: 'unknown', code: 'network', status: null };
    expect((await paySubscription({ store, provider, plans }, { orderId: id, userId: USER_A, email: 'a@test.local', tokenRef: TKN, customer })).status).toBe('pending');
    expect((await order(id)).status).toBe('processing');
    const deps = { store, provider, auth: { user: 'culqi-hook', password: PW } };
    const send = (raw: string) => handleCulqiWebhook({ headers: new Headers({ authorization: auth }), rawBody: raw }, deps);
    provider.answers.getSubscription = () => ({ ok: true, value: subscription({ orderId: id }) });
    expect(await send(hook('subscription.creation.succeeded', 'sxn_test_S1u2B3s4C5r6I7p8', 'evt_test_Sub0000000000001'))).toEqual({ status: 200, body: { status: 'processed' } });
    expect((await order(id)).status).toBe('trialing');
    expect(await send(hook('subscription.creation.succeeded', 'sxn_test_S1u2B3s4C5r6I7p8', 'evt_test_Sub0000000000001'))).toEqual({ status: 200, body: { status: 'duplicate' } });
    // First charge at the trial end: Culqi moved the next billing date one month on.
    const trialEnd: Date = (await sub(USER_A)).trial_ends_at;
    const next = new Date(trialEnd.getTime() + 30 * 86_400_000);
    provider.answers.getSubscription = { ok: true, value: subscription({ orderId: id, nextBillingDate: next }) };
    provider.answers.getCharge = { ok: true, value: charge({ id: 'chr_test_First000000000000', amountMinor: 400, orderId: null, subscriptionRef: 'sxn_test_S1u2B3s4C5r6I7p8' }) };
    expect(await send(hook('charge.creation.succeeded', 'chr_test_First000000000000', 'evt_test_Chr0000000000001'))).toEqual({ status: 200, body: { status: 'processed' } });
    expect(await sub(USER_A)).toMatchObject({ status: 'active' });
    expect((await sub(USER_A)).current_period_end.toISOString()).toBe(next.toISOString());
    // The same charge delivered again under another event id: re-fetched, recorded once.
    expect(await send(hook('charge.creation.succeeded', 'chr_test_First000000000000', 'evt_test_Chr0000000000002'))).toEqual({ status: 200, body: { status: 'processed' } });
    const ev = await events();
    expect(ev.filter((e) => e.event_ref === 'renewal:chr_test_First000000000000')).toHaveLength(1);
    expect(ev.filter((e) => e.event_ref.startsWith('evt_test_')).every((e) => e.outcome !== 'received')).toBe(true);
    // A forged event for an unknown charge: Culqi says it does not exist → rejected, nothing changes.
    provider.answers.getCharge = { ok: false, kind: 'not_found', code: 'not_found', status: 404 };
    expect(await send(hook('charge.creation.succeeded', 'chr_test_Forged00000000000', 'evt_test_Forged0000000001'))).toEqual({ status: 200, body: { status: 'rejected' } });
    expect(await sub(USER_A)).toMatchObject({ status: 'active' });
  });
});
