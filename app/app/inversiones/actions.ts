'use server';

import { revalidatePath } from 'next/cache';
import { ref } from '../../../lib/idempotency';
import { createSupabaseServerClient, authUser } from '../../../lib/supabase/server';
import { parseAmountToMinor } from '../../../src/domain/money';
import { limaDatePlus } from '../../../src/domain/billing';
import { INVESTMENT_KINDS } from '../../../src/engine/investments';
import { errorText, isUuid } from '../../../src/web/transaction-input';
import type { ActionState } from '../actions';

/**
 * Inversiones writes (migration 059): under RLS, own rows only; entries are append-only (a new valuation, never an
 * edit). Velsuno only records what the person says — it never fetches prices or advises.
 */
async function session() {
  const supabase = await createSupabaseServerClient();
  return { supabase, user: await authUser(supabase) };
}
const done = (message: string): ActionState => { revalidatePath('/app', 'layout'); return { message }; };
const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v.trim() : '');
/** Blank = not said (null); "0" is a real 0; otherwise a valid amount. undefined = invalid. */
function amount(v: FormDataEntryValue | null): number | null | undefined {
  const s = str(v);
  if (!s) return null;
  if (/^0+([.,]0{1,2})?$/.test(s)) return 0;
  return parseAmountToMinor(s) ?? undefined;
}
const today = () => limaDatePlus(new Date(), 0);
function date(v: FormDataEntryValue | null): string | null {
  const s = str(v) || today();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && s <= today() ? s : null;
}
const hasPan = (s: string) => /\d{9,}/.test(s.replace(/[\s-]/g, ''));

export async function createInvestmentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const name = str(form.get('name'));
  const kind = str(form.get('kind'));
  const currency = form.get('currency');
  const institution = str(form.get('institution'));
  const rateRaw = str(form.get('rate')).replace(',', '.');
  const contributed = amount(form.get('contributed'));
  const value = amount(form.get('value'));
  if (!name || name.length > 60 || hasPan(name)) return { error: 'Ponle un nombre (hasta 60 caracteres, sin números de cuenta).' };
  if (!(INVESTMENT_KINDS as readonly string[]).includes(kind)) return { error: 'Elige el tipo de inversión.' };
  if (currency !== 'PEN' && currency !== 'USD') return { error: errorText('invalid_currency') };
  if (institution.length > 40 || /\d{5,}/.test(institution.replace(/[\s-]/g, ''))) return { error: 'Revisa dónde la tienes (hasta 40 letras).' };
  const rate = rateRaw ? Number(rateRaw) : null;
  if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1000)) return { error: 'La tasa va de 0 a 1000 %.' };
  if (contributed === undefined || value === undefined || contributed === 0) return { error: 'Revisa los montos: por ejemplo 2000 o 2000.50.' };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const clientRef = ref(form);
  const { data, error } = await supabase.from('investments').insert({
    user_id: user.id, name, kind, currency, institution: institution || null, annual_rate_bp: rate === null ? null : Math.round(rate * 100), client_ref: clientRef,
  }).select('id').single();
  if (error?.code === '23505' && /client_ref/.test(error.message)) return done('Inversión registrada.');
  if (error || !data) return { error: error?.message === 'investment_limit' ? 'Llegaste al máximo de 50 inversiones activas.' : errorText(null) };
  const entries = [
    ...(contributed !== null ? [{ kind: 'contribution', amount_minor: contributed }] : []),
    ...(value !== null ? [{ kind: 'valuation', amount_minor: value }] : []),
  ].map((e, i) => ({ ...e, user_id: user.id, investment_id: data.id, on_date: today(), client_ref: clientRef ? `${clientRef}:e${i}` : null }));
  if (entries.length) {
    const { error: e2 } = await supabase.from('investment_entries').insert(entries);
    if (e2) return { error: 'La inversión quedó registrada, pero no sus montos. Agrégalos desde su ficha.' };
  }
  return done('Inversión registrada.');
}

export async function addInvestmentEntryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('investmentId');
  const kind = str(form.get('kind'));
  const value = amount(form.get('amount'));
  const on = date(form.get('date'));
  if (!isUuid(id) || !['contribution', 'withdrawal', 'valuation'].includes(kind)) return { error: errorText('invalid_request') };
  if (value === null || value === undefined || (value === 0 && kind !== 'valuation')) return { error: 'Escribe el monto, por ejemplo 500.' };
  if (!on) return { error: 'Revisa la fecha: no puede ser futura.' };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { error } = await supabase.from('investment_entries').insert({ user_id: user.id, investment_id: id, kind, amount_minor: value, on_date: on, client_ref: ref(form) });
  if (error?.code === '23505' && /client_ref/.test(error.message)) return done('Guardado.');
  if (error) return { error: error.message === 'withdrawal_over_contributed' ? 'No puedes retirar más de lo que aportaste.' : errorText(null) };
  return done(kind === 'valuation' ? 'Valor actualizado.' : kind === 'contribution' ? 'Aporte registrado.' : 'Retiro registrado.');
}

export async function archiveInvestmentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('investmentId');
  if (!isUuid(id)) return { error: errorText('invalid_request') };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { data, error } = await supabase.from('investments').update({ active: false, updated_at: new Date().toISOString() }).eq('id', id).select('id');
  if (error || !data?.length) return { error: errorText(error ? null : 'not_found') };
  return done('Inversión archivada. Su historial se conserva.');
}
