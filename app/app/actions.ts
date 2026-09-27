'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase/server';
import { toLimaIso } from '../../src/ingestion/lima-time';
import { ingestRawEvent } from '../../src/engine/ingest';
import { loadUserContext } from '../../lib/queries';
import { SupabaseImportRepository } from '../../src/infrastructure/supabase/import-repository';
import { parseImportForm, importOutcomeText } from '../../src/web/import-input';
import {
  errorText, isUuid, parseAccountForm, parseCardForm, parseCorrectionForm, parseManualForm, parseReviewForm, type CorrectableState,
} from '../../src/web/transaction-input';

export interface ActionState {
  error?: string;
  message?: string;
}

/**
 * Server-side write layer. Every action: (1) re-validates the session, (2) validates the payload,
 * (3) calls a database function that validates again and enforces ownership (other users' rows answer
 * not_found), with RLS as the last barrier. The service role is never used.
 */
async function session() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return { supabase, user };
}

/** Database functions raise stable codes as the message; anything else maps to a generic text. */
const dbError = (e: { message?: string } | null) => ({ error: errorText(e?.message) });

function done(message?: string): ActionState {
  revalidatePath('/app', 'layout');
  return message ? { message } : {};
}

export async function reviewAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseReviewForm((k) => form.get(k));
  if (!parsed.ok) return { error: errorText(parsed.error) };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { error } = await supabase.rpc('review_transaction', { p_id: parsed.value.id, p_action: parsed.value.action });
  if (error) return dbError(error);
  return done(parsed.value.action === 'confirm' ? 'Movimiento confirmado.' : 'Movimiento ignorado.');
}

export async function correctAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  if (!isUuid(id)) return { error: errorText('invalid_request') };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  // Diff against the CURRENT row read under RLS (never against values posted by the browser).
  const { data: row } = await supabase
    .from('transactions')
    .select('type,amount_minor,currency,occurred_at,merchant_raw,category_id,card_id,account_id')
    .eq('id', id)
    .maybeSingle();
  if (!row) return { error: errorText('not_found') };
  const current: CorrectableState = {
    type: row.type, amountMinor: Number(row.amount_minor), currency: row.currency, occurredAt: toLimaIso(new Date(row.occurred_at)),
    merchantRaw: row.merchant_raw, categoryId: row.category_id, cardId: row.card_id, accountId: row.account_id,
  };
  const parsed = parseCorrectionForm((k) => form.get(k), current);
  if (!parsed.ok) return { error: errorText(parsed.error) };
  const { changes, confirm, rememberRule } = parsed.value;
  if (Object.keys(changes).length === 0 && !confirm && !rememberRule) return { message: 'No había cambios que guardar.' };
  const { error } = await supabase.rpc('correct_transaction', { p_id: id, p_changes: changes, p_confirm: confirm, p_remember_rule: rememberRule });
  if (error) return dbError(error);
  const saved = confirm ? 'Cambios guardados y movimiento confirmado.' : 'Cambios guardados.';
  return done(rememberRule ? `${saved} Los próximos movimientos de este comercio usarán esta categoría.` : saved);
}

export async function createManualAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseManualForm((k) => form.get(k));
  if (!parsed.ok) return { error: errorText(parsed.error) };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const v = parsed.value;
  const { error } = await supabase.rpc('create_manual_transaction', {
    p_client_ref: v.clientRef, p_type: v.type, p_amount_minor: v.amountMinor, p_currency: v.currency, p_occurred_at: v.occurredAt,
    p_description: v.description, p_description_normalized: v.descriptionNormalized,
    p_category_id: v.categoryId, p_card_id: v.cardId, p_account_id: v.accountId,
  });
  if (error) return dbError(error);
  revalidatePath('/app', 'layout');
  redirect('/app/movimientos/nuevo?ok=1');
}

