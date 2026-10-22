import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { planKey, type PlanKey } from '../src/billing/config';
import { PLAN_CODES, type PlanCode } from '../src/domain/billing';
import { DEFAULT_PLAN_CONFIG, planState, renewalStillOpen, SUBSCRIPTION_COLUMNS, type SubscriptionRow } from '../src/domain/entitlements';
import { culqiCheckout } from './culqi';

/**
 * How a purchase is completed (BillingProvider, spec §77/§85, ADR-0018):
 * - 'demo': demo accounts complete the order without any charge (billing_simulate_payment); the real
 *   subscription never changes. Used when Culqi is off or in live mode.
 * - 'culqi': Culqi Checkout tokenizes the card in Culqi's own window (Velsuno never sees card data) and the
 *   server charges the stored order amount with the secret key; SQL grants Plus. Live mode (production keys) for
 *   real accounts; test mode (sandbox keys, Preview) ONLY for demo accounts — the database is shared.
 * - 'disabled': nothing can be bought; the page says so (never a fake success).
 */
export type BillingMode =
  | { kind: 'demo' }
  | { kind: 'culqi'; livemode: boolean; publicKey: string; plans: Partial<Record<PlanKey, string>> }
  | { kind: 'disabled' };

/** True when CULQI_ENABLED=true and the keys pass the test/live guard (see src/billing/config.ts). */
export function culqiConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return culqiCheckout(env).ok;
}

export async function billingMode(supabase: SupabaseClient): Promise<BillingMode> {
  const { data: demo } = await supabase.from('demo_access').select('user_id').maybeSingle();
  const c = culqiCheckout();
  const culqi = c.ok ? { kind: 'culqi' as const, livemode: c.keys.livemode, publicKey: c.keys.publicKey, plans: c.plans } : null;
  if (demo) return culqi && !culqi.livemode ? culqi : { kind: 'demo' };
  return culqi && culqi.livemode ? culqi : { kind: 'disabled' };
}

/** A Culqi purchase is possible only when its exact plan (amount + trial) is configured: never a wrong price. */
export function purchasable(mode: BillingMode, plan: PlanCode, amountMinor: number, trial: boolean): boolean {
  if (mode.kind !== 'culqi') return mode.kind === 'demo';
  return plan === 'lifetime' || !!mode.plans[planKey(plan, amountMinor, trial)];
}

/** Prices from the database (billing_price), plus the monthly price from 2027 for the notice. */
export async function loadPrices(supabase: SupabaseClient): Promise<{ prices: Record<PlanCode, number>; monthly2027: number }> {
  const [m, a, l, m27] = await Promise.all([
    ...PLAN_CODES.map((p) => supabase.rpc('billing_price', { p_plan: p })),
    supabase.rpc('billing_price', { p_plan: 'monthly', p_at: '2027-01-01T05:00:00Z' }),
  ]);
  return { prices: { monthly: Number(m!.data), annual: Number(a!.data), lifetime: Number(l!.data) }, monthly2027: Number(m27!.data) };
}

export interface BillingState {
  billingPlan: PlanCode | null;
  status: string | null;
  trialUsed: boolean;
  /** A paid plan that still gives Plus (renewing, in grace, or cancelled but not ended): nothing else to buy. */
  paid: boolean;
  /**
   * A Mensual/Anual Culqi can still charge (renewal never cancelled), even when it no longer gives Plus (lapsed after
   * a failed charge): nothing else can be bought until the person cancels it (never two live subscriptions).
   */
  renewalOpen: boolean;
}

/** The person's paid state, through THE entitlement rule (planState ≡ SQL billing_plan_state). */
export async function loadBillingState(supabase: SupabaseClient, now = new Date()): Promise<BillingState> {
  const [{ data }, { data: grace }] = await Promise.all([
    supabase.from('subscriptions').select(`${SUBSCRIPTION_COLUMNS},provider_ref`).maybeSingle(),
    supabase.from('plan_config').select('value').eq('key', 'billing_grace_days').maybeSingle(),
  ]);
  const sub = (data as (SubscriptionRow & { provider_ref: string | null }) | null) ?? null;
  const billingPlan = (sub?.billing_plan ?? null) as PlanCode | null;
  const graceDays = Number(grace?.value ?? DEFAULT_PLAN_CONFIG.billing_grace_days);
  return {
    billingPlan, status: sub?.status ?? null, trialUsed: !!sub?.trial_started_at,
    paid: billingPlan !== null && planState(sub, graceDays, now) !== 'free', renewalOpen: renewalStillOpen(sub),
  };
}
