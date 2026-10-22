import { culqiId, keyMode } from './culqi';

/**
 * Billing configuration from the environment (pure: env is passed in). ADR-0018.
 *
 * Test/live guard: Preview and Production share ONE database, so a sandbox charge must never grant real Plus and a
 * live key must never run outside Production:
 * - VERCEL_ENV=production → only pk_live_/sk_live_; anything else (Preview, local) → only pk_test_/sk_test_;
 * - both keys of the same mode; any mismatch → billing disabled with a logged reason (never "culqi" by default);
 * - test mode is offered to demo accounts only (lib/billing.ts) and SQL refuses a test charge for anyone else.
 *
 * Plans: one Culqi plan per (plan, amount, trial) — CULQI_PLAN_<MONTHLY|ANNUAL>_<amount minor>[_TRIAL]. The order
 * amount (billing_price at order time) picks the plan, so the January 2027 monthly change (400 → 900) needs its own
 * plan ids and nobody is ever subscribed at a price they did not accept. A missing plan = that purchase disabled.
 */
export type BillingDisabledReason =
  | 'not_enabled' | 'missing_keys' | 'bad_key_format' | 'key_mode_mismatch' | 'live_key_outside_production' | 'test_key_in_production'
  | 'missing_database_url' | 'terms_without_billing' | 'missing_webhook_credentials' | 'weak_webhook_password';

export interface CulqiKeys { mode: 'test' | 'live'; livemode: boolean; publicKey: string; secretKey: string }
export type Checked<T> = ({ ok: true } & T) | { ok: false; reason: BillingDisabledReason };

type Env = Record<string, string | undefined>;

/** The keys, when they are well formed, agree with each other and with the deployment. */
export function culqiKeys(env: Env): Checked<{ keys: CulqiKeys }> {
  const pk = env.CULQI_PUBLIC_KEY?.trim();
  const sk = env.CULQI_SECRET_KEY?.trim();
  if (!pk || !sk) return { ok: false, reason: 'missing_keys' };
  const pkMode = /^pk_(test|live)_/.exec(pk)?.[1];
  const skMode = /^sk_(test|live)_/.exec(sk)?.[1];
  if (!pkMode || !skMode) return { ok: false, reason: 'bad_key_format' };
  if (pkMode !== skMode) return { ok: false, reason: 'key_mode_mismatch' };
  const mode = keyMode(pk, sk);
  if (!mode) return { ok: false, reason: 'bad_key_format' };
  const production = env.VERCEL_ENV === 'production';
  if (production && mode !== 'live') return { ok: false, reason: 'test_key_in_production' };
  if (!production && mode !== 'test') return { ok: false, reason: 'live_key_outside_production' };
  if (!env.DATABASE_URL) return { ok: false, reason: 'missing_database_url' };
  return { ok: true, keys: { mode, livemode: mode === 'live', publicKey: pk, secretKey: sk } };
}

export type PlanKey = `${'monthly' | 'annual'}:${number}:${'trial' | 'no_trial'}`;
export const planKey = (plan: 'monthly' | 'annual', amountMinor: number, trial: boolean): PlanKey => `${plan}:${amountMinor}:${trial ? 'trial' : 'no_trial'}`;

/** CULQI_PLAN_* → plan ids of the keys' mode. Malformed or wrong-mode ids are left out (and reported). */
export function culqiPlans(env: Env, livemode: boolean): { plans: Partial<Record<PlanKey, string>>; issues: string[] } {
  const plans: Partial<Record<PlanKey, string>> = {};
  const issues: string[] = [];
  for (const [name, raw] of Object.entries(env)) {
    const m = /^CULQI_PLAN_(MONTHLY|ANNUAL)_([1-9][0-9]{0,6})(_TRIAL)?$/.exec(name);
    if (!m) continue;
    const value = raw?.trim();
    if (!value) continue;
    const id = culqiId(value, 'pln');
    if (!id || id.livemode !== livemode) { issues.push(`${name}:bad_plan_id`); continue; }
    plans[planKey(m[1] === 'MONTHLY' ? 'monthly' : 'annual', Number(m[2]), !!m[3])] = value;
  }
  return { plans, issues };
}

/**
 * New purchases (checkout). Needs CULQI_ENABLED=true and valid keys; live sales also need Terms that cover
 * charges (TERMS_COVER_BILLING in src/web/legal.ts, set only when the PO publishes them).
 */
export function culqiSales(env: Env, termsCoverBilling: boolean): Checked<{ keys: CulqiKeys; plans: Partial<Record<PlanKey, string>>; issues: string[] }> {
  if (env.CULQI_ENABLED !== 'true') return { ok: false, reason: 'not_enabled' };
  const k = culqiKeys(env);
  if (!k.ok) return k;
  if (k.keys.livemode && !termsCoverBilling) return { ok: false, reason: 'terms_without_billing' };
  return { ok: true, keys: k.keys, ...culqiPlans(env, k.keys.livemode) };
}

/**
 * The webhook works whenever the keys are valid (renewals and refunds of existing subscribers keep flowing even
 * with new sales switched off) and its Basic-auth credentials exist: user 1–20 characters, password ≥ 24.
 */
export function culqiWebhook(env: Env): Checked<{ keys: CulqiKeys; user: string; password: string }> {
  const k = culqiKeys(env);
  if (!k.ok) return k;
  const user = env.CULQI_WEBHOOK_USER ?? '';
  const password = env.CULQI_WEBHOOK_PASSWORD ?? '';
  if (!user || !password) return { ok: false, reason: 'missing_webhook_credentials' };
  if (user.length > 20 || password.length < 24) return { ok: false, reason: 'weak_webhook_password' };
  return { ok: true, keys: k.keys, user, password };
}
