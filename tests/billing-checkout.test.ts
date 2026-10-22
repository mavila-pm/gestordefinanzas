import { describe, expect, it } from 'vitest';
import { cancelRenewal, payLifetime, paySubscription, planMatches } from '../src/billing/checkout';
import { parsePlan } from '../src/billing/culqi';
import { charge, FakeProvider, MemoryStore, ORDER, plan, planNoTrial, providerError, subscription, USER } from './billing-fakes';
import fx from './fixtures/culqi/responses.synthetic.json';

/**
 * Billing flows (ADR-0018) with a mocked Culqi and an in-memory store. Money invariants under test: the charge uses
 * the STORED order amount; one claim → at most one charge; a definitive "no" never grants Plus; an unknown outcome
 * is never reported as "failed"; a charge that cannot be activated is refunded; the plan sold must be the plan
 * subscribed. The same flows run against the real SQL in tests/db/billing-checkout.test.ts.
 */
const TKN = 'tkn_test_Z9y8X7w6V5u4T3s2';
const customer = { firstName: 'Ana', lastName: 'Pérez', phoneNumber: '987654321', address: 'Av. Siempre Viva 123', addressCity: 'Lima' };
const setup = (order: Parameters<MemoryStore['addOrder']>[0] = {}) => {
  const store = new MemoryStore();
  const provider = new FakeProvider();
  store.addOrder(order);
  return { store, provider, deps: { store, provider } };
};
const monthlyTrial = { planCode: 'monthly' as const, amountMinor: 400, trialDays: 14 };
const plans = { 'monthly:400:trial': 'pln_test_M1o2N3t4H5l6Y7t8', 'monthly:400:no_trial': 'pln_test_M1o2N3t4H5l6Y7n8', 'annual:5900:trial': 'pln_test_A1n2N3u4A5l6T7r8' } as const;

describe('Vitalicio: one charge of the stored amount, then activation', () => {
  it('success → one charge, order paid, Plus', async () => {
    const { store, provider, deps } = setup();
    expect(await payLifetime(deps, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN })).toEqual({ status: 'paid', orderId: ORDER });
    expect(provider.calls).toEqual(['charge']);
    expect(store.orders.get(ORDER)).toMatchObject({ status: 'paid', providerRef: 'chr_test_A1b2C3d4E5f6G7h8', provider: 'culqi', livemode: false });
    expect(store.plusUsers.has(USER)).toBe(true);
  });
  it('double submit → the second never reaches Culqi (one charge)', async () => {
    const { provider, deps } = setup();
    const [a, b] = await Promise.all([
      payLifetime(deps, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN }),
      payLifetime(deps, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['paid', 'refused']);
    expect(provider.calls.filter((c) => c === 'charge')).toHaveLength(1);
  });
  it('declined → order failed, no Plus, the decline code is kept', async () => {
    const { store, provider, deps } = setup();
    provider.answers.charge = providerError('declined', 'insufficient_funds');
    expect(await payLifetime(deps, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN })).toEqual({ status: 'declined', code: 'insufficient_funds' });
    expect(store.orders.get(ORDER)?.status).toBe('failed');
    expect(store.plusUsers.size).toBe(0);
    expect(store.events).toContain(`fail:${ORDER}:insufficient_funds`);
  });
  it('timeout / 5xx (unknown) → stays processing for the webhook; never "failed" while money may have moved', async () => {
    const { store, provider, deps } = setup();
    provider.answers.charge = providerError('unknown', 'network');
    expect(await payLifetime(deps, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN })).toEqual({ status: 'pending', orderId: ORDER });
    expect(store.orders.get(ORDER)?.status).toBe('processing');
  });
  it('a charge for another amount or another order is refunded, never activated', async () => {
    for (const bad of [charge({ amountMinor: 100 }), charge({ currency: 'PEN' }), charge({ orderId: '22222222-2222-4222-8222-222222222222' })]) {
      const { store, provider, deps } = setup();
      provider.answers.charge = { ok: true, value: bad };
      expect((await payLifetime(deps, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN })).status).toBe('refunded');
      expect(provider.calls).toEqual(['charge', 'refund']);
      expect(store.plusUsers.size).toBe(0);
    }
  });
  it('charged but the activation is refused (Plus obtained meanwhile) → refund; a failed refund is flagged needs_refund', async () => {
    const a = setup();
    a.store.activate = async () => { throw new (await import('../src/billing/store')).BillingRefused('already_plus'); };
    expect((await payLifetime(a.deps, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN })).status).toBe('refunded');
    expect(a.store.events).toContain(`fail:${ORDER}:activation_refused:already_plus:needs_refund`);
    const b = setup();
    b.store.activate = a.store.activate;
    b.provider.answers.refund = providerError('unavailable');
    expect(await payLifetime(b.deps, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN })).toEqual({ status: 'needs_refund', code: 'activation_refused:already_plus' });
  });
  it('bad token, other mode token, wrong flow, someone else\'s order → refused before any charge', async () => {
    const { provider, deps, store } = setup();
    expect((await payLifetime(deps, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: 'tkn_live_Z9y8X7w6V5u4T3s2' })).status).toBe('refused');
    expect((await payLifetime(deps, { orderId: ORDER, userId: '00000000-0000-4000-8000-00000000000b', email: 'a@b.pe', tokenRef: TKN })).status).toBe('refused');
    store.orders.get(ORDER)!.planCode = 'monthly';
    expect(await payLifetime(deps, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN })).toEqual({ status: 'refused', code: 'wrong_flow' });
    expect(provider.calls).toEqual([]);
  });
});

