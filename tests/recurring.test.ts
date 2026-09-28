import { describe, expect, it } from 'vitest';
import { detectRecurring } from '../src/engine/recurring';
import type { TransactionType } from '../src/domain/types';

const t = (date: string, merchant: string, amountMinor: number, o: { type?: TransactionType; status?: string; currency?: 'PEN' | 'USD' } = {}) => ({
  type: o.type ?? 'expense', status: (o.status ?? 'confirmed') as 'confirmed', amountMinor, currency: o.currency ?? 'PEN',
  occurredAt: `${date}T12:00:00-05:00`, merchantNormalized: merchant,
});

describe('detectRecurring (suggestions only)', () => {
  const netflix = [t('2026-06-05', 'NETFLIX', 4490), t('2026-07-05', 'NETFLIX', 4490), t('2026-08-06', 'NETFLIX', 4490), t('2026-09-05', 'NETFLIX', 4990)];

  it('detects a monthly charge with stable amount and day', () => {
    const r = detectRecurring(netflix, '2026-09');
    expect(r).toEqual([{ merchant: 'NETFLIX', currency: 'PEN', typicalAmountMinor: 4490, dayOfMonth: 5,
      months: ['2026-06', '2026-07', '2026-08', '2026-09'], lastSeen: '2026-09-05', tracked: false }]);
  });

  it('needs 3 distinct months; several charges in a month are not a bill', () => {
    expect(detectRecurring(netflix.slice(0, 2), '2026-09')).toEqual([]);
    const taxi = [t('2026-07-03', 'UBER', 1500), t('2026-08-03', 'UBER', 1500), t('2026-09-03', 'UBER', 1500), t('2026-09-04', 'UBER', 1500)];
    expect(detectRecurring(taxi, '2026-09')).toEqual([]);
  });

  it('unstable amount or day is not recurring', () => {
    expect(detectRecurring([t('2026-07-05', 'X', 1000), t('2026-08-05', 'X', 1000), t('2026-09-05', 'X', 2000)], '2026-09')).toEqual([]);
    expect(detectRecurring([t('2026-07-02', 'X', 1000), t('2026-08-15', 'X', 1000), t('2026-09-28', 'X', 1000)], '2026-09')).toEqual([]);
  });

  it('card payments, ATM withdrawals, transfers, refunds and unconfirmed movements never count', () => {
    for (const type of ['credit_card_payment', 'withdrawal', 'internal_transfer', 'refund'] as const) {
      expect(detectRecurring(['2026-07-05', '2026-08-05', '2026-09-05'].map((d) => t(d, 'X', 1000, { type })), '2026-09')).toEqual([]);
    }
    expect(detectRecurring(['2026-07-05', '2026-08-05', '2026-09-05'].map((d) => t(d, 'X', 1000, { status: 'review_required' })), '2026-09')).toEqual([]);
  });

  it('currencies are never mixed; old months outside the window are ignored', () => {
    const mixed = [t('2026-07-05', 'SPOTIFY', 1000), t('2026-08-05', 'SPOTIFY', 1000, { currency: 'USD' }), t('2026-09-05', 'SPOTIFY', 1000)];
    expect(detectRecurring(mixed, '2026-09')).toEqual([]);
    const old = [t('2026-01-05', 'X', 1000), t('2026-02-05', 'X', 1000), t('2026-09-05', 'X', 1000)];
    expect(detectRecurring(old, '2026-09')).toEqual([]);
  });

  it('marks as tracked when an active fixed expense already covers it', () => {
    const r = detectRecurring(netflix, '2026-09', [{ name: 'Netflix', currency: 'PEN', amountMinor: 4490, active: true }]);
    expect(r[0]!.tracked).toBe(true);
    expect(detectRecurring(netflix, '2026-09', [{ name: 'Netflix', currency: 'PEN', amountMinor: 4490, active: false }])[0]!.tracked).toBe(false);
  });
});
