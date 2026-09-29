import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_CONFIG, entitlementsFor, planConfigFrom } from '../src/domain/entitlements';

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
