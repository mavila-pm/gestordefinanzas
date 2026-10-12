import { describe, expect, it } from 'vitest';
import { categoryShares, checkSplit, isSplittable } from '../src/domain/allocations';
import { monthlySummary } from '../src/engine/monthly-summary';
import { compareMonths } from '../src/engine/analysis';
import { budgetStatus } from '../src/engine/budgets';
import { splitCell, transactionsToCsv } from '../src/web/export-csv';
import type { Transaction } from '../src/domain/types';

const tx = (o: Partial<Transaction> = {}): Transaction => ({
  id: 't1', userId: 'u', occurredAt: '2026-09-10T12:00:00-05:00', type: 'expense', direction: 'outflow', amountMinor: 18000, currency: 'PEN',
  institution: 'BCP', cardLast4: null, merchantRaw: 'RESTAURANTE', merchantNormalized: 'RESTAURANTE', category: 'Alimentación',
  status: 'confirmed', confidence: 'high', fingerprint: 'f', sources: [], originalTransactionId: null, duplicateOfId: null, ...o,
});
const split = tx({ allocations: [
  { category: 'Alimentación', amountMinor: 8000, note: null }, { category: 'Ocio', amountMinor: 6000, note: 'Amigos' },
  { category: 'Personal', amountMinor: 4000, note: 'Trabajo' }] });

describe('Dividir gasto: one movement, many categories, counted once', () => {
  it('80 + 60 + 40: the month total stays 180, categories receive 80/60/40', () => {
    const s = monthlySummary([split], '2026-09', 'PEN');
    expect(s.expensesMinor).toBe(18000);
    expect(s.expensesByCategory).toEqual({ Alimentación: 8000, Ocio: 6000, Personal: 4000 });
    expect(Object.values(s.expensesByCategory).reduce((a, b) => a + b, 0)).toBe(s.expensesMinor);
  });

  it('partial split: the remainder stays in the movement category; removing the split restores the original', () => {
    const partial = tx({ allocations: [{ category: 'Ocio', amountMinor: 6000, note: null }] });
    expect(categoryShares(partial, 'Alimentación')).toEqual([{ category: 'Ocio', amountMinor: 6000 }, { category: 'Alimentación', amountMinor: 12000 }]);
    expect(monthlySummary([tx({ allocations: [] })], '2026-09', 'PEN').expensesByCategory).toEqual({ Alimentación: 18000 });
  });

  it('a corrupt over-allocated row never creates money (falls back to the whole amount in its category)', () => {
    const bad = tx({ allocations: [{ category: 'Ocio', amountMinor: 20000, note: null }] });
    expect(monthlySummary([bad], '2026-09', 'PEN')).toMatchObject({ expensesMinor: 18000, expensesByCategory: { Alimentación: 18000 } });
  });

  it('analysis and budgets use the parts, never the sum of parts plus the movement', () => {
    const cmp = compareMonths([split], '2026-09', 'PEN');
    expect(cmp.categories.find((c) => c.category === 'Ocio')?.currentMinor).toBe(6000);
    expect(cmp.categories.reduce((a, c) => a + c.currentMinor, 0)).toBe(18000);
    const b = budgetStatus([split], '2026-09', [{ id: 'b', category: 'Alimentación', currency: 'PEN', amountMinor: 10000 }] as never);
    expect(b[0]!.spentMinor).toBe(8000);
  });

  it('CSV: one row with the full amount plus a traceable División column', () => {
    expect(splitCell(split)).toBe('Alimentación 80.00 | Ocio (Amigos) 60.00 | Personal (Trabajo) 40.00');
    expect(splitCell(tx({ allocations: [{ category: 'Ocio', amountMinor: 6000, note: null }] }))).toBe('Ocio 60.00 | Alimentación 120.00');
    const csv = transactionsToCsv([split]).trim().split('\r\n');
    expect(csv).toHaveLength(2);
    expect(csv[1]).toContain('"180.00"');
  });

  it('eligibility: confirmed spending only', () => {
    expect(isSplittable(tx())).toBe(true);
    expect(isSplittable(tx({ type: 'credit_card_purchase' }))).toBe(true);
    for (const type of ['refund', 'reversal', 'withdrawal', 'credit_card_payment', 'internal_transfer', 'income', 'unknown'] as const) {
      expect(isSplittable(tx({ type }))).toBe(false);
    }
    expect(isSplittable(tx({ status: 'review_required' }))).toBe(false);
  });

  it('checkSplit mirrors the database rules for live feedback', () => {
    expect(checkSplit(18000, [{ categoryId: 'a', amountMinor: 8000 }, { categoryId: 'b', amountMinor: 6000 }])).toEqual({ allocatedMinor: 14000, remainingMinor: 4000, error: null });
    expect(checkSplit(18000, [{ categoryId: 'a', amountMinor: 20000 }]).error).toBe('over_allocated');
    expect(checkSplit(18000, [{ categoryId: 'a', amountMinor: 0 }]).error).toBe('invalid_amount');
    expect(checkSplit(18000, [{ categoryId: null, amountMinor: 100 }]).error).toBe('missing_category');
    expect(checkSplit(18000, []).error).toBe('no_parts');
  });
});
