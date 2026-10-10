import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_CONFIG, entitlementsFor, historyStart, planConfigFrom, visibleMonth } from '../src/domain/entitlements';

const now = new Date('2026-09-27T12:00:00Z');
const sub = (o: Record<string, unknown>) => ({ plan: 'free', status: 'free', trial_started_at: null, trial_ends_at: null, current_period_end: null, ...o }) as never;

describe('entitlements (§81-84), decided server-side', () => {
  it('no subscription row = Free with configurable limits and a trial available', () => {
    expect(entitlementsFor(null, DEFAULT_PLAN_CONFIG, now)).toMatchObject({ plan: 'free', source: 'free', trialAvailable: true,
      limits: { autoMovementsPerMonth: 50, historyMonths: 3, institutions: 1 }, features: { monthComparison: false, recurringDetection: false } });
  });
  it('active trial = Plus until the exact end date', () => {
    const e = entitlementsFor(sub({ plan: 'plus', status: 'trialing', trial_started_at: '2026-09-20T00:00:00Z', trial_ends_at: '2026-10-04T00:00:00Z' }), DEFAULT_PLAN_CONFIG, now);
    expect(e).toMatchObject({ plan: 'plus', source: 'trial', trialEndsAt: '2026-10-04T00:00:00Z', trialAvailable: false, limits: { autoMovementsPerMonth: null, institutions: 3 }, features: { recurringDetection: true } });
  });
  it('expired trial downgrades automatically to Free and cannot restart (no charge, §83)', () => {
    const e = entitlementsFor(sub({ plan: 'plus', status: 'trialing', trial_started_at: '2026-09-01T00:00:00Z', trial_ends_at: '2026-09-15T00:00:00Z' }), DEFAULT_PLAN_CONFIG, now);
    expect(e).toMatchObject({ plan: 'free', source: 'free', trialEndsAt: null, trialAvailable: false });
  });
  it('paid Plus; past_due keeps access only until period end; canceled = Free', () => {
    expect(entitlementsFor(sub({ plan: 'plus', status: 'active' }), DEFAULT_PLAN_CONFIG, now).source).toBe('paid');
    expect(entitlementsFor(sub({ plan: 'plus', status: 'past_due', current_period_end: '2026-10-01T00:00:00Z' }), DEFAULT_PLAN_CONFIG, now).plan).toBe('plus');
    expect(entitlementsFor(sub({ plan: 'plus', status: 'past_due', current_period_end: '2026-09-01T00:00:00Z' }), DEFAULT_PLAN_CONFIG, now).plan).toBe('free');
    expect(entitlementsFor(sub({ plan: 'plus', status: 'canceled' }), DEFAULT_PLAN_CONFIG, now).plan).toBe('free');
  });
  it('config comes from the server table; unknown keys and bad values are ignored', () => {
    expect(planConfigFrom([{ key: 'free_auto_movements_per_month', value: 80 }, { key: 'hack', value: 1 }, { key: 'trial_days', value: -3 }]))
      .toEqual({ ...DEFAULT_PLAN_CONFIG, free_auto_movements_per_month: 80 });
  });
});

describe('history window (§81)', () => {
  const free = entitlementsFor(null, DEFAULT_PLAN_CONFIG, new Date('2026-10-08T12:00:00Z'));
  const plus = entitlementsFor({ plan: 'plus', status: 'active', trial_started_at: null, trial_ends_at: null, current_period_end: null }, DEFAULT_PLAN_CONFIG, new Date());
  it('Free sees the current month and the 2 previous (year boundary included); Plus sees everything', () => {
    expect(historyStart(free, '2026-10')).toBe('2026-08');
    expect(historyStart(free, '2027-01')).toBe('2026-11');
    expect(historyStart(plus, '2026-10')).toBeNull();
  });
  it('an older requested month shows the first visible one; visible months stay as asked', () => {
    expect(visibleMonth('2026-01', '2026-08')).toBe('2026-08');
    expect(visibleMonth('2026-09', '2026-08')).toBe('2026-09');
    expect(visibleMonth('2020-01', null)).toBe('2020-01');
  });
});
