import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PLAN_CODES, type PlanCode } from '../src/domain/billing';

/**
 * How a purchase is completed (BillingProvider, spec §77):
 * - 'demo': demo accounts complete the order without any charge (billing_simulate_payment); the real
 *   subscription never changes.
 * - 'culqi': Culqi Checkout tokenizes the card in Culqi's own window (Velsuno never sees card data) and the
 *   server charges with the secret key, then billing_activate grants Plus. Enabled only with CULQI_PUBLIC_KEY,
 *   CULQI_SECRET_KEY and the plan ids configured — not yet: until then real accounts see that payments are coming.
 * - 'disabled': nothing can be bought; the page says so (never a fake success).
 */
export type BillingMode = 'demo' | 'culqi' | 'disabled';

export function culqiConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!(env.CULQI_PUBLIC_KEY && env.CULQI_SECRET_KEY && env.CULQI_PLAN_MONTHLY && env.CULQI_PLAN_ANNUAL && env.CULQI_ENABLED === 'true');
}

export async function billingMode(supabase: SupabaseClient): Promise<BillingMode> {
  const { data: demo } = await supabase.from('demo_access').select('user_id').maybeSingle();
  if (demo) return 'demo';
  return culqiConfigured() ? 'culqi' : 'disabled';
}

/** Prices from the database (billing_price), plus the monthly price from 2027 for the notice. */
export async function loadPrices(supabase: SupabaseClient): Promise<{ prices: Record<PlanCode, number>; monthly2027: number }> {
  const [m, a, l, m27] = await Promise.all([
    ...PLAN_CODES.map((p) => supabase.rpc('billing_price', { p_plan: p })),
    supabase.rpc('billing_price', { p_plan: 'monthly', p_at: '2027-01-01T05:00:00Z' }),
  ]);
  return { prices: { monthly: Number(m!.data), annual: Number(a!.data), lifetime: Number(l!.data) }, monthly2027: Number(m27!.data) };
}

/** The person's paid state: what a page needs to decide whether buying makes sense. */
export async function loadBillingState(supabase: SupabaseClient): Promise<{ billingPlan: PlanCode | null; status: string | null; trialUsed: boolean }> {
  const { data } = await supabase.from('subscriptions').select('billing_plan,status,trial_started_at').maybeSingle();
  return { billingPlan: (data?.billing_plan ?? null) as PlanCode | null, status: data?.status ?? null, trialUsed: !!data?.trial_started_at };
}