export async function createCardAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseCardForm((k) => form.get(k));
  if (!parsed.ok) return { error: errorText(parsed.error) };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const c = parsed.value;
  // Cards are user-owned rows protected by RLS (user_id must equal the session user).
  const { error } = await supabase.from('cards').insert({
    user_id: user.id, alias: c.alias, institution_code: c.institution, kind: c.kind, currency: c.currency, last4: c.last4,
  });
  if (error) return { error: errorText(error.code === '23505' ? 'duplicate_card' : null) };
  const back = form.get('back');
  if (typeof back === 'string' && isUuid(back)) {
    revalidatePath('/app', 'layout');
    redirect(`/app/movimientos/${back}`);
  }
  return done('Tarjeta registrada.');
}

export async function createAccountAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseAccountForm((k) => form.get(k));
  if (!parsed.ok) return { error: errorText(parsed.error) };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const a = parsed.value;
  // Accounts are user-owned rows protected by RLS (user_id must equal the session user).
  const { error } = await supabase.from('accounts').insert({
    user_id: user.id, alias: a.alias, institution_code: a.institution, currency: a.currency, last4: a.last4,
  });
  if (error) return { error: errorText(error.code === '23505' ? 'duplicate_account' : null) };
  return done('Cuenta registrada.');
}

/** Cards and accounts are deactivated, never deleted: past movements keep pointing to them. */
export async function deactivateAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  const kind = form.get('kind');
  if (!isUuid(id) || (kind !== 'card' && kind !== 'account')) return { error: errorText('invalid_request') };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { data, error } = await supabase.from(kind === 'card' ? 'cards' : 'accounts').update({ active: false }).eq('id', id).select('id');
  if (error || !data?.length) return { error: errorText(error ? null : 'not_found') };
  return done(kind === 'card' ? 'Tarjeta desactivada.' : 'Cuenta desactivada.');
}

export async function deleteRuleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  if (!isUuid(id)) return { error: errorText('invalid_request') };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { data, error } = await supabase.from('merchant_rules').delete().eq('id', id).select('id');
  if (error || !data?.length) return { error: errorText(error ? null : 'not_found') };
  return done('Regla eliminada. Los movimientos ya registrados no cambian.');
}

export async function deleteTransactionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  if (!isUuid(id) || form.get('confirmDelete') !== '1') return { error: 'Marca la casilla para confirmar la eliminación.' };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { error } = await supabase.rpc('delete_manual_transaction', { p_id: id });
  if (error) return dbError(error);
  revalidatePath('/app', 'layout');
  redirect('/app?deleted=1');
}

export interface ImportState extends ActionState { transactionId?: string | null; outcome?: string }

/**
 * Pasted bank notification -> the SAME pipeline as automatic sources (adapter, dedupe, category, confidence),
 * persisted as channel 'import' and always sent to review. The pasted text is not stored (spec §33).
 */
export async function importAction(_prev: ImportState, form: FormData): Promise<ImportState> {
  const parsed = parseImportForm((k) => form.get(k));
  if (!parsed.ok) return { error: errorText(parsed.error) };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  try {
    const ctx = await loadUserContext(supabase, user.id);
    const result = await ingestRawEvent(parsed.value, ctx, new SupabaseImportRepository(supabase), undefined, { persistAs: 'import' });
    revalidatePath('/app', 'layout');
    const text = importOutcomeText(result.outcome);
    return { ...(text.ok ? { message: text.text } : { error: text.text }), transactionId: result.transactionId, outcome: result.outcome };
  } catch (e) {
    console.warn(JSON.stringify({ event: 'import_failed', message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' }));
    return { error: errorText(null) };
  }
}

export async function saveProfileAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const raw = form.get('displayName');
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (name.length > 80 || /[\u0000-\u001f\u007f<>]/.test(name)) return { error: 'Nombre inválido (máximo 80 caracteres).' };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  // profiles is user-owned under RLS (user_id must equal the session user).
  const { error } = await supabase.from('profiles').upsert({ user_id: user.id, display_name: name || null, updated_at: new Date().toISOString() });
  if (error) return { error: errorText(null) };
  return done('Guardado.');
}

export async function rotateAddressAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  // The random part is generated in the database (rotate_email_connection); the old address stops working.
  const { error } = await supabase.rpc('rotate_email_connection');
  if (error) return dbError(error);
  return done('Nueva dirección generada. La anterior dejó de recibir correos.');
}
