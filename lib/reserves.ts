import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney, type Currency } from '../src/domain/money';
import type { Reserve } from '../src/engine/planning';
import { isUuid } from '../src/web/transaction-input';

/**
 * The one write path for Apartados (ADR-0017): the Dinero disponible sheets and the Vels confirmation buttons both
 * come here. Moving money in or out of an apartado is an internal allocation of the person's own money: it never
 * creates a transaction, an income or an expense, and never changes a balance snapshot. Amounts are parsed on the
 * server; the SQL guard (migration 053) has the last word on "never more out than saved" and archived apartados.
 */
export type ReserveMoveError = 'invalid' | 'not_found' | 'insufficient' | 'archived' | 'failed';
export type ReserveMoveResult =
  | { ok: true; name: string; currency: Currency; savedMinor: number }
  | { ok: false; error: ReserveMoveError; name?: string; currency?: Currency; savedMinor?: number };

const CLIENT_REF = /^[A-Za-z0-9:_-]{8,120}$/;
const MAX_MINOR = 100_000_000_000;

/** Active apartados per person: the SQL cap (migration 053, reserves_active_cap), so these reads never leave one out. */
export const MAX_ACTIVE_RESERVES = 50;

/** The two reads of active apartados and their balances (loadReserves and loadPlanningData share them). */
export function reserveReads(supabase: SupabaseClient) {
  return [
    supabase.from('reserves').select('id,name,currency,target_minor,target_date').eq('active', true).order('created_at').limit(MAX_ACTIVE_RESERVES),
    supabase.from('reserve_balances').select('reserve_id,saved_minor').eq('active', true).limit(MAX_ACTIVE_RESERVES),
  ] as const;
}

/** Active apartados with their saved amount (Σ in − Σ out of real entries), read under the person's RLS. */
export async function loadReserves(supabase: SupabaseClient): Promise<Reserve[]> {
  const [res, bal] = await Promise.all(reserveReads(supabase));
  return toReserves(res.data, bal.data);
}

/** Pure join of the two reads (the loader and loadPlanningData share it). A reserve without a balance row saved 0. */
export function toReserves(
  rows: ReadonlyArray<{ id: string; name: string; currency: string; target_minor: number | string | null; target_date: string | null }> | null,
  balances: ReadonlyArray<{ reserve_id: string; saved_minor: number | string }> | null,
): Reserve[] {
  const saved = new Map((balances ?? []).map((b) => [b.reserve_id, Number(b.saved_minor)]));
  return (rows ?? []).filter((r) => r.currency === 'PEN' || r.currency === 'USD').map((r) => ({
    id: r.id, name: r.name, currency: r.currency as Currency, savedMinor: saved.get(r.id) ?? 0,
    targetMinor: r.target_minor === null ? null : Number(r.target_minor), targetDate: r.target_date,
  }));
}

async function current(supabase: SupabaseClient, reserveId: string) {
  const [{ data: r }, { data: b }] = await Promise.all([
    supabase.from('reserves').select('name,currency,active').eq('id', reserveId).maybeSingle(),
    supabase.from('reserve_balances').select('saved_minor').eq('reserve_id', reserveId).maybeSingle(),
  ]);
  return r ? { name: r.name as string, currency: r.currency as Currency, active: r.active as boolean, savedMinor: Number(b?.saved_minor ?? 0) } : null;
}

/** "Apartar" (in) / "Usar" (out). A replay of the same submission (client_ref) answers success without a second row. */
export async function moveReserve(
  supabase: SupabaseClient, userId: string, input: { reserveId: unknown; direction: unknown; amountMinor: unknown; clientRef?: string | null },
): Promise<ReserveMoveResult> {
  const { reserveId, direction, amountMinor } = input;
  if (!isUuid(reserveId) || (direction !== 'in' && direction !== 'out') || typeof amountMinor !== 'number'
    || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_MINOR) return { ok: false, error: 'invalid' };
  const clientRef = input.clientRef && CLIENT_REF.test(input.clientRef) ? input.clientRef : null;
  const before = await current(supabase, reserveId);
  if (!before) return { ok: false, error: 'not_found' };
  if (!before.active) return { ok: false, error: 'archived', name: before.name, currency: before.currency };
  if (direction === 'out' && amountMinor > before.savedMinor) return { ok: false, error: 'insufficient', name: before.name, currency: before.currency, savedMinor: before.savedMinor };
  const { error } = await supabase.from('reserve_entries').insert({ user_id: userId, reserve_id: reserveId, direction, amount_minor: amountMinor, client_ref: clientRef });
  const replay = !!error && error.code === '23505' && /_client_ref/.test(`${error.message} ${error.details ?? ''}`);
  if (error && !replay) {
    if (error.code !== '23514') return { ok: false, error: 'failed' };
    // The guard refused it (another tab took money out meanwhile, or it was archived): say what is there now.
    const now = await current(supabase, reserveId);
    return { ok: false, error: now && !now.active ? 'archived' : 'insufficient', name: now?.name, currency: now?.currency, savedMinor: now?.savedMinor };
  }
  const after = await current(supabase, reserveId);
  return { ok: true, name: before.name, currency: before.currency, savedMinor: after?.savedMinor ?? before.savedMinor };
}

/** The person's words for a result (same copy for the sheets and Vels; amounts from the server, never the form). */
export function reserveMoveText(
  r: ReserveMoveResult, direction: 'in' | 'out', amountMinor: number,
  m: (v: number, c: Currency) => string = (v, c) => formatMoney({ amountMinor: v, currency: c }),
): { message: string } | { error: string } {
  if (r.ok) {
    return { message: direction === 'in'
      ? `Apartaste ${m(amountMinor, r.currency)} para ${r.name}. Llevas ${m(r.savedMinor, r.currency)}.`
      : `Usaste ${m(amountMinor, r.currency)} de ${r.name}. Quedan ${m(r.savedMinor, r.currency)}.` };
  }
  if (r.error === 'insufficient' && r.name && r.currency) return { error: `Solo tienes ${m(r.savedMinor ?? 0, r.currency)} apartados en ${r.name}.` };
  if (r.error === 'archived') return { error: 'Ese apartado está archivado.' };
  return { error: 'No se guardó. Intenta de nuevo.' };
}
