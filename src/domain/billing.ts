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