describe('Mensual/Anual: plan check → customer → card → subscription → activation with Culqi dates', () => {
  it('trial order → trialing with the provider dates; the customer is created once and reused', async () => {
    const { store, provider, deps } = setup(monthlyTrial);
    const r = await paySubscription({ ...deps, plans }, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN, customer });
    expect(r).toEqual({ status: 'trialing', orderId: ORDER });
    expect(provider.calls).toEqual(['getPlan', 'createCustomer', 'createCard', 'createSubscription']);
    expect(store.customers.get(USER)?.customerRef).toBe('cus_test_C1u2S3t4O5m6E7r8');
    const s = store.subs.get('sxn_test_S1u2B3s4C5r6I7p8')!;
    expect(s.status).toBe('trialing');
    expect(s.trialEnd?.getTime()).toBe(s.periodEnd?.getTime());
    // A later purchase reuses the saved customer.
    const second = setup({ ...monthlyTrial, id: '33333333-3333-4333-8333-333333333333' });
    second.store.customers.set(USER, { customerRef: 'cus_test_Saved000000000000', cardRef: null });
    await paySubscription({ ...second.deps, plans }, { orderId: '33333333-3333-4333-8333-333333333333', userId: USER, email: 'a@b.pe', tokenRef: TKN, customer });
    expect(second.provider.calls).not.toContain('createCustomer');
  });
  it('plan amount ≠ order amount (e.g. a US$ 9 plan for a US$ 4 order) → refused before anything is created', async () => {
    for (const p of [plan({ amountMinor: 900 }), plan({ currency: 'PEN' }), plan({ interval: 'year' }), plan({ intervalCount: 3 }),
      planNoTrial(), plan({ freeInitialCycles: { count: 7, unit: 1 }, initialCycles: 7 }), plan({ freeInitialCycles: { count: 14, unit: 3 } })]) {
      const { store, provider, deps } = setup(monthlyTrial);
      provider.answers.getPlan = { ok: true, value: p };
      expect(await paySubscription({ ...deps, plans }, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN, customer })).toEqual({ status: 'unavailable', code: 'price_config_mismatch' });
      expect(provider.calls).toEqual(['getPlan']);
      expect(store.orders.get(ORDER)?.status).toBe('failed');
    }
  });
  it('no configured plan for the order amount (the 2027 price) → refused without calling Culqi', async () => {
    const { provider, deps } = setup({ ...monthlyTrial, amountMinor: 900 });
    expect(await paySubscription({ ...deps, plans }, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN, customer })).toEqual({ status: 'unavailable', code: 'price_config_mismatch' });
    expect(provider.calls).toEqual([]);
  });
  it('planMatches: a no-trial order needs a plan without initial cycles; a trial order exactly its free days', () => {
    const order = { planCode: 'monthly' as const, amountMinor: 400, currency: 'USD' as const, trialDays: 0 };
    expect(planMatches(planNoTrial(), order)).toBe(true);
    expect(planMatches(plan(), order)).toBe(false);
    expect(planMatches(plan(), { ...order, trialDays: 14 })).toBe(true);
    expect(planMatches(plan(), { ...order, trialDays: 15 })).toBe(false);
    // A plan whose first cycle charges another amount (US$ 59 for a US$ 4 order), or gives free cycles of another
    // unit, is never "no trial".
    const odd = parsePlan({ ...JSON.parse(JSON.stringify(fx.plan_monthly)), initial_cycles: { count: 1, has_initial_charge: true, amount: 5900, interval_unit_time: 3 } })!;
    expect(planMatches(odd, order)).toBe(false);
    expect(planMatches(planNoTrial({ initialCycles: 2 }), order)).toBe(false);
    expect(planMatches(parsePlan(fx.plan_monthly)!, order)).toBe(true);
  });
  it('card declined → failed, no subscription; subscription create unknown → pending', async () => {
    const a = setup(monthlyTrial);
    a.provider.answers.createCard = providerError('declined', 'card_declined');
    expect(await paySubscription({ ...a.deps, plans }, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN, customer })).toEqual({ status: 'declined', code: 'card_declined' });
    expect(a.provider.calls).not.toContain('createSubscription');
    const b = setup(monthlyTrial);
    b.provider.answers.createSubscription = providerError('unknown', 'network');
    expect(await paySubscription({ ...b.deps, plans }, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN, customer })).toEqual({ status: 'pending', orderId: ORDER });
    expect(b.store.orders.get(ORDER)?.status).toBe('processing');
  });
  it('a subscription Culqi created that does not match what was accepted is cancelled at Culqi at once', async () => {
    // Trial: nothing was charged → refused (no "we will refund" message); the order keeps the subscription reference.
    const { store, provider, deps } = setup(monthlyTrial);
    provider.answers.createSubscription = { ok: true, value: subscription({ trialEnd: null, nextBillingDate: new Date(Date.now() + 30 * 86_400_000) }) };
    expect(await paySubscription({ ...deps, plans }, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN, customer })).toEqual({ status: 'refused', code: 'trial_mismatch' });
    expect(provider.calls).toContain('cancelSubscription');
    expect(store.plusUsers.size).toBe(0);
    expect(store.orders.get(ORDER)).toMatchObject({ status: 'failed', providerRef: 'sxn_test_S1u2B3s4C5r6I7p8' });
    // No trial: the plan charged at creation → needs_refund (refunded when its charge webhook arrives).
    const b = setup({ planCode: 'monthly', amountMinor: 400, trialDays: 0 });
    b.provider.answers.getPlan = { ok: true, value: planNoTrial() };
    b.provider.answers.createSubscription = { ok: true, value: subscription({ trialEnd: null, nextBillingDate: null }) };
    expect(await paySubscription({ ...b.deps, plans }, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN, customer })).toEqual({ status: 'needs_refund', code: 'bad_period' });
    expect(b.provider.calls).toContain('cancelSubscription');
    expect(b.store.orders.get(ORDER)).toMatchObject({ status: 'failed', providerRef: 'sxn_test_S1u2B3s4C5r6I7p8' });
  });
  it('an existing Culqi customer with the same email is reused only on an exact match', async () => {
    const a = setup(monthlyTrial);
    a.provider.answers.createCustomer = providerError('invalid', 'customer_exists');
    a.provider.answers.findCustomerByEmail = { ok: true, value: { id: 'cus_test_Found00000000000' } };
    expect((await paySubscription({ ...a.deps, plans }, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN, customer })).status).toBe('trialing');
    expect(a.store.customers.get(USER)?.customerRef).toBe('cus_test_Found00000000000');
    const b = setup(monthlyTrial);
    b.provider.answers.createCustomer = providerError('invalid', 'bad_address');
    expect(await paySubscription({ ...b.deps, plans }, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN, customer })).toEqual({ status: 'refused', code: 'customer_rejected' });
    expect(b.provider.calls).not.toContain('createCard');
  });
});

