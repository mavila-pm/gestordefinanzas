import { describe, expect, it } from 'vitest';
import { incomeBySource } from '../src/engine/income-sources';
import type { Transaction } from '../src/domain/types';

const t = (o: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(36), occurredAt: '2026-10-05T10:00:00-05:00', type: 'income', direction: 'inflow', amountMinor: 1000,
  currency: 'PEN', status: 'confirmed', merchantRaw: 'Negocio 1', ...o,
} as Transaction);

describe('incomeBySource', () => {
  it('groups confirmed incomes of the month by what they say, largest first; PEN apart from USD', () => {
    const r = incomeBySource([
      t({ amountMinor: 500000 }), t({ merchantRaw: 'NEGOCIO 1', amountMinor: 100000 }), t({ merchantRaw: 'Sueldo', amountMinor: 450000 }),
      t({ merchantRaw: null, amountMinor: 700 }), t({ currency: 'USD', amountMinor: 9 }), t({ status: 'review_required', amountMinor: 9 }),
      t({ type: 'refund', direction: 'inflow', amountMinor: 9 }), t({ type: 'internal_transfer', direction: 'neutral', amountMinor: 9 }),
      t({ occurredAt: '2026-09-30T10:00:00-05:00', amountMinor: 9 }),
    ], '2026-10', 'PEN');
    expect(r).toEqual([
      { name: 'Negocio 1', amountMinor: 600000, count: 2 },
      { name: 'Sueldo', amountMinor: 450000, count: 1 },
      { name: 'Sin descripción', amountMinor: 700, count: 1 },
    ]);
  });
});
