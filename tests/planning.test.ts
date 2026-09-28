import { describe, expect, it } from 'vitest';
import {
  buildPlan, compareDebtStrategies, detectVariations, nextIncome, nextOccurrence, occurrencesBetween, reminderIntents,
  simulatePurchase, suggestMatches, type ExpectedIncome, type Obligation, type PlanInput,
} from '../src/engine/planning';
import { monthlySummary } from '../src/engine/monthly-summary';

const ob = (o: Partial<Obligation> & { id: string; name: string }): Obligation => ({
  source: 'obligation', kind: 'other', currency: 'PEN', amountMinor: 10000, amountStatus: 'confirmed', frequency: 'monthly', anchorMonth: null,
  dueDay: 10, dueDayMax: null, targetDay: null, since: '2026-01-01', ...o,
});
const salary: ExpectedIncome = { id: 'sal', name: 'Sueldo', currency: 'PEN', amountMinor: 400000, amountStatus: 'estimated', frequency: 'monthly', dayOfMonth: 15, dayMax: null, secondDay: null, anchorDate: null };
const NONE = new Map<string, Set<string>>();
// Demo scenario: today 2026-09-28, balance S/ 5,000, next income 15 Oct.
const demo = (o: Partial<PlanInput> = {}): PlanInput => ({
  currency: 'PEN', today: '2026-09-28',
  base: { kind: 'balance', amountMinor: 500000, asOf: '2026-09-28T09:00:00-05:00', stale: false },
  obligations: [
    ob({ id: 'car', name: 'Carro', kind: 'car', amountMinor: 95000, dueDay: 9, dueDayMax: 10, targetDay: 7 }),
    ob({ id: 'card', name: 'Tarjeta', kind: 'card', amountMinor: 50000, dueDay: 10 }),
    ob({ id: 'net', name: 'Internet', kind: 'internet', amountMinor: null, amountStatus: 'unknown', dueDay: 13 }),
    ob({ id: 'cel', name: 'Celular', kind: 'phone', amountMinor: 10000, dueDay: 5 }),
    ob({ id: 'rent', name: 'Alquiler', kind: 'rent', amountMinor: 150000, dueDay: 20 }), // after the next income
  ],
  settledObligations: new Map([['car', new Set(['2026-09'])], ['card', new Set(['2026-09'])], ['net', new Set(['2026-09'])], ['cel', new Set(['2026-09'])], ['rent', new Set(['2026-09'])]]),
  incomes: [salary], settledIncomes: new Map([['sal', new Set(['2026-09'])]]),
  essentialsMonthlyMinor: 80000, cushionMinor: 40000, ...o,
});

describe('obligations: template vs occurrence', () => {
  it('a monthly obligation yields one occurrence per month; the next one after a payment is prepared (no transaction created)', () => {
    const car = ob({ id: 'car', name: 'Carro', amountMinor: 95000 });
    expect(occurrencesBetween(car, '2026-10-01', '2026-12-31').map((x) => x.period)).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(nextOccurrence(car, '2026-10-02', new Set(['2026-10']))?.period).toBe('2026-11');
  });
  it('unknown date stays unknown; a 9-10 window is kept as a window, never turned into 10', () => {
    const [u] = occurrencesBetween(ob({ id: 'x', name: 'X', dueDay: null }), '2026-10-01', '2026-10-31');
    expect(u).toMatchObject({ dueDate: null, dateStatus: 'unknown' });
    const [w] = occurrencesBetween(ob({ id: 'c', name: 'Carro', dueDay: 9, dueDayMax: 10 }), '2026-10-01', '2026-10-31');
    expect(w).toMatchObject({ dueDate: '2026-10-09', dueDateMax: '2026-10-10', dateStatus: 'window' });
  });
  it('unknown amount stays null, never 0', () => {
    const [x] = occurrencesBetween(ob({ id: 'n', name: 'Internet', amountMinor: null, amountStatus: 'unknown' }), '2026-10-01', '2026-10-31');
    expect(x!.amountMinor).toBeNull();
  });
  it('a planned occurrence is not a realized expense (the financial engine only sees transactions)', () => {
    expect(monthlySummary([], '2026-10', 'PEN').expensesMinor).toBe(0);
  });
  it('yearly obligations occur only in their anchor month', () => {
    expect(occurrencesBetween(ob({ id: 'ins', name: 'Seguro', frequency: 'yearly', anchorMonth: 3 }), '2026-01-01', '2026-12-31').map((x) => x.period)).toEqual(['2026-03']);
  });
});

