/**
 * Velsuno plans (PO 2026-10-12). Pure: names, what each plan means and the texts derived from server prices.
 * PRICES ARE NOT HERE: they come from `billing_price()` in the database (one source of truth); this module only
 * formats them. Money in minor units, USD.
 */
export type PlanCode = 'monthly' | 'annual' | 'lifetime';
export const PLAN_CODES: readonly PlanCode[] = ['monthly', 'annual', 'lifetime'];

export const PLAN_INFO: Record<PlanCode, { name: string; period: string; badge?: string; recurring: boolean }> = {
  monthly: { name: 'Mensual', period: 'al mes', recurring: true },
  annual: { name: 'Anual', period: 'al año', recurring: true },
  lifetime: { name: 'Vitalicio', period: 'pago único', badge: 'Para siempre', recurring: false },
};

export const PLUS_FEATURES = [
  'Más uso de Vels y lecturas con cámara',
  'Historial completo de movimientos',
  'Detección de cobros que se repiten',
  'Comparación mes a mes y análisis avanzado',
  'Hasta 3 bancos con automatización',
] as const;

export function isPlanCode(v: unknown): v is PlanCode {
  return typeof v === 'string' && (PLAN_CODES as readonly string[]).includes(v);
}

/**
 * Annual saving against paying the monthly price 12 times, in whole percent. null when there is no saving (e.g. the
 * launch monthly price is lower than the annual one): never claim a discount that does not exist.
 */
export function annualSavingPercent(monthlyMinor: number, annualMinor: number): number | null {
  const year = monthlyMinor * 12;
  if (annualMinor >= year) return null;
  return Math.floor(((year - annualMinor) / year) * 100);
}

/** YYYY-MM-DD in Lima, `days` after `now`. */
export function limaDatePlus(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000 - 5 * 3_600_000).toISOString().slice(0, 10);
}

/** "22 de octubre de 2027": a billing date (ISO timestamp) in Lima, with the year (annual renewals). */
export function billingDate(iso: string): string {
  const d = new Date(Date.parse(iso) - 5 * 3_600_000).toISOString().slice(0, 10);
  const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `${Number(d.slice(8, 10))} de ${months[Number(d.slice(5, 7)) - 1]} de ${d.slice(0, 4)}`;
}

/**
 * What Ajustes → Plan y uso says about a paid plan (pure; the dates are the provider's, stored by SQL).
 * `until` is the last moment with Plus when nothing else is charged; `nextCharge` the date + amount of the next one.
 */
export interface PaidPlanView {
  plan: PlanCode;
  phase: 'trial' | 'active' | 'past_due' | 'ending' | 'lifetime';
  until: string | null;
  nextCharge: { at: string; amountMinor: number } | null;
  canCancel: boolean;
}

export function paidPlanView(sub: {
  status: string; billing_plan: string | null; trial_ends_at: string | null; current_period_end: string | null;
  cancel_at_period_end: boolean | null; billing_amount_minor: number | string | null; provider_ref: string | null;
} | null): PaidPlanView | null {
  if (!sub || !isPlanCode(sub.billing_plan)) return null;
  if (sub.billing_plan === 'lifetime') return sub.status === 'active' ? { plan: 'lifetime', phase: 'lifetime', until: null, nextCharge: null, canCancel: false } : null;
  if (!['trialing', 'active', 'past_due'].includes(sub.status)) return null;
  const trial = sub.status === 'trialing';
  const end = trial ? sub.trial_ends_at : sub.current_period_end;
  const amount = Number(sub.billing_amount_minor);
  const cancel = sub.cancel_at_period_end === true;
  return {
    plan: sub.billing_plan,
    phase: cancel ? 'ending' : trial ? 'trial' : sub.status === 'past_due' ? 'past_due' : 'active',
    until: end,
    nextCharge: !cancel && sub.status !== 'past_due' && end && Number.isSafeInteger(amount) && amount > 0 ? { at: end, amountMinor: amount } : null,
    canCancel: !cancel && !!sub.provider_ref,
  };
}
