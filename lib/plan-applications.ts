import type { SupabaseClient } from '@supabase/supabase-js';
import type { Currency } from '../src/domain/money';
import { linesToApply, sameAsSeen } from '../src/engine/applied';
import { planFor, type PlanningData } from './planning';

/** ADR-0013: saved plans (reservations), read and written under the person's session (RLS). */
export type ApplyResult = { ok: true; id: string; freeMinor: number; reservedMinor: number; until: string } | { ok: false; error: string };

/**
 * Recomputes the plan on the server and saves it. Refuses an incomplete plan (no balance or no next income) and,
 * when the caller says what the person saw, a plan that changed since (stale tab). Never trusts client amounts.
 */
export async function applyPlan(
  supabase: SupabaseClient, d: PlanningData,
  opts: { currency: Currency; base: 'balance' | { transactionId: string }; seen?: { freeMinor: number | null; reservedMinor: number | null }; ref: string | null },
): Promise<ApplyResult> {
  const p = planFor(d, opts.currency, opts.base);
  if (p.status === 'incomplete' || p.freeMinor === null || !p.until || !p.base) return { ok: false, error: 'Faltan datos para aplicar el plan: tu saldo y tu próximo ingreso.' };
  if (opts.seen && !sameAsSeen(p, opts.seen.freeMinor, opts.seen.reservedMinor)) return { ok: false, error: 'Tus datos cambiaron. Revisa el plan y vuelve a aplicarlo.' };
  const { data, error } = await supabase.rpc('apply_plan', {
    p_currency: opts.currency, p_base_kind: p.base.kind, p_base_minor: p.base.amountMinor,
    p_base_transaction_id: opts.base === 'balance' ? null : opts.base.transactionId,
    p_from: p.from, p_until: p.until, p_reserved_minor: p.reservedMinor, p_free_minor: p.freeMinor,
    p_plan_status: p.status, p_lines: linesToApply(p), p_client_ref: opts.ref,
  });
  if (error?.message?.includes('plan_closed')) return { ok: false, error: 'Ese plan ya no está activo. Pídeme uno nuevo si lo quieres.' };
  if (error || typeof data !== 'string') return { ok: false, error: 'No pudimos aplicar el plan. Intenta de nuevo.' };
  return { ok: true, id: data, freeMinor: p.freeMinor, reservedMinor: p.reservedMinor, until: p.until };
}
