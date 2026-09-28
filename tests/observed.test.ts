import { describe, expect, it } from 'vitest';
import type { ExpectedIncome, Obligation } from '../src/engine/planning';
import {
  essentialSpendByMonth, essentialsSuggestion, isSuppressed, observedAmountsForUnknown, suggestIncomeMatches, timeline,
} from '../src/engine/observed';
import { validPatches, visionWrites } from '../src/ai/apply';

const inc = (o: Partial<ExpectedIncome> = {}): ExpectedIncome => ({
  id: 'sueldo', name: 'Sueldo', currency: 'PEN', amountMinor: 570000, amountStatus: 'confirmed', frequency: 'monthly',
  dayOfMonth: 5, dayMax: null, secondDay: null, anchorDate: null, ...o,
});
const obBase = (o: Partial<Obligation> & { id: string; name: string }): Obligation => ({
  source: 'obligation', kind: 'other', currency: 'PEN', amountMinor: 10000, amountStatus: 'confirmed', frequency: 'monthly',
  anchorMonth: null, dueDay: 10, dueDayMax: null, targetDay: null, since: '2026-01-01', ...o,
});
const dep = (id: string, occurredOn: string, amountMinor: number, currency: 'PEN' | 'USD' = 'PEN') => ({ id, occurredOn, amountMinor, currency, merchant: null });
const none = new Map<string, Set<string>>();

describe('received income ↔ expected income (suggestion only)', () => {
  it('a deposit near the expected day with the expected amount is that month\'s salary (high)', () => {
    const [m] = suggestIncomeMatches([inc()], [dep('t1', '2026-10-05', 570000)], none, new Set());
    expect(m).toMatchObject({ incomeId: 'sueldo', period: '2026-10', transactionId: 't1', confidence: 'high', receivedMinor: 570000 });
  });
  it('a different amount or a far date is not assumed to be the salary', () => {
    expect(suggestIncomeMatches([inc()], [dep('t1', '2026-10-05', 300000)], none, new Set())).toEqual([]);
    expect(suggestIncomeMatches([inc()], [dep('t1', '2026-10-20', 570000)], none, new Set())).toEqual([]);
  });
  it('PEN deposit never settles a USD income; linked deposits and settled periods are skipped', () => {
    expect(suggestIncomeMatches([inc({ currency: 'USD' })], [dep('t1', '2026-10-05', 570000)], none, new Set())).toEqual([]);
    expect(suggestIncomeMatches([inc()], [dep('t1', '2026-10-05', 570000)], none, new Set(['t1']))).toEqual([]);
    expect(suggestIncomeMatches([inc()], [dep('t1', '2026-10-05', 570000)], new Map([['sueldo', new Set(['2026-10'])]]), new Set())).toEqual([]);
  });
  it('unknown expected amount: date-only match stays medium; estimated amount tolerates ±25 %', () => {
    expect(suggestIncomeMatches([inc({ amountMinor: null, amountStatus: 'unknown' })], [dep('t1', '2026-10-04', 510000)], none, new Set())[0]?.confidence).toBe('medium');
    expect(suggestIncomeMatches([inc({ amountStatus: 'estimated' })], [dep('t1', '2026-10-05', 480000)], none, new Set())).toHaveLength(1);
  });
  it('semimonthly: each deposit settles its own half, never both with one deposit', () => {
    const q = inc({ frequency: 'semimonthly', dayOfMonth: 15, secondDay: 30, amountMinor: 285000 });
    const ms = suggestIncomeMatches([q], [dep('a', '2026-10-15', 285000), dep('b', '2026-10-30', 285000)], none, new Set());
    expect(ms.map((m) => m.period)).toEqual(['2026-10-01', '2026-10-02']);
    expect(suggestIncomeMatches([q], [dep('a', '2026-10-15', 285000)], none, new Set())).toHaveLength(1);
  });
});

const ob = obBase;

