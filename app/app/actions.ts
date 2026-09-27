'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase/server';
import { toLimaIso } from '../../src/ingestion/lima-time';
import {
  errorText, isUuid, parseCardForm, parseCorrectionForm, parseManualForm, parseReviewForm, type CorrectableState,
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
  const { changes, confirm } = parsed.value;
  if (Object.keys(changes).length === 0 && !confirm) return { message: 'No había cambios que guardar.' };
  const { error } = await supabase.rpc('correct_transaction', { p_id: id, p_changes: changes, p_confirm: confirm });
  if (error) return dbError(error);
  return done(confirm ? 'Cambios guardados y movimiento confirmado.' : 'Cambios guardados.');
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
  if (error) return { error: errorText(null) };
  const back = form.get('back');
  if (typeof back === 'string' && isUuid(back)) {
    revalidatePath('/app', 'layout');
    redirect(`/app/movimientos/${back}`);
  }
  return done('Tarjeta registrada.');
}
