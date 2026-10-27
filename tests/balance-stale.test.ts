import { describe, expect, it } from 'vitest';
import { isBalanceStale, STALE_BALANCE_DAYS } from '../src/engine/planning';
import type { TransactionType } from '../src/domain/types';

/** The declared balance's freshness (lib/planning.ts uses this rule; the plan then says "Actualízalo"). */
const now = new Date('2026-10-22T15:00:00Z');
const snap = (asOf: string, currency: 'PEN' | 'USD' = 'PEN') => ({ currency, asOf });
const tx = (type: TransactionType, occurredAt = '2026-10-21T12:00:00Z', currency: 'PEN' | 'USD' = 'PEN') => ({ type, occurredAt, currency });

describe('isBalanceStale (pure)', () => {
  it(`older than ${STALE_BALANCE_DAYS} days → stale; 6 days with nothing moving → fresh`, () => {
    expect(isBalanceStale(snap('2026-10-14T15:00:00Z'), now, [])).toBe(true); // 8 days
    expect(isBalanceStale(snap('2026-10-16T15:00:00Z'), now, [])).toBe(false); // 6 days
    expect(isBalanceStale(snap('not a date'), now, [])).toBe(true);
  });
  it('a credit card purchase after it does not move the account → not stale', () => {
    expect(isBalanceStale(snap('2026-10-20T15:00:00Z'), now, [tx('credit_card_purchase')])).toBe(false);
  });
  it('an expense, cash taken out, an income or a refund after it → stale', () => {
    for (const t of ['expense', 'withdrawal', 'income', 'deposit', 'refund'] as const) expect(isBalanceStale(snap('2026-10-20T15:00:00Z'), now, [tx(t)])).toBe(true);
  });
  it('own transfers, movements before it and other currencies are ignored (PEN ≠ USD)', () => {
    expect(isBalanceStale(snap('2026-10-20T15:00:00Z'), now, [tx('internal_transfer')])).toBe(false);
    expect(isBalanceStale(snap('2026-10-20T15:00:00Z'), now, [tx('expense', '2026-10-19T12:00:00Z')])).toBe(false);
    expect(isBalanceStale(snap('2026-10-20T15:00:00Z'), now, [tx('expense', '2026-10-21T12:00:00Z', 'USD')])).toBe(false);
    expect(isBalanceStale(snap('2026-10-20T15:00:00Z', 'USD'), now, [tx('expense', '2026-10-21T12:00:00Z', 'USD')])).toBe(true);
  });
});