describe('observed amounts (estimated/unknown are never silently replaced)', () => {
  it('an unknown amount gets a suggestion from its last linked payment; known amounts are left to variations', () => {
    const internet = ob({ id: 'i', name: 'Internet', amountMinor: null, amountStatus: 'unknown' });
    const rent = ob({ id: 'r', name: 'Alquiler', amountMinor: 120000 });
    const paid = [{ obligationId: 'i', period: '2026-09', actualMinor: 8900 }, { obligationId: 'i', period: '2026-08', actualMinor: 8500 }, { obligationId: 'r', period: '2026-09', actualMinor: 125000 }];
    expect(observedAmountsForUnknown([internet, rent], paid)).toEqual([{ obligationId: 'i', name: 'Internet', currency: 'PEN', observedMinor: 8900, period: '2026-09' }]);
    expect(observedAmountsForUnknown([internet], [])).toEqual([]);
    expect(observedAmountsForUnknown([internet], [{ obligationId: 'i', period: '2026-09', actualMinor: 8900, acknowledged: true }])).toEqual([]);
  });

  it('essentials: suggests only with 2+ complete months of enough data and a material difference', () => {
    const months = [{ month: '2026-07', amountMinor: 44000, count: 12 }, { month: '2026-08', amountMinor: 46000, count: 15 }, { month: '2026-09', amountMinor: 10000, count: 3 }];
    expect(essentialsSuggestion(50000, months, '2026-10')).toEqual({ estimateMinor: 50000, observedMinor: 45000, months: ['2026-07', '2026-08'], deltaMinor: -5000 });
    expect(essentialsSuggestion(50000, months.slice(1), '2026-10')).toBeNull(); // one complete month + one thin month
    expect(essentialsSuggestion(46000, months, '2026-10')).toBeNull(); // noise
    expect(essentialsSuggestion(null, months, '2026-10')).toBeNull(); // no estimate to update
    expect(essentialsSuggestion(50000, [...months, { month: '2026-10', amountMinor: 90000, count: 30 }], '2026-10')?.months).not.toContain('2026-10');
  });

  it('essential spend counts only expenses in essential categories, split-aware and per currency', () => {
    const rows = essentialSpendByMonth([
      { occurredOn: '2026-08-02', amountMinor: 5000, currency: 'PEN', isExpense: true, category: 'Alimentación' },
      { occurredOn: '2026-08-03', amountMinor: 9000, currency: 'PEN', isExpense: true, category: 'Ocio' },
      { occurredOn: '2026-08-04', amountMinor: 20000, currency: 'PEN', isExpense: false, category: 'Alimentación' }, // card payment / transfer
      { occurredOn: '2026-08-05', amountMinor: 3000, currency: 'USD', isExpense: true, category: 'Alimentación' },
      { occurredOn: '2026-08-06', amountMinor: 8000, currency: 'PEN', isExpense: true, category: 'Otros', allocations: [{ category: 'Transporte', amountMinor: 2000 }, { category: 'Ocio', amountMinor: 6000 }] },
    ], 'PEN');
    expect(rows).toEqual([{ month: '2026-08', amountMinor: 7000, count: 2 }]);
  });
});

describe('timeline (expected ≠ received, planned ≠ paid)', () => {
  const base = { today: '2026-10-07', settledObligations: none, settledIncomes: none };
  it('orders incomes and payments by date, keeps statuses, lists overdue and undated items', () => {
    const ob = (o: Partial<Obligation> & { id: string; name: string }) => obBase({ since: '2026-10-01', ...o });
    const items = timeline({ ...base,
      incomes: [inc({ dayOfMonth: 5 })],
      obligations: [ob({ id: 'car', name: 'Carro', dueDay: 9, dueDayMax: 10, amountMinor: 80000 }), ob({ id: 'luz', name: 'Luz', dueDay: 2, amountStatus: 'estimated' }),
        ob({ id: 'net', name: 'Internet', dueDay: null, amountMinor: null, amountStatus: 'unknown' })] });
    expect(items.map((i) => `${i.label}:${i.date}`)).toEqual(['Luz:2026-10-02', 'Sueldo:2026-10-05', 'Carro:2026-10-09', 'Luz:2026-11-02', 'Sueldo:2026-11-05', 'Carro:2026-11-09', 'Internet:null']);
    expect(items[0]).toMatchObject({ overdue: true, amountStatus: 'estimated' });
    expect(items[1]).toMatchObject({ kind: 'income', overdue: true }); // expected, not received yet
    expect(items[2]).toMatchObject({ dateMax: '2026-10-10', overdue: false });
    expect(items.at(-1)).toMatchObject({ amountStatus: 'unknown', amountMinor: null });
  });
  it('a paid period and a received income disappear; items before the obligation existed are not overdue debts', () => {
    const items = timeline({ ...base, settledObligations: new Map([['luz', new Set(['2026-10'])]]), settledIncomes: new Map([['sueldo', new Set(['2026-10', '2026-11'])]]),
      incomes: [inc()], obligations: [ob({ id: 'luz', name: 'Luz', dueDay: 2 }), ob({ id: 'gym', name: 'Gimnasio', dueDay: 1, since: '2026-10-06' })] });
    expect(items.map((i) => `${i.label}:${i.date}`)).toEqual(['Gimnasio:2026-11-01', 'Luz:2026-11-02']);
  });
});