describe('incomes', () => {
  it('next expected income across several payers; received periods skipped; never added to money', () => {
    const freelance: ExpectedIncome = { ...salary, id: 'fr', name: 'Freelance', frequency: 'biweekly', dayOfMonth: null, anchorDate: '2026-09-04' };
    expect(nextIncome([salary, freelance], 'PEN', '2026-09-28', NONE)?.date).toBe('2026-10-02');
    expect(nextIncome([salary], 'PEN', '2026-09-28', new Map([['sal', new Set(['2026-10'])]]))?.date).toBe('2026-11-15');
    const p = buildPlan(demo());
    expect(p.base).toEqual(demo().base); // the expected S/ 4,000 is not in the base
  });
  it('an income in another currency never closes a PEN horizon', () => {
    expect(nextIncome([{ ...salary, currency: 'USD' }], 'PEN', '2026-09-28', NONE)).toBeNull();
  });
});

describe('Dinero libre (safe-to-spend): today -> next income', () => {
  it('demo: reserves only what falls before 15 Oct, once each; lines explain the total', () => {
    const p = buildPlan(demo());
    expect(p.nextIncome?.date).toBe('2026-10-15');
    expect(p.until).toBe('2026-10-14');
    const byLabel = Object.fromEntries(p.lines.map((l) => [l.label, l.amountMinor]));
    expect(byLabel).toMatchObject({ Carro: 95000, Tarjeta: 50000, Internet: null, Celular: 10000, 'Gastos básicos': Math.round(80000 * 17 / 30 / 100) * 100, Colchón: 40000 });
    expect(byLabel).not.toHaveProperty('Alquiler'); // due 20 Oct: after the next income
    expect(p.lines.filter((l) => l.kind === 'essentials')).toHaveLength(1);
    expect(p.reservedMinor).toBe(p.lines.reduce((s, l) => s + (l.amountMinor ?? 0), 0));
    expect(p.freeMinor).toBe(500000 - p.reservedMinor);
  });
  it('partial when data is missing: unknown amount and date window are listed, never invented', () => {
    const p = buildPlan(demo());
    expect(p.status).toBe('partial');
    expect(p.missing.map((m) => m.text)).toEqual(expect.arrayContaining(['Falta el monto de Internet.', 'Confirma si Carro vence el 9 o el 10.']));
  });
  it('confirmed when everything is known', () => {
    const p = buildPlan(demo({ obligations: [ob({ id: 'card', name: 'Tarjeta', amountMinor: 50000, dueDay: 10 })], settledObligations: new Map([['card', new Set(['2026-09'])]]) }));
    expect(p.status).toBe('confirmed');
  });
  it('incomplete (no free amount) without a balance or without a next income', () => {
    expect(buildPlan(demo({ base: null }))).toMatchObject({ status: 'incomplete', freeMinor: null });
    expect(buildPlan(demo({ incomes: [] }))).toMatchObject({ status: 'incomplete', freeMinor: null, until: null });
  });
  it('a paid occurrence is not reserved again (real payment settles it: no double counting)', () => {
    const settled = new Map(demo().settledObligations); settled.set('card', new Set(['2026-09', '2026-10']));
    expect(buildPlan(demo({ settledObligations: settled })).lines.some((l) => l.label === 'Tarjeta')).toBe(false);
  });
  it('overdue unpaid occurrences come first', () => {
    const settled = new Map(demo().settledObligations); settled.set('card', new Set());
    const p = buildPlan(demo({ settledObligations: settled }));
    expect(p.lines[0]).toMatchObject({ kind: 'overdue', label: 'Tarjeta' });
  });
  it('debt minimum payments are included; infrequent obligations get a proportional reserve (planned, not separated)', () => {
    const p = buildPlan(demo({ obligations: [
      ob({ id: 'loan', name: 'Préstamo', source: 'debt', kind: 'loan', amountMinor: 30000, dueDay: 12 }),
      ob({ id: 'ins', name: 'Seguro', frequency: 'yearly', anchorMonth: 3, amountMinor: 120000, dueDay: 1 }),
    ], settledObligations: new Map([['loan', new Set(['2026-09'])]]) }));
    expect(p.lines.filter((l) => l.label === 'Préstamo')).toEqual([expect.objectContaining({ kind: 'debt', amountMinor: 30000, date: '2026-10-12' })]);
    const r = p.lines.find((l) => l.kind === 'reserve')!;
    expect(r.label).toBe('Para Seguro');
    expect(r.amountMinor).toBe(Math.round(120000 * 17 / (12 * 30.4375) / 100) * 100);
  });
  it('PEN and USD are separate plans', () => {
    const p = buildPlan(demo({ obligations: [ob({ id: 'u', name: 'Netflix', currency: 'USD', amountMinor: 1500 })] }));
    expect(p.lines.some((l) => l.label === 'Netflix')).toBe(false);
  });
  it('income distribution: from the day money came in to the following income', () => {
    const p = buildPlan(demo({ base: { kind: 'income', amountMinor: 400000, date: '2026-09-15' }, settledIncomes: new Map([['sal', new Set(['2026-09'])]]) }));
    expect(p.from).toBe('2026-09-15');
    expect(p.nextIncome?.date).toBe('2026-10-15');
    expect(p.freeMinor).toBe(400000 - p.reservedMinor);
  });
  it('the income window closes the horizon conservatively and says so', () => {
    const p = buildPlan(demo({ incomes: [{ ...salary, dayOfMonth: 15, dayMax: 16 }] }));
    expect(p.until).toBe('2026-10-15');
    expect(p.missing.some((m) => m.code === 'income_window')).toBe(true);
  });
  it('stale balance lowers the status to partial', () => {
    expect(buildPlan(demo({ base: { kind: 'balance', amountMinor: 500000, asOf: '2026-09-20T09:00:00-05:00', stale: true } })).missing[0]?.code).toBe('balance_stale');
  });
});

