import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeProvider, MemoryStore, ORDER, USER } from './billing-fakes';

/**
 * Billing server actions (ADR-0018) with Supabase and Culqi stubbed: the subscription reference always comes from the
 * person's own row, never from the form; a Culqi failure changes nothing; with Culqi off nothing can be bought.
 */
const rows: Record<string, Record<string, unknown> | null> = {};
const rpc = vi.fn();
const query = (table: string) => {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) q[m] = () => q;
  q.maybeSingle = async () => ({ data: rows[table] ?? null });
  return q;
};
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ from: (t: string) => query(t), rpc }),
  authUser: async () => ({ id: USER, email: 'ana@example.test' }),
}));
const service = { provider: new FakeProvider(), store: new MemoryStore() };
let serviceOn = true;
let checkout: { ok: boolean; plans?: Record<string, string> } = { ok: false };
vi.mock('../lib/culqi', () => ({
  culqiServiceDeps: () => (serviceOn ? { ...service, log: () => {} } : null),
  culqiCheckout: () => (checkout.ok ? { ok: true, keys: { livemode: false, publicKey: 'pk_test_abcdef0123456789' }, plans: checkout.plans ?? {}, provider: service.provider, store: service.store } : { ok: false, reason: 'not_enabled' }),
}));
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe('cancelRenewalAction', () => {
  beforeEach(() => {
    serviceOn = true;
    service.provider = new FakeProvider();
    service.store = new MemoryStore();
    service.store.subs.set('sxn_test_S1u2B3s4C5r6I7p8', { userId: USER, status: 'active', cancel: false, periodEnd: new Date('2026-11-22T15:00:00Z'), trialEnd: null, amountMinor: 400, currency: 'USD', plan: 'monthly' });
    rows.subscriptions = { provider: 'culqi', provider_ref: 'sxn_test_S1u2B3s4C5r6I7p8', billing_plan: 'monthly', cancel_at_period_end: false, livemode: false };
  });
  it('cancels at Culqi with the reference from the person\'s row, then keeps Plus until the period end', async () => {
    const { cancelRenewalAction } = await import('../app/app/ajustes/plan/actions');
    const r = await cancelRenewalAction({}, form({ confirm: 'yes', subRef: 'sxn_test_SomeoneElse0000' }));
    expect(r).toEqual({ message: 'Listo. Conservas Plus hasta el 22 de noviembre de 2026. No se hará ningún otro cobro.' });
    expect(service.provider.calls).toEqual(['cancelSubscription']);
    expect(service.store.subs.get('sxn_test_S1u2B3s4C5r6I7p8')?.cancel).toBe(true);
  });
  it('needs the explicit confirmation; nothing to cancel for Vitalicio, Free or an already cancelled renewal', async () => {
    const { cancelRenewalAction } = await import('../app/app/ajustes/plan/actions');
    expect((await cancelRenewalAction({}, form({}))).error).toMatch(/Confirma/);
    rows.subscriptions = { provider: 'culqi', provider_ref: 'chr_test_A1b2C3d4E5f6G7h8', billing_plan: 'lifetime', cancel_at_period_end: false, livemode: false };
    expect((await cancelRenewalAction({}, form({ confirm: 'yes' }))).error).toMatch(/No tienes una renovación/);
    rows.subscriptions = null;
    expect((await cancelRenewalAction({}, form({ confirm: 'yes' }))).error).toMatch(/No tienes una renovación/);
    rows.subscriptions = { provider: 'culqi', provider_ref: 'sxn_test_S1u2B3s4C5r6I7p8', billing_plan: 'monthly', cancel_at_period_end: true, livemode: false };
    expect((await cancelRenewalAction({}, form({ confirm: 'yes' }))).message).toMatch(/ya estaba cancelada/);
    expect(service.provider.calls).toEqual([]);
  });
  it('Culqi down, keys missing or of the other mode → an honest error and the renewal stays on', async () => {
    const { cancelRenewalAction } = await import('../app/app/ajustes/plan/actions');
    service.provider.answers.cancelSubscription = { ok: false, kind: 'unavailable', code: 'network', status: null };
    expect((await cancelRenewalAction({}, form({ confirm: 'yes' }))).error).toMatch(/Tu plan no cambió/);
    rows.subscriptions = { ...rows.subscriptions!, livemode: true };
    expect((await cancelRenewalAction({}, form({ confirm: 'yes' }))).error).toMatch(/Tu plan no cambió/);
    serviceOn = false;
    expect((await cancelRenewalAction({}, form({ confirm: 'yes' }))).error).toMatch(/Tu plan no cambió/);
    expect(service.store.subs.get('sxn_test_S1u2B3s4C5r6I7p8')?.cancel).toBe(false);
  });
});

describe('card checkout actions', () => {
  beforeEach(() => { rpc.mockReset(); checkout = { ok: false }; rows.demo_access = null; rows.subscriptions = null; rows.plan_config = null; });
  it('with Culqi off nobody can start a card payment and no order is created', async () => {
    const { startCardOrderAction, payWithCardAction } = await import('../app/app/planes/actions');
    expect(await startCardOrderAction({ plan: 'lifetime', amount: 19800, terms: true })).toEqual({ ok: false, error: 'Los pagos con tarjeta se habilitarán muy pronto. No se hizo ningún cargo.' });
    expect(await payWithCardAction({ orderId: ORDER, tokenId: 'tkn_test_Z9y8X7w6V5u4T3s2' })).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('terms, plan, address and the token shape are checked before anything else', async () => {
    const { startCardOrderAction, payWithCardAction } = await import('../app/app/planes/actions');
    expect((await startCardOrderAction({ plan: 'lifetime', amount: 19800, terms: 'on' })).ok).toBe(false);
    expect((await startCardOrderAction({ plan: 'weekly', amount: 19800, terms: true })).ok).toBe(false);
    expect(await startCardOrderAction({ plan: 'monthly', amount: 400, terms: true, address: '', city: 'Lima' })).toMatchObject({ ok: false, error: expect.stringMatching(/dirección/) });
    expect(await payWithCardAction({ orderId: ORDER, tokenId: '4111111111111111' })).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('sandbox for a demo account: the order is created at the server price; a Mensual price without its Culqi plan is refused', async () => {
    vi.stubEnv('CULQI_ENABLED', 'true');
    checkout = { ok: true, plans: { 'monthly:400:trial': 'pln_test_M1o2N3t4H5l6Y7t8' } };
    rows.demo_access = { user_id: USER };
    rows.billing_orders = { amount_minor: 19800, currency: 'USD', id: ORDER, plan_code: 'lifetime' };
    rpc.mockResolvedValue({ data: ORDER, error: null });
    const { startCardOrderAction } = await import('../app/app/planes/actions');
    expect(await startCardOrderAction({ plan: 'lifetime', amount: 19800, terms: true })).toEqual({ ok: true, orderId: ORDER, amountMinor: 19800, currency: 'USD' });
    expect(rpc).toHaveBeenCalledWith('billing_create_order', { p_plan: 'lifetime', p_expected_minor: 19800 });
    rpc.mockClear();
    expect(await startCardOrderAction({ plan: 'monthly', amount: 900, terms: true, address: 'Av. 1', city: 'Lima' })).toMatchObject({ ok: false, error: expect.stringMatching(/no está disponible/) });
    expect(rpc).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
