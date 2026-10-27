import { describe, expect, it } from 'vitest';
import { financialBalance, goalAmount, monthlyIncome } from '../src/engine/financial-balance';

const base = { currency: 'PEN' as const, today: '2026-10-27', incomes: [], budgets: [], fixed: [], debts: [], savings: null, investment: null };

describe('Balance financiero', () => {
  it('income base normalized to a month; unknown amounts are counted, never 0', () => {
    expect(monthlyIncome([{ currency: 'PEN', amountMinor: 200000, frequency: 'semimonthly' }, { currency: 'PEN', amountMinor: null, frequency: 'monthly' }, { currency: 'USD', amountMinor: 9, frequency: 'monthly' }], 'PEN', '2026-10-27'))
      .toEqual({ amountMinor: 400000, unknown: 1 });
    expect(monthlyIncome([], 'PEN', '2026-10-27')).toEqual({ amountMinor: null, unknown: 0 });
    // An ended income, or one paused past today, no longer counts.
    expect(monthlyIncome([{ currency: 'PEN', amountMinor: 300000, frequency: 'monthly', endedOn: '2026-10-20' }, { currency: 'PEN', amountMinor: 1000, frequency: 'monthly', pausedUntil: '2026-11-30' },
      { currency: 'PEN', amountMinor: 5000, frequency: 'monthly', pausedUntil: '2026-10-01' }], 'PEN', '2026-10-27')).toEqual({ amountMinor: 5000, unknown: 0 });
  });

  it('goals: fixed, or a % of the income; a % without income is unknown', () => {
    expect(goalAmount({ mode: 'fixed', amountMinor: 50000, bp: null }, { amountMinor: null, unknown: 0 })).toBe(50000);
    expect(goalAmount({ mode: 'percent', amountMinor: null, bp: 1000 }, { amountMinor: 450000, unknown: 0 })).toBe(45000);
    expect(goalAmount({ mode: 'percent', amountMinor: null, bp: 1000 }, { amountMinor: null, unknown: 0 })).toBeNull();
    // Part of the income unknown: a % of the part would understate the goal → unknown.
    expect(goalAmount({ mode: 'percent', amountMinor: null, bp: 1000 }, { amountMinor: 200000, unknown: 1 })).toBeNull();
  });

  it('assigns budgets + fixed + debt installments + goals; the rest is unassigned (negative = te faltan)', () => {
    const b = financialBalance({
      ...base,
      incomes: [{ currency: 'PEN', amountMinor: 450000, frequency: 'monthly' }],
      budgets: [{ currency: 'PEN', amountMinor: 60000 }, { currency: 'USD', amountMinor: 999 }],
      fixed: [{ currency: 'PEN', amountMinor: 120000, frequency: 'monthly' }, { currency: 'PEN', amountMinor: 120000, frequency: 'yearly' }, { currency: 'PEN', amountMinor: null, frequency: 'monthly' }],
      debts: [{ currency: 'PEN', installmentMinor: 25000, balanceMinor: 100000 }, { currency: 'PEN', installmentMinor: 25000, balanceMinor: 10000 }, { currency: 'PEN', installmentMinor: 9, balanceMinor: 0 }],
      savings: { mode: 'percent', amountMinor: null, bp: 1000 },
      investment: { mode: 'fixed', amountMinor: 30000, bp: null },
    });
    expect(b.lines.map((l) => [l.key, l.amountMinor, l.unknownCount])).toEqual([
      ['budgets', 60000, 0], ['fixed', 130000, 1], ['debts', 35000, 0], ['savings', 45000, 0], ['investment', 30000, 0],
    ]);
    expect(b).toMatchObject({ incomeMinor: 450000, assignedMinor: 300000, unassignedMinor: 150000 });
    const over = financialBalance({ ...base, incomes: [{ currency: 'PEN', amountMinor: 1000, frequency: 'monthly' }], budgets: [{ currency: 'PEN', amountMinor: 5000 }] });
    expect(over.unassignedMinor).toBe(-4000);
    expect(financialBalance({ ...base, budgets: [{ currency: 'PEN', amountMinor: 5000 }] }).unassignedMinor).toBeNull();
  });
});