describe('Cancelar renovación', () => {
  it('Culqi first, then the record; Plus kept until the end of the paid period; idempotent', async () => {
    const { store, provider, deps } = setup(monthlyTrial);
    await paySubscription({ ...deps, plans }, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN, customer });
    const r = await cancelRenewal(deps, { userId: USER, subRef: 'sxn_test_S1u2B3s4C5r6I7p8' });
    expect(r.ok && r.until?.getTime()).toBe(store.subs.get('sxn_test_S1u2B3s4C5r6I7p8')!.trialEnd!.getTime());
    expect(store.subs.get('sxn_test_S1u2B3s4C5r6I7p8')!.cancel).toBe(true);
    // Already deleted at Culqi (a retry after a crash): recorded only when Culqi confirms it is gone (GET 404).
    provider.answers.cancelSubscription = providerError('not_found');
    provider.answers.getSubscription = providerError('not_found');
    expect((await cancelRenewal(deps, { userId: USER, subRef: 'sxn_test_S1u2B3s4C5r6I7p8' })).ok).toBe(true);
    expect(store.events.filter((e) => e.startsWith('cancel:'))).toHaveLength(1);
  });
  it('DELETE answers 404 but GET still returns the subscription (or fails) → not cancelled, nothing recorded', async () => {
    const { store, provider, deps } = setup(monthlyTrial);
    await paySubscription({ ...deps, plans }, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN, customer });
    provider.answers.cancelSubscription = providerError('not_found');
    expect(await cancelRenewal(deps, { userId: USER, subRef: 'sxn_test_S1u2B3s4C5r6I7p8' })).toEqual({ ok: false, code: 'still_at_provider' });
    provider.answers.getSubscription = providerError('unavailable', 'network');
    expect(await cancelRenewal(deps, { userId: USER, subRef: 'sxn_test_S1u2B3s4C5r6I7p8' })).toEqual({ ok: false, code: 'network' });
    expect(store.subs.get('sxn_test_S1u2B3s4C5r6I7p8')!.cancel).toBe(false);
    expect(store.events.filter((e) => e.startsWith('cancel:'))).toHaveLength(0);
  });
  it('if Culqi fails, nothing changes (the renewal is still on) and the caller says so', async () => {
    const { store, provider, deps } = setup(monthlyTrial);
    await paySubscription({ ...deps, plans }, { orderId: ORDER, userId: USER, email: 'a@b.pe', tokenRef: TKN, customer });
    provider.answers.cancelSubscription = providerError('unavailable', 'network');
    expect(await cancelRenewal(deps, { userId: USER, subRef: 'sxn_test_S1u2B3s4C5r6I7p8' })).toEqual({ ok: false, code: 'network' });
    expect(store.subs.get('sxn_test_S1u2B3s4C5r6I7p8')!.cancel).toBe(false);
    expect(await cancelRenewal(deps, { userId: USER, subRef: 'sxn_live_S1u2B3s4C5r6I7p8' })).toEqual({ ok: false, code: 'bad_subscription' });
  });
});
