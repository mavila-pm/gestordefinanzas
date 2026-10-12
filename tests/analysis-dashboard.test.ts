import { describe, expect, it } from 'vitest';
import { fixedVsVariable, percentChange, relevantChanges, savingsProgress, savingsRate } from '../src/engine/analysis';
import type { Transaction } from '../src/domain/types';

const tx = (id: string, type: Transaction['type'], amountMinor: number, extra: Partial<Transaction> = {}): Transaction => ({
  id, type, amountMinor, currency: 'PEN', occurredAt: '2026-10-05T17:00:00.000Z', status: 'confirmed', direction: type === 'income' || type === 'refund' ? 'inflow' : 'outflow',
  category: 'Alimentación', merchantRaw: id, merchantNormalized: id, ...extra,
} as Transaction);

describe('Análisis: deterministic figures (no invented data)', () => {
  it('percent change needs a base; savings rate needs income; goal progress never below 0', () => {
    expect(percentChange(12100, 10000)).toBe(21);
    expect(percentChange(5000, 0)).toBeNull();
    expect(savingsRate({ incomeMinor: 450000, netCashFlowMinor: 90000 })).toBe(20);
    expect(savingsRate({ incomeMinor: 0, netCashFlowMinor: -5000 })).toBeNull();
    expect(savingsProgress(120000, 200000)).toEqual({ savedMinor: 120000, ratio: 0.6 });
    expect(savingsProgress(-30000, 200000)).toEqual({ savedMinor: 0, ratio: 0 });
    expect(savingsProgress(300000, 200000)?.ratio).toBe(1);
    expect(savingsProgress(100000, null)).toBeNull();
  });
  it('relevant changes: "Alimentación subió 21%." only with a base, ≥15% and ≥ S/ 50', () => {
    const lines = relevantChanges({ categories: [
      { category: 'Alimentación', currentMinor: 121000, previousMinor: 100000, deltaMinor: 21000 },
      { category: 'Ocio', currentMinor: 6000, previousMinor: 4000, deltaMinor: 2000 },
      { category: 'Salud', currentMinor: 30000, previousMinor: 0, deltaMinor: 30000 },
      { category: 'Transporte', currentMinor: 20000, previousMinor: 30000, deltaMinor: -10000 },
    ] });
    expect(lines.map((l) => l.text)).toEqual(['Alimentación subió 21%.', 'Transporte bajó 33%.']);
  });
  it('fixed vs variable: linked expenses are fixed; card payment and transfers never count; refunds reduce variable', () => {
    const txs = [tx('rent', 'expense', 120000), tx('food', 'credit_card_purchase', 30000), tx('card', 'credit_card_payment', 50000),
      tx('move', 'internal_transfer', 40000), tx('atm', 'withdrawal', 20000), tx('back', 'refund', 5000), tx('usd', 'expense', 9999, { currency: 'USD' })];
    expect(fixedVsVariable(txs, '2026-10', 'PEN', new Set(['rent', 'card']))).toEqual({ fixedMinor: 120000, variableMinor: 25000 });
  });
});
