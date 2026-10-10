/**
 * AI allowance as the person sees it (§48): a bar for conversation and a count for camera reads — never raw tokens.
 * Mirrors ai_effective_plan / ai_reserve (the database is the authority that enforces; this only displays).
 * Limits come from plan_config (server-side, PROPUESTO/configurable), never from constants in the UI.
 */
export type AIPlan = 'free' | 'trial' | 'plus';
export interface AIUsageRow { bucket: string; weighted_tokens: number | string; camera_reads: number }
export interface Allowance {
  plan: AIPlan;
  simulated: boolean;
  conversation: { used: number; limit: number; ratio: number };
  camera: { used: number; limit: number };
  onboarding: { used: number; limit: number; cameraUsed: number; cameraLimit: number } | null;
  reached: boolean;
}

export function aiPlanFrom(sub: { plan: string; status: string; trial_ends_at: string | null; current_period_end: string | null } | null, simulated: AIPlan | null, now: Date): AIPlan {
  if (simulated) return simulated;
  if (!sub) return 'free';
  if (sub.status === 'trialing' && sub.trial_ends_at && Date.parse(sub.trial_ends_at) > now.getTime()) return 'trial';
  if (sub.plan === 'plus' && (sub.status === 'active' || (sub.status === 'past_due' && !!sub.current_period_end && Date.parse(sub.current_period_end) > now.getTime()))) return 'plus';
  return 'free';
}

export const limaMonthKey = (now: Date) => `m:${new Date(now.getTime() - 5 * 3600_000).toISOString().slice(0, 7)}`;

export function allowance(plan: AIPlan, simulated: boolean, cfg: Record<string, number>, rows: readonly AIUsageRow[], onboardingActive: boolean, now: Date): Allowance {
  const get = (bucket: string) => rows.find((r) => r.bucket === bucket);
  const bucket = plan === 'trial' ? 'trial' : limaMonthKey(now);
  const row = get(bucket);
  const key = plan === 'trial' ? 'trial' : plan === 'plus' ? 'plus_monthly' : 'free_monthly';
  const limit = cfg[`ai_${key}_tokens`] ?? 0;
  const used = Number(row?.weighted_tokens ?? 0);
  const cam = { used: row?.camera_reads ?? 0, limit: cfg[`ai_${key}_camera_reads`] ?? 0 };
  const onb = get('onboarding');
  return {
    plan, simulated,
    conversation: { used, limit, ratio: limit ? Math.min(used / limit, 1) : 1 },
    camera: cam,
    onboarding: onboardingActive ? { used: Number(onb?.weighted_tokens ?? 0), limit: cfg.ai_onboarding_tokens ?? 0, cameraUsed: onb?.camera_reads ?? 0, cameraLimit: cfg.ai_onboarding_camera_reads ?? 0 } : null,
    reached: used >= limit,
  };
}

/**
 * "Uso de Vels" for Ajustes → Plan y uso: percent of the current allowance and when it renews. Real data only:
 * without a configured limit there is no percent (null), never an invented one. Monthly allowances renew on the
 * 1st of next month (Lima calendar, same bucket ai_reserve uses); a trial allowance ends with the trial.
 */
export interface VelsUsage { percent: number | null; resetAt: string | null; renews: 'monthly' | 'trial_end' | null }
export function velsUsage(a: Pick<Allowance, 'plan' | 'conversation'>, now: Date, trialEndsAt: string | null): VelsUsage {
  const { used, limit } = a.conversation;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null;
  if (a.plan === 'trial') return { percent, resetAt: trialEndsAt ? new Date(Date.parse(trialEndsAt) - 5 * 3600_000).toISOString().slice(0, 10) : null, renews: trialEndsAt ? 'trial_end' : null };
  const lima = new Date(now.getTime() - 5 * 3600_000);
  const next = new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth() + 1, 1));
  return { percent, resetAt: next.toISOString().slice(0, 10), renews: 'monthly' };
}
