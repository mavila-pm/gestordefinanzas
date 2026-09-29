import type { SupabaseClient } from '@supabase/supabase-js';
import type { Currency } from '../src/domain/money';
import { linesToApply, sameAsSeen, validAppliedLines, type AppliedPlan } from '../src/engine/applied';
import { planFor, type PlanningData } from './planning';

/** ADR-0013: saved plans (reservations), read and written under the person's session (RLS). */
const SELECT = 'id,currency,status,base_kind,base_minor,from_date,until_date,reserved_minor,free_minor,plan_status,lines,created_at,closed_at';

function toApplied(r: Record<string, unknown>): AppliedPlan {
  return {
    id: r.id as string, currency: r.currency as Currency, status: r.status as AppliedPlan['status'], baseKind: r.base_kind as AppliedPlan['baseKind'],
    baseMinor: Number(r.base_minor), fromDate: r.from_date as string, untilDate: r.until_date as string, reservedMinor: Number(r.reserved_minor),
    freeMinor: Number(r.free_minor), planStatus: r.plan_status as AppliedPlan['planStatus'], lines: validAppliedLines(r.lines),
    createdAt: r.created_at as string, closedAt: (r.closed_at as string | null) ?? null,
  };
}

/** Active plan per currency + the latest history (superseded / cancelled), newest first. */
export async function loadApplied(supabase: SupabaseClient): Promise<{ active: Partial<Record<Currency, AppliedPlan>>; history: AppliedPlan[] }> {
  const { data } = await supabase.from('plan_applications').select(SELECT).order('created_at', { ascending: false }).limit(12);
  const all = (data ?? []).map(toApplied);
  const active: Partial<Record<Currency, AppliedPlan>> = {};
  for (const p of all) if (p.status === 'active' && !active[p.currency]) active[p.currency] = p;
  return { active, history: all.filter((p) => p.status !== 'active').slice(0, 6) };
}

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

/** Quitar plan: closes the active one (kept as history). Nothing else changes. */
export async function cancelApplied(supabase: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await supabase.from('plan_applications').update({ status: 'cancelled', closed_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'active').select('id');
  return !error && (data?.length ?? 0) === 1;
}
