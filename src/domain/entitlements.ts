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
  /** Paid plan behind the row (null: card-less trial or Plus granted by hand). */
  billing_plan?: 'monthly' | 'annual' | 'lifetime' | null;
  /** "Cancelar renovación": Plus until the end of the paid period, then Free. */
  cancel_at_period_end?: boolean | null;
}

/** Columns every reader of the entitlement rule must select (keep in sync with billing_plan_state). */
export const SUBSCRIPTION_COLUMNS = 'plan,status,trial_started_at,trial_ends_at,current_period_end,billing_plan,cancel_at_period_end';

export type PlanState = 'free' | 'trial' | 'plus';

/**
 * THE entitlement rule (ADR-0018). Mirror of SQL public.billing_plan_state (migration 20261020000054), checked row
 * by row by tests/db/entitlements-parity.test.ts — change both or neither.
 * - Any trial: Plus ('trial') until its exact end. A card-backed trial whose first charge is being confirmed keeps
 *   Plus for `graceDays`, never after a cancellation.
 * - Vitalicio: Plus with no end (a full refund sets status 'canceled').
 * - Mensual/Anual (active or past_due): Plus until the paid period ends, plus `graceDays` while a renewal is
 *   expected; cancelled at period end: exactly until the period ends. No period end → Free (fail closed).
 * - Plus granted by hand (no billing plan): until its end, if it has one.
 * Payment state never deletes data: it only decides what the plan allows.
 */
export function planState(sub: Pick<SubscriptionRow, 'plan' | 'status' | 'trial_ends_at' | 'current_period_end' | 'billing_plan' | 'cancel_at_period_end'> | null, graceDays: number, now: Date): PlanState {
  if (!sub || !sub.status) return 'free';
  const t = now.getTime();
  const at = (v: string | null | undefined) => (v ? Date.parse(v) : NaN);
  const grace = Math.max(0, Number.isFinite(graceDays) ? Math.trunc(graceDays) : 0) * 86_400_000;
  const recurring = sub.billing_plan === 'monthly' || sub.billing_plan === 'annual';
  const cancel = sub.cancel_at_period_end === true;
  if (sub.status === 'trialing') {
    const end = at(sub.trial_ends_at);
    if (end > t) return 'trial';
    return recurring && !cancel && end + grace > t ? 'plus' : 'free';
  }
  if (sub.plan !== 'plus') return 'free';
  const periodEnd = at(sub.current_period_end);
  if (sub.status === 'active' && sub.billing_plan === 'lifetime') return 'plus';
  if ((sub.status === 'active' || sub.status === 'past_due') && recurring) {
    if (!sub.current_period_end) return 'free';
    return periodEnd + (cancel ? 0 : grace) > t ? 'plus' : 'free';
  }
  if (sub.status === 'active' && !sub.billing_plan) return !sub.current_period_end || periodEnd > t ? 'plus' : 'free';
  if (sub.status === 'past_due' && !sub.billing_plan) return periodEnd > t ? 'plus' : 'free';
  return 'free';
}

/**
 * A Mensual/Anual the provider can still charge: it has a provider reference, its renewal was never cancelled and it
 * is not closed — whatever the plan state (a lapsed past_due is Free but Culqi may still charge it). While it holds,
 * nothing else is bought: the person cancels it first, so there are never two live subscriptions. Mirror of SQL
 * public.billing_renewal_open (migration 20261020000055), checked by tests/db/entitlements-parity.test.ts.
 */
export function renewalStillOpen(sub: { status?: string | null; billing_plan?: string | null; provider_ref?: string | null; cancel_at_period_end?: boolean | null } | null): boolean {
  if (!sub) return false;
  return (sub.billing_plan === 'monthly' || sub.billing_plan === 'annual') && !!sub.provider_ref && sub.cancel_at_period_end !== true
    && (sub.status === 'trialing' || sub.status === 'active' || sub.status === 'past_due');
}

export interface PlanConfig {
  trial_days: number;
  /** Days with Plus after a paid period ends while its renewal is still being confirmed (plan_config). */
  billing_grace_days: number;
  free_auto_movements_per_month: number;
  free_history_months: number;
  free_institutions: number;
  plus_institutions: number;
}

export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  trial_days: 14, billing_grace_days: 3, free_auto_movements_per_month: 50, free_history_months: 3, free_institutions: 1, plus_institutions: 3,
};

export interface Entitlements {
  plan: 'free' | 'plus';
  source: 'free' | 'trial' | 'paid';
  trialEndsAt: string | null;
  trialAvailable: boolean;
  limits: { autoMovementsPerMonth: number | null; historyMonths: number | null; institutions: number };
  features: { monthComparison: boolean; fullHistory: boolean; advancedInsights: boolean; budgetsAdvanced: boolean; recurringDetection: boolean };
}

export function entitlementsFor(sub: SubscriptionRow | null, cfg: PlanConfig, now: Date): Entitlements {
  const state = planState(sub, cfg.billing_grace_days, now);
  const trialing = state === 'trial';
  const paid = state === 'plus';
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
    features: { monthComparison: plus, fullHistory: plus, advancedInsights: plus, budgetsAdvanced: plus, recurringDetection: plus },
  };
}

export function planConfigFrom(rows: ReadonlyArray<{ key: string; value: number }>): PlanConfig {
  const cfg = { ...DEFAULT_PLAN_CONFIG };
  for (const r of rows) if (r.key in cfg && Number.isInteger(r.value) && r.value >= 0) (cfg as Record<string, number>)[r.key] = r.value;
  return cfg;
}

/**
 * First visible month (YYYY-MM) of the plan's history window (§81): the current month plus the previous
 * `historyMonths - 1`. null = full history. Older data is kept (never deleted); it is only not shown on Free.
 */
export function historyStart(e: Entitlements, currentMonth: string): string | null {
  const n = e.limits.historyMonths;
  if (n === null) return null;
  const [y, m] = currentMonth.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) - Math.max(0, n - 1);
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** A requested month kept inside the visible window: older months show the first visible one. */
export function visibleMonth(month: string, start: string | null): string {
  return start && month < start ? start : month;
}
