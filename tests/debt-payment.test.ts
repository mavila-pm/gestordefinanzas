import { beforeEach, describe, expect, it, vi } from 'vitest';
import { debtInstallmentDue, debtMonths } from '../src/engine/commitments';
import { buildPlan, type Obligation, type PlanInput } from '../src/engine/planning';

/**
 * "Registrar pago" of a debt (ADR-0017 §D): each payment goes to a ledger through record_debt_payment (migration 052,
 * tested in tests/db/debt-payments.test.ts); the month's installment is settled when the month's payments add up to
 * what was due, and the plan reserves only what is left. Supabase is stubbed here.
 */
let rpc: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let debt: Record<string, unknown> | null = null;
const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return rpc; },
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q; q.eq = () => q;
      q.maybeSingle = async () => ({ data: debt, error: null });
      q.update = () => { throw new Error('the debt is written only by record_debt_payment'); };
      return q;
    },
  }),
  authUser: async () => ({ id: 'u1', email: null }),
}));
const UUID = '3f1c0b5e-6c8e-4a43-9d2a-1b2c3d4e5f60';
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const result = (o: Record<string, unknown>) => ({ data: { replay: false, currency: 'PEN', balance_minor: 0, settles: false, period_settled: false, due_minor: 50000, period_paid_minor: 0, installment_known: true, ...o }, error: null });

describe('the debt installment rule (pure, same as record_debt_payment)', () => {
  it('review M2: S/ 300 then S/ 200 on a S/ 500 installment, balance S/ 5,000 → S/ 200 left, then 0', () => {
    expect(debtInstallmentDue(50000, 470000, 30000)).toEqual({ dueMinor: 50000, leftMinor: 20000 });
    expect(debtInstallmentDue(50000, 450000, 50000)).toEqual({ dueMinor: 50000, leftMinor: 0 });
  });
  it('the balance at the start of the month caps it; an unknown installment stays unknown', () => {
    expect(debtInstallmentDue(50000, 10000, 20000)).toEqual({ dueMinor: 30000, leftMinor: 10000 });
    expect(debtInstallmentDue(null, 10000, 20000)).toEqual({ dueMinor: null, leftMinor: null });
  });
  it('ledger → settled months and open abonos; a settled month is never subtracted again', () => {
    const { settled, abonos } = debtMonths([
      { debtId: 'd', period: '2026-10', amountMinor: 30000, settles: false },
      { debtId: 'd', period: '2026-09', amountMinor: 30000, settles: false },
      { debtId: 'd', period: '2026-09', amountMinor: 20000, settles: true },
      { debtId: 'e', period: '2026-10', amountMinor: 10000, settles: false },
    ], [{ debtId: 'e', lastPaymentOn: '2026-10-02' }]);
    expect(settled).toEqual(new Map([['e', new Set(['2026-10'])], ['d', new Set(['2026-09'])]]));
    expect(abonos).toEqual(new Map([['d', new Map([['2026-10', 30000]])]]));
  });
  it('the plan reserves only what is left of the installment (before: the full S/ 500, free understated by S/ 300)', () => {
    const loan: Obligation = { id: 'd', source: 'debt', name: 'Préstamo', kind: 'loan', currency: 'PEN', amountMinor: 50000, amountStatus: 'confirmed',
      frequency: 'monthly', anchorMonth: null, dueDay: 12, dueDayMax: null, targetDay: null, since: '2026-10-01' };
    const input: PlanInput = { currency: 'PEN', today: '2026-10-01', base: { kind: 'balance', amountMinor: 500000, asOf: '2026-10-01T09:00:00-05:00', stale: false },
      obligations: [loan], settledObligations: new Map(), settledIncomes: new Map(), essentialsMonthlyMinor: 0, cushionMinor: 0,
      incomes: [{ id: 'sal', name: 'Sueldo', currency: 'PEN', amountMinor: 400000, amountStatus: 'confirmed', frequency: 'monthly', dayOfMonth: 15, dayMax: null, secondDay: null, anchorDate: null }] };
    const p = buildPlan({ ...input, partialPaid: debtMonths([{ debtId: 'd', period: '2026-10', amountMinor: 30000, settles: false }]).abonos });
    expect(p.lines.find((l) => l.obligationId === 'd')).toMatchObject({ kind: 'debt', amountMinor: 20000, paidMinor: 30000, plannedMinor: 50000 });
    expect(p.freeMinor).toBe(480000);
    // The second abono completes it: the month is settled and nothing is reserved.
    const both = debtMonths([{ debtId: 'd', period: '2026-10', amountMinor: 30000, settles: false }, { debtId: 'd', period: '2026-10', amountMinor: 20000, settles: true }]);
    expect(buildPlan({ ...input, settledObligations: both.settled, partialPaid: both.abonos }).lines.filter((l) => l.obligationId === 'd')).toEqual([]);
  });
});

describe('debtPaymentAction', () => {
  beforeEach(() => { calls.length = 0; rpc = { data: null, error: null }; debt = { currency: 'PEN', balance_minor: 300000 }; });
  it('one call to record_debt_payment with the parsed amount and the form\'s client_ref (a retry is the same submission)', async () => {
    const { debtPaymentAction } = await import('../app/app/actions');
    rpc = result({ settles: false, due_minor: 50000, period_paid_minor: 30000 });
    expect((await debtPaymentAction({}, form({ id: UUID, amount: '300', client_ref: 'ref-form-000001' }))).message).toBe('Abono registrado. De la cuota de este mes faltan S/ 200.00.');
    expect(calls).toEqual([{ fn: 'record_debt_payment', args: { p_debt_id: UUID, p_amount_minor: 30000, p_client_ref: 'ref-form-000001' } }]);
  });
  it('the abono that completes the installment, a debt without installment, and a month already settled', async () => {
    const { debtPaymentAction } = await import('../app/app/actions');
    const done = 'Pago registrado. Bajó el saldo de la deuda; no se creó otro gasto.';
    rpc = result({ settles: true, period_settled: true, period_paid_minor: 50000 });
    expect((await debtPaymentAction({}, form({ id: UUID, amount: '200' }))).message).toBe(done);
    rpc = result({ due_minor: null, installment_known: false });
    expect((await debtPaymentAction({}, form({ id: UUID, amount: '200' }))).message).toBe(done);
    rpc = result({ period_settled: true, due_minor: null });
    expect((await debtPaymentAction({}, form({ id: UUID, amount: '200' }))).message).toBe(done);
  });
  it('above the balance: refused with the balance and what to do; bad input never reaches the database', async () => {
    const { debtPaymentAction } = await import('../app/app/actions');
    rpc = { data: null, error: { message: 'over_balance' } };
    expect((await debtPaymentAction({}, form({ id: UUID, amount: '3500' }))).error).toBe('El pago supera el saldo registrado (S/ 3,000.00). Revisa el monto.');
    calls.length = 0;
    expect((await debtPaymentAction({}, form({ id: UUID, amount: 'abc' }))).error).toBeTruthy();
    expect((await debtPaymentAction({}, form({ id: 'x', amount: '100' }))).error).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});
