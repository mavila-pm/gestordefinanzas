import { beforeEach, describe, expect, it, vi } from 'vitest';
import { debtPaymentEffect } from '../src/engine/commitments';

/** "Registrar pago" of a debt (ADR-0017): an abono lowers the balance but does not settle the month's installment. */
let debt: Record<string, unknown> | null = null;
const updates: Array<Record<string, unknown>> = [];
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q; q.eq = () => q;
      q.maybeSingle = async () => ({ data: debt, error: null });
      q.update = (row: Record<string, unknown>) => { updates.push(row); return { eq: () => ({ eq: () => ({ select: async () => ({ data: [{ id: 'd1' }], error: null }) }) }) }; };
      return q;
    },
  }),
  authUser: async () => ({ id: 'u1', email: null }),
}));
const UUID = '3f1c0b5e-6c8e-4a43-9d2a-1b2c3d4e5f60';
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const base = { balanceMinor: 300000, installmentMinor: 50000, installmentsPaid: 2, installmentsTotal: 12 };

describe('debtPaymentEffect (pure)', () => {
  it('an abono below the installment lowers the balance and leaves the installment pending', () => {
    expect(debtPaymentEffect(base, 20000)).toEqual({ ok: true, balanceMinor: 280000, settlesInstallment: false, installmentsPaid: 2 });
  });
  it('the full installment (or more) settles it, as before', () => {
    expect(debtPaymentEffect(base, 50000)).toEqual({ ok: true, balanceMinor: 250000, settlesInstallment: true, installmentsPaid: 3 });
    expect(debtPaymentEffect(base, 120000)).toEqual({ ok: true, balanceMinor: 180000, settlesInstallment: true, installmentsPaid: 3 });
    // The last installment is the balance when it is smaller; the counter never passes the total.
    expect(debtPaymentEffect({ ...base, balanceMinor: 30000, installmentsPaid: 12 }, 30000)).toEqual({ ok: true, balanceMinor: 0, settlesInstallment: true, installmentsPaid: 12 });
  });
  it('a payment above the balance is refused (never silently capped)', () => {
    expect(debtPaymentEffect(base, 300001)).toEqual({ ok: false, error: 'over_balance', balanceMinor: 300000 });
    expect(debtPaymentEffect(base, 0)).toMatchObject({ ok: false, error: 'invalid_amount' });
  });
  it('an unknown installment is never assumed paid', () => {
    expect(debtPaymentEffect({ ...base, installmentMinor: null }, 50000)).toEqual({ ok: true, balanceMinor: 250000, settlesInstallment: false, installmentsPaid: 2 });
  });
});

describe('debtPaymentAction', () => {
  beforeEach(() => { updates.length = 0; debt = { currency: 'PEN', balance_minor: 300000, installment_minor: 50000, installments_paid: 2, installments_total: 12 }; });
  it('an abono updates only the balance: no installment counted, no last_payment_on (the plan keeps the installment)', async () => {
    const { debtPaymentAction } = await import('../app/app/actions');
    expect((await debtPaymentAction({}, form({ id: UUID, amount: '200' }))).message).toBe('Abono registrado. La cuota de este mes sigue pendiente.');
    expect(updates).toEqual([{ balance_minor: 280000 }]);
  });
  it('the installment settles the month', async () => {
    const { debtPaymentAction } = await import('../app/app/actions');
    expect((await debtPaymentAction({}, form({ id: UUID, amount: '500' }))).message).toBe('Pago registrado. Bajó el saldo de la deuda; no se creó otro gasto.');
    expect(updates[0]).toMatchObject({ balance_minor: 250000, installments_paid: 3, last_payment_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });
  it('above the balance: refused with the balance, 0 rows updated', async () => {
    const { debtPaymentAction } = await import('../app/app/actions');
    expect((await debtPaymentAction({}, form({ id: UUID, amount: '3500' }))).error).toBe('El pago supera el saldo (S/ 3,000.00).');
    expect(updates).toHaveLength(0);
  });
});