describe('camera in Preguntar: confirmed photo facts update what exists, never duplicate', () => {
  const uid = 'u1';
  const card = [
    { t: 'debt', kind: 'card', name: 'Tarjeta BCP', institution: 'BCP', last4: '1234', currency: 'PEN', balanceMinor: 250000, minimumMinor: 12000, dueDay: 19 },
    { t: 'account', institution: 'BCP', kind: 'card', last4: '1234' },
  ] as const;
  it('new card statement: creates the debt, its payment (minimum is estimated, never the total) and the card', () => {
    const w = visionWrites([...card], { obligations: [], debts: [], cardLast4: [] }, uid);
    expect(w.updates).toEqual([]);
    expect(w.inserts.map((i) => i.table).sort()).toEqual(['cards', 'debts', 'fixed_expenses']);
    expect(w.inserts.find((i) => i.table === 'fixed_expenses')!.row).toMatchObject({ kind: 'card', amount_minor: 12000, amount_status: 'estimated', due_day: 19 });
    expect(w.inserts.find((i) => i.table === 'debts')!.row).toMatchObject({ balance_minor: 250000, currency: 'PEN' });
  });
  it('same card again: updates debt balance and payment, card already known', () => {
    const w = visionWrites([...card], { obligations: [{ id: 'o1', name: 'Tarjeta BCP', kind: 'card', currency: 'PEN' }], debts: [{ id: 'd1', name: 'tarjeta bcp', currency: 'PEN' }], cardLast4: ['1234'] }, uid);
    expect(w.inserts).toEqual([]);
    expect(w.updates.map((u) => `${u.table}:${u.id}`).sort()).toEqual(['debts:d1', 'fixed_expenses:o1']);
    expect(w.updates.find((u) => u.id === 'd1')!.patch).toMatchObject({ balance_minor: 250000, due_day: 19 });
  });
  it('USD statement never updates the PEN debt', () => {
    const w = visionWrites([{ ...card[0], currency: 'USD' }], { obligations: [], debts: [{ id: 'd1', name: 'Tarjeta BCP', currency: 'PEN' }], cardLast4: [] }, uid);
    expect(w.updates).toEqual([]);
    expect(w.inserts.find((i) => i.table === 'debts')!.row).toMatchObject({ currency: 'USD' });
  });
  it('a bill without amount keeps it unknown (never 0); a single same-kind payment is matched', () => {
    const w = visionWrites([{ t: 'obligation', kind: 'internet', name: 'Claro', day: 12 }], { obligations: [{ id: 'net', name: 'Internet', kind: 'internet', currency: 'PEN' }], debts: [], cardLast4: [] }, uid);
    expect(w.updates).toEqual([{ table: 'fixed_expenses', id: 'net', patch: expect.objectContaining({ due_day: 12 }) }]);
    expect(w.updates[0]!.patch).not.toHaveProperty('amount_minor');
  });
  it('stored patches are untrusted: invalid kinds, amounts, days or incomes are dropped', () => {
    expect(validPatches([
      { t: 'obligation', kind: 'hack', name: 'x' }, { t: 'balance', amountMinor: -5 }, { t: 'balance', amountMinor: 1.5 },
      { t: 'debt', kind: 'card', name: 'T', last4: '12345' }, { t: 'income', amountMinor: 100 }, { t: 'obligation', kind: 'rent', name: 'A', day: 40 }, null,
      { t: 'balance', amountMinor: 320000, currency: 'PEN' },
    ])).toEqual([{ t: 'balance', amountMinor: 320000, currency: 'PEN' }]);
    expect(validPatches('nope')).toEqual([]);
  });
});

describe('decisions on suggestions', () => {
  const today = '2026-10-07';
  it('"Ahora no" hides until the date; "Descartar" hides that value, a materially new value may come back', () => {
    const later = [{ kind: 'essentials' as const, subject: 'PEN', valueMinor: 45000, decision: 'later' as const, until: '2026-10-21' }];
    expect(isSuppressed(later, 'essentials', 'PEN', 45000, today)).toBe(true);
    expect(isSuppressed(later, 'essentials', 'PEN', 45000, '2026-10-21')).toBe(false);
    const gone = [{ kind: 'essentials' as const, subject: 'PEN', valueMinor: 45000, decision: 'dismissed' as const, until: null }];
    expect(isSuppressed(gone, 'essentials', 'PEN', 46000, today)).toBe(true);
    expect(isSuppressed(gone, 'essentials', 'PEN', 60000, today)).toBe(false);
    expect(isSuppressed(gone, 'income_match', 'PEN', 45000, today)).toBe(false);
  });
  it('a deposit that fits two expected incomes equally is flagged ambiguous (the person picks)', () => {
    const a = inc({ id: 'a', name: 'Sueldo', amountMinor: 300000 });
    const b = inc({ id: 'b', name: 'Freelance', amountMinor: 300000 });
    const [m] = suggestIncomeMatches([a, b], [dep('t1', '2026-10-05', 300000)], none, new Set());
    expect(m).toMatchObject({ ambiguous: true, confidence: 'medium' });
    expect(suggestIncomeMatches([a], [dep('t1', '2026-10-05', 300000)], none, new Set())[0]?.ambiguous).toBeUndefined();
  });
});
