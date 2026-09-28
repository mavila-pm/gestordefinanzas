import { describe, expect, it } from 'vitest';
import { buildPlan, type ExpectedIncome, type Obligation, type PlanInput } from '../src/engine/planning';
import { changeBill, comparePayoff, delayIncome, payDebt } from '../src/engine/scenarios';

const ob = (o: Partial<Obligation> & { id: string; name: string }): Obligation => ({
  source: 'obligation', kind: 'other', currency: 'PEN', amountMinor: 10000, amountStatus: 'confirmed', frequency: 'monthly', anchorMonth: null,
  dueDay: 10, dueDayMax: null, targetDay: null, since: '2026-01-01', ...o,
});
const salary: ExpectedIncome = { id: 'sal', name: 'Sueldo', currency: 'PEN', amountMinor: 400000, amountStatus: 'confirmed', frequency: 'monthly', dayOfMonth: 15, dayMax: null, secondDay: null, anchorDate: null };
// Today 1 Oct, S/ 2,000 on hand, salary on the 15th; card minimum S/ 500 on the 10th, rent S/ 1,200 on the 20th.
const input = (o: Partial<PlanInput> = {}): PlanInput => ({
  currency: 'PEN', today: '2026-10-01', base: { kind: 'balance', amountMinor: 200000, asOf: '2026-10-01T09:00:00-05:00', stale: false },
  obligations: [ob({ id: 'card', name: 'Tarjeta', kind: 'card', amountMinor: 50000, dueDay: 10 }), ob({ id: 'rent', name: 'Alquiler', kind: 'rent', amountMinor: 120000, dueDay: 20 })],
  settledObligations: new Map([['card', new Set(['2026-09'])], ['rent', new Set(['2026-09'])]]), incomes: [salary], settledIncomes: new Map([['sal', new Set(['2026-09'])]]),
  essentialsMonthlyMinor: 60000, cushionMinor: 0, ...o,
});

describe('what-if scenarios never write and explain the horizon', () => {
  it('base plan: until 14 Oct; card reserved, rent after the income', () => {
    const p = buildPlan(input());
    expect(p.until).toBe('2026-10-14');
    expect(p.lines.map((l) => l.label)).toEqual(['Tarjeta', 'Gastos básicos']);
    expect(p.freeMinor).toBe(200000 - 50000 - 28000);
  });
  it('income 7 days late: rent falls inside the horizon, more days of basics; the shortfall is named', () => {
    const r = delayIncome(input(), 7)!;
    expect(r.until).toBe('2026-10-21');
    expect(r.freeAfterMinor).toBe(200000 - 50000 - 120000 - 42000);
    expect(r.deltaMinor).toBe(-(120000 + 14000));
    expect(r.uncovered).toEqual([]);
    expect(delayIncome(input({ base: { kind: 'balance', amountMinor: 100000, asOf: '2026-10-01', stale: false } }), 7)!.uncovered).toEqual(['Alquiler']);
    expect(delayIncome(input(), 0)).toBeNull();
  });
  it('bill goes up: only a copy changes; unknown obligation id is refused', () => {
    const i = input();
    const r = changeBill(i, 'card', 65000)!;
    expect(r.deltaMinor).toBe(-15000);
    expect(i.obligations[0]!.amountMinor).toBe(50000); // input untouched
    expect(changeBill(i, 'nope', 1000)).toBeNull();
  });
  it('paying S/ 1,000 to the card now covers its S/ 500 planned payment (not a new expense): free drops S/ 500', () => {
    const r = payDebt(input(), { name: 'Tarjeta', balanceMinor: 300000, annualRateBp: 6000, obligationId: 'card' }, 100000)!;
    expect(r.deltaMinor).toBe(-50000);
    expect(r.debt).toEqual({ name: 'Tarjeta', balanceBeforeMinor: 300000, balanceAfterMinor: 200000, monthlyInterestSavedMinor: 5000 });
    // unknown rate: no invented saving; a payment above the balance is capped at the balance
    const r2 = payDebt(input(), { name: 'Préstamo', balanceMinor: 30000, annualRateBp: null, obligationId: null }, 100000)!;
    expect(r2.debt).toMatchObject({ balanceAfterMinor: 0, monthlyInterestSavedMinor: null });
    expect(r2.deltaMinor).toBe(-30000);
  });
});

describe('debt payoff comparison', () => {
  const debts = [
    { id: 'v', name: 'Visa', balanceMinor: 300000, annualRateBp: 6000, minimumMinor: 15000 },
    { id: 'p', name: 'Préstamo', balanceMinor: 80000, annualRateBp: 1800, minimumMinor: 10000 },
  ];
  it('avalanche pays least interest; snowball clears the small one first; hybrid explains its order', () => {
    const c = comparePayoff(debts, 60000);
    expect(c.available).toBe(true);
    const [av, sn, hy] = c.plans;
    expect(av!.order).toEqual(['Visa', 'Préstamo']);
    expect(sn!.order).toEqual(['Préstamo', 'Visa']);
    expect(av!.interestMinor!).toBeLessThanOrEqual(sn!.interestMinor!);
    expect(av!.months).toBeGreaterThan(0);
    expect(hy!.why).toContain('un mes');
  });
  it('a missing rate means no ranking (nothing invented), and says which rate is missing', () => {
    const c = comparePayoff([...debts, { id: 'f', name: 'Familiar', balanceMinor: 50000, annualRateBp: null, minimumMinor: null }], 60000);
    expect(c.available).toBe(false);
    expect(c.note).toBe('Falta la tasa de Familiar.');
    expect(c.plans.map((p) => [p.strategy, p.months])).toEqual([['snowball', null]]);
  });
  it('a budget below the interest never pays off and says so', () => {
    const c = comparePayoff([{ id: 'v', name: 'Visa', balanceMinor: 1000000, annualRateBp: 12000, minimumMinor: null }], 5000);
    expect(c.plans.every((p) => p.months === null)).toBe(true);
    expect(c.note).toContain('no baja');
  });
});