describe('what-if, variations, matching, debts, reminders', () => {
  it('simulatePurchase is pure and shows a shortfall', () => {
    const p = buildPlan(demo());
    const before = JSON.stringify(p);
    const s = simulatePurchase(p, (p.freeMinor ?? 0) + 20000)!;
    expect(s).toMatchObject({ covered: false, shortfallMinor: 20000, estimated: true });
    expect(simulatePurchase(p, 10000)!.covered).toBe(true);
    expect(JSON.stringify(p)).toBe(before);
    expect(simulatePurchase({ freeMinor: null, status: 'incomplete' }, 100)).toBeNull();
  });
  it('S/ 129 -> S/ 160 is reported as +S/ 31 (and silenced once acknowledged)', () => {
    const net = ob({ id: 'net', name: 'Internet', amountMinor: 12900 });
    expect(detectVariations([net], [{ obligationId: 'net', period: '2026-09', actualMinor: 16000, acknowledged: false }])[0]).toMatchObject({ deltaMinor: 3100 });
    expect(detectVariations([net], [{ obligationId: 'net', period: '2026-09', actualMinor: 16000, acknowledged: true }])).toEqual([]);
  });
  it('matching suggests (never links) a real payment for the right period; linked transactions are not reused', () => {
    const car = ob({ id: 'car', name: 'Cuota carro', amountMinor: 95000, dueDay: 9, dueDayMax: 10 });
    const tx = { id: 't1', occurredOn: '2026-10-08', amountMinor: 95000, currency: 'PEN' as const, merchant: 'PAGO CUOTA CARRO' };
    expect(suggestMatches([car], [tx], NONE, new Set())).toEqual([{ obligationId: 'car', name: 'Cuota carro', period: '2026-10', transactionId: 't1', confidence: 'high' }]);
    expect(suggestMatches([car], [tx], NONE, new Set(['t1']))).toEqual([]);
    expect(suggestMatches([car], [tx], new Map([['car', new Set(['2026-10'])]]), new Set())).toEqual([]);
    expect(suggestMatches([car], [{ ...tx, amountMinor: 30000, merchant: 'WONG' }], NONE, new Set())).toEqual([]);
  });
  it('avalanche needs every rate; snowball orders by balance; neither is called "the best"', () => {
    const d = [
      { id: 'a', name: 'Tarjeta', currency: 'PEN' as const, balanceMinor: 300000, annualRateBp: 6000 },
      { id: 'b', name: 'Préstamo', currency: 'PEN' as const, balanceMinor: 100000, annualRateBp: 1500 },
    ];
    expect(compareDebtStrategies(d)).toEqual({ avalanche: { available: true, order: ['Tarjeta', 'Préstamo'], missingRate: [] }, snowball: { order: ['Préstamo', 'Tarjeta'] } });
    expect(compareDebtStrategies([d[0]!, { ...d[1]!, annualRateBp: null }]).avalanche).toEqual({ available: false, order: [], missingRate: ['Préstamo'] });
  });
  it('at most one main reminder per obligation, a second only right before it is due', () => {
    const r = reminderIntents(buildPlan(demo()), '2026-09-28');
    const car = r.filter((x) => x.obligationId === 'car');
    expect(car).toEqual([{ obligationId: 'car', name: 'Carro', on: '2026-10-05', kind: 'main' }]);
    expect(reminderIntents(buildPlan(demo()), '2026-10-07').filter((x) => x.obligationId === 'car' && x.kind === 'second')).toHaveLength(1);
  });
});
