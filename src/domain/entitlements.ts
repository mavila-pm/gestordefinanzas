/**
 * Entitlements (spec §84): decided server-side from the subscription row + plan_config, never by the UI.
 * Security, isolation, dedupe, accuracy, recovery, manual correction and data export are never premium (§82).
 */
export interface SubscriptionRow {
  plan: 'free' | 'plus';
  status: 'free' | 'trialing' | 'active' | 'past_due' | 'canceled';
  trial_started_at: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
}

export interface PlanConfig {
  trial_days: number;
  free_auto_movements_per_month: number;
  free_history_months: number;
  free_institutions: number;
  plus_institutions: number;
}

export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  trial_days: 14, free_auto_movements_per_month: 50, free_history_months: 3, free_institutions: 1, plus_institutions: 3,
};

export interface Entitlements {
  plan: 'free' | 'plus';
  source: 'free' | 'trial' | 'paid';
  trialEndsAt: string | null;
  trialAvailable: boolean;
  limits: { autoMovementsPerMonth: number | null; historyMonths: number | null; institutions: number };
  features: { monthComparison: boolean; fullHistory: boolean; advancedInsights: boolean; budgetsAdvanced: boolean };
}

export function entitlementsFor(sub: SubscriptionRow | null, cfg: PlanConfig, now: Date): Entitlements {
  const trialing = sub?.status === 'trialing' && !!sub.trial_ends_at && Date.parse(sub.trial_ends_at) > now.getTime();
  const paid = sub?.plan === 'plus' && (sub.status === 'active' || (sub.status === 'past_due' && !!sub.current_period_end && Date.parse(sub.current_period_end) > now.getTime()));
  const plus = trialing || paid;
  return {
    plan: plus ? 'plus' : 'free',
    source: paid ? 'paid' : trialing ? 'trial' : 'free',
    trialEndsAt: trialing ? sub!.trial_ends_at : null,
    // An expired trial falls back to Free automatically (§83) and cannot be restarted.
    trialAvailable: !sub?.trial_started_at && !paid,
    limits: plus
      ? { autoMovementsPerMonth: null, historyMonths: null, institutions: cfg.plus_institutions }
      : { autoMovementsPerMonth: cfg.free_auto_movements_per_month, historyMonths: cfg.free_history_months, institutions: cfg.free_institutions },
    features: { monthComparison: plus, fullHistory: plus, advancedInsights: plus, budgetsAdvanced: plus },
  };
}

export function planConfigFrom(rows: ReadonlyArray<{ key: string; value: number }>): PlanConfig {
  const cfg = { ...DEFAULT_PLAN_CONFIG };
  for (const r of rows) if (r.key in cfg && Number.isInteger(r.value) && r.value >= 0) (cfg as Record<string, number>)[r.key] = r.value;
  return cfg;
}
