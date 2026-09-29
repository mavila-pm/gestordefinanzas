'use server';

import { validStatement } from '../../src/engine/cards';
import { revalidatePath } from 'next/cache';
import { logLearning } from '../../lib/learning';
import { isReplay, ref } from '../../lib/idempotency';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient, authUser } from '../../lib/supabase/server';
import { toLimaIso } from '../../src/ingestion/lima-time';
import { parseAmountToMinor } from '../../src/domain/money';
import { SPLIT_ERROR_TEXT } from '../../src/domain/allocations';
import { parseProfileForm } from '../../src/domain/profile';
import { ingestRawEvent } from '../../src/engine/ingest';
import { loadUserContext } from '../../lib/queries';
import { SupabaseImportRepository } from '../../src/infrastructure/supabase/import-repository';
import { parseImportForm, importOutcomeText } from '../../src/web/import-input';
import {
  errorText, isUuid, parseAccountForm, parseCardCycleForm, parseCardStatementForm, parseCardForm, parseSplitForm, parseDebtForm, parseFixedExpenseForm, parseCorrectionForm, parseManualForm, parseReviewForm, type CorrectableState,
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
  const user = await authUser(supabase);
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
  // Confirming changes the screen (the movement leaves review): show the result on the reloaded detail.
  if (confirm) { revalidatePath('/app', 'layout'); redirect(`/app/movimientos/${id}?ok=${rememberRule ? 'rule' : 'confirmed'}`); }
  return done(rememberRule ? 'Cambios guardados. Los próximos movimientos de este comercio usarán esta categoría.' : 'Cambios guardados.');
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
  const { data: card, error } = await supabase.from('cards').insert({
    user_id: user.id, alias: c.alias, institution_code: c.institution, kind: c.kind, currency: c.currency, last4: c.last4,
  }).select('id').single();
  if (error || !card) return { error: errorText(error?.code === '23505' ? 'duplicate_card' : null) };
  // Past unlinked movements with these digits are linked in the database (only when this card is unambiguous; audited).
  const { data: linked } = await supabase.rpc('link_card_history', { p_card_id: card.id });
  const back = form.get('back');
  if (typeof back === 'string' && isUuid(back)) {
    revalidatePath('/app', 'layout');
    redirect(`/app/movimientos/${back}`);
  }
  return done(typeof linked === 'number' && linked > 0 ? `Tarjeta registrada. ${linked} movimiento(s) asociados.` : 'Tarjeta registrada.');
}

export async function createAccountAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseAccountForm((k) => form.get(k));
  if (!parsed.ok) return { error: errorText(parsed.error) };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const a = parsed.value;
  // Accounts are user-owned rows protected by RLS (user_id must equal the session user).
  const { error } = await supabase.from('accounts').insert({
    user_id: user.id, alias: a.alias, institution_code: a.institution, currency: a.currency, last4: a.last4, client_ref: ref(form),
  });
  if (isReplay(error)) return done('Cuenta registrada.');
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
  const { data, error } = await supabase.from('merchant_rules').delete().eq('id', id).select('id,contains');
  if (error || !data?.length) return { error: errorText(error ? null : 'not_found') };
  await logLearning(supabase, user.id, 'rule', 'deleted', id, { contains: data[0]!.contains });
  return done('Olvidado. Tus movimientos no cambian.');
}

/** Change the category Velsuno remembers for a merchant (RLS + policy check: own rule, global or own category). */
export async function changeRuleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  const categoryId = form.get('categoryId');
  if (!isUuid(id) || !isUuid(categoryId)) return { error: errorText('invalid_request') };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { data, error } = await supabase.from('merchant_rules').update({ category_id: categoryId }).eq('id', id).select('id');
  if (error || !data?.length) return { error: 'No se guardó. Intenta de nuevo.' };
  await logLearning(supabase, user.id, 'rule', 'corrected', id, { categoryId });
  return done('Listo. Se usará en los próximos movimientos.');
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
  const parsed = parseProfileForm((k) => form.get(k));
  if (!parsed.ok) return { error: parsed.error };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const p = parsed.value;
  // profiles is user-owned under RLS (user_id must equal the session user). Names are presentation only.
  const { error } = await supabase.from('profiles').upsert({
    user_id: user.id, given_names: p.givenNames, family_names: p.familyNames, display_name: p.displayName, updated_at: new Date().toISOString(),
  });
  if (error) return { error: 'No pudimos guardar tus datos. Intenta de nuevo.' };
  return done(p.displayName ? `Listo, ${p.displayName}.` : 'Guardado.');
}

export async function rotateAddressAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  // The random part is generated in the database (rotate_email_connection); the old address stops working.
  const { error } = await supabase.rpc('rotate_email_connection');
  if (error) return dbError(error);
  return done('Nueva dirección generada. La anterior dejó de recibir correos.');
}

export async function saveBudgetAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const categoryId = form.get('categoryId');
  const currency = form.get('currency');
  const amount = parseAmountToMinor(typeof form.get('amount') === 'string' ? (form.get('amount') as string) : '');
  if (!isUuid(categoryId)) return { error: errorText('invalid_category') };
  if (currency !== 'PEN' && currency !== 'USD') return { error: errorText('invalid_currency') };
  if (amount === null || amount > 100_000_000_000) return { error: errorText('invalid_amount') };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  // RLS: own rows only and the category must be global or the user's own.
  const { error } = await supabase.from('budgets').upsert(
    { user_id: user.id, category_id: categoryId, currency, amount_minor: amount }, { onConflict: 'user_id,category_id,currency' });
  if (error) return { error: errorText(null) };
  return done('Presupuesto guardado.');
}

export async function deleteBudgetAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  if (!isUuid(id)) return { error: errorText('invalid_request') };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { data, error } = await supabase.from('budgets').delete().eq('id', id).select('id');
  if (error || !data?.length) return { error: errorText(error ? null : 'not_found') };
  return done('Presupuesto eliminado.');
}

export async function saveFixedExpenseAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseFixedExpenseForm((k) => form.get(k));
  if (!parsed.ok) return { error: errorText(parsed.error) };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const v = parsed.value;
  const { error } = await supabase.from('fixed_expenses').insert({
    user_id: user.id, name: v.name, currency: v.currency, amount_minor: v.amountMinor, due_day: v.dueDay, category_id: v.categoryId, client_ref: ref(form),
  });
  if (error && !isReplay(error)) return { error: errorText(null) };
  return done('Gasto fijo registrado.');
}

export async function saveDebtAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseDebtForm((k) => form.get(k));
  if (!parsed.ok) return { error: errorText(parsed.error) };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const v = parsed.value;
  const { error } = await supabase.from('debts').insert({
    user_id: user.id, name: v.name, lender: v.lender, currency: v.currency, principal_minor: v.principalMinor, balance_minor: v.balanceMinor,
    annual_rate_bp: v.annualRateBp, installment_minor: v.installmentMinor, installments_total: v.installmentsTotal,
    installments_paid: v.installmentsPaid, due_day: v.dueDay, client_ref: ref(form),
  });
  if (error && !isReplay(error)) return { error: errorText(null) };
  return done('Deuda registrada.');
}

/** Updates the debt balance only: the payment itself arrives (or is registered) as a movement, never twice. */
export async function debtPaymentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  const amount = parseAmountToMinor(typeof form.get('amount') === 'string' ? (form.get('amount') as string) : '');
  if (!isUuid(id)) return { error: errorText('invalid_request') };
  if (amount === null) return { error: errorText('invalid_amount') };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { data: d } = await supabase.from('debts').select('balance_minor,installments_paid,installments_total').eq('id', id).maybeSingle();
  if (!d) return { error: errorText('not_found') };
  const balance = Number(d.balance_minor);
  const paid = (d.installments_paid as number) + 1;
  const total = d.installments_total as number | null;
  // Optimistic concurrency: only applies if the balance did not change meanwhile.
  const { data, error } = await supabase.from('debts')
    .update({ balance_minor: Math.max(0, balance - amount), installments_paid: total === null ? paid : Math.min(paid, total), last_payment_on: new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10) })
    .eq('id', id).eq('balance_minor', balance).select('id');
  if (error || !data?.length) return { error: 'No se pudo registrar: el saldo cambió. Recarga e intenta de nuevo.' };
  return done('Pago registrado en la deuda. Recuerda que el movimiento del banco se registra aparte (no se duplica).');
}

export async function deactivateCommitmentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  const kind = form.get('kind');
  if (!isUuid(id) || (kind !== 'fixed' && kind !== 'debt')) return { error: errorText('invalid_request') };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { data, error } = await supabase.from(kind === 'fixed' ? 'fixed_expenses' : 'debts').update({ active: false }).eq('id', id).select('id');
  if (error || !data?.length) return { error: errorText(error ? null : 'not_found') };
  return done('Listo.');
}

export async function startTrialAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { error } = await supabase.rpc('start_plus_trial');
  if (error) return { error: error.message === 'trial_already_used' ? 'Ya usaste tu prueba de Plus.' : error.message === 'already_plus' ? 'Ya tienes Plus.' : errorText(null) };
  return done('Prueba de Plus activada. No se te cobrará nada: al terminar vuelves a Free automáticamente.');
}

/** Dividir gasto: replace the movement's allocations atomically (or remove them), with an optimistic version check. */
export async function splitAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  const version = form.get('version');
  if (typeof id !== 'string' || !isUuid(id) || typeof version !== 'string' || !version) return { error: SPLIT_ERROR_TEXT.unknown };
  const clear = form.get('clear') === '1';
  const parsed = clear ? { ok: true as const, value: [] } : parseSplitForm(form.get('parts'));
  if (!parsed.ok) return { error: SPLIT_ERROR_TEXT[parsed.error as keyof typeof SPLIT_ERROR_TEXT] ?? SPLIT_ERROR_TEXT.unknown };
  if (!clear && parsed.value.length === 0) return { error: SPLIT_ERROR_TEXT.no_parts };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { error } = await supabase.rpc('set_transaction_split', { p_tx_id: id, p_parts: parsed.value, p_expected_updated_at: version });
  if (error) {
    const known = error.message as keyof typeof SPLIT_ERROR_TEXT;
    return { error: SPLIT_ERROR_TEXT[known] ?? (error.message === 'not_found' ? SPLIT_ERROR_TEXT.not_splittable : SPLIT_ERROR_TEXT.unknown) };
  }
  revalidatePath(`/app/movimientos/${id}`);
  return done(clear ? 'División eliminada.' : 'División guardada.');
}

/** Card cycle for Vels (ADR-0011): bank limit + statement/payment days on the person's own credit card (RLS). */
export async function updateCardCycleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  const parsed = parseCardCycleForm((k) => form.get(k));
  if (!isUuid(id) || !parsed.ok) return { error: 'Revisa los días (1 al 31) y el monto.' };
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) return { error: errorText('not_authenticated') };
  const v = parsed.value;
  const { data, error } = await supabase.from('cards').update({ credit_limit_minor: v.creditLimitMinor, statement_day: v.statementDay, payment_day: v.paymentDay })
    .eq('id', id).eq('kind', 'credit').select('id');
  if (error || !data?.length) return { error: 'No se guardó. Intenta de nuevo.' };
  return done('Guardado.');
}

/** Card statement (ADR-0014): one per (card, cut date); saving again corrects it. Never invents amounts. */
export async function saveCardStatementAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  const parsed = parseCardStatementForm((k) => form.get(k));
  if (!isUuid(id) || !parsed.ok) return { error: 'Revisa las fechas y los montos.' };
  const v = parsed.value;
  const invalid = validStatement(v);
  if (invalid) return { error: invalid };
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) return { error: errorText('not_authenticated') };
  const { data: card } = await supabase.from('cards').select('id,currency,statement_day,payment_day').eq('id', id).eq('kind', 'credit').maybeSingle();
  if (!card) return { error: 'No encontramos esa tarjeta.' };
  const now = new Date().toISOString();
  // One statement per cut: an existing one is corrected (amounts/dates only); otherwise a new one is added.
  const fields = { due_date: v.dueDate, billed_minor: v.billedMinor, minimum_minor: v.minimumMinor, used_minor: v.usedMinor, used_as_of: v.usedMinor === null ? null : now, updated_at: now };
  const { data: existing } = await supabase.from('card_statements').select('id').eq('card_id', card.id).eq('cut_date', v.cutDate).maybeSingle();
  let { error } = existing
    ? await supabase.from('card_statements').update(fields).eq('id', existing.id)
    : await supabase.from('card_statements').insert({ ...fields, user_id: user.id, card_id: card.id, currency: card.currency, cut_date: v.cutDate, source: 'manual', status: 'confirmed', client_ref: ref(form) });
  // Two tabs saving the same cut at once: the second becomes a correction of the first.
  if (error?.code === '23505' && !existing) ({ error } = await supabase.from('card_statements').update(fields).eq('card_id', card.id).eq('cut_date', v.cutDate));
  if (error) return { error: 'No se guardó. Intenta de nuevo.' };
  // The statement also tells the cycle days when the card had none (never overwrites what the person set).
  if (card.statement_day === null || card.payment_day === null) {
    await supabase.from('cards').update({ statement_day: card.statement_day ?? Number(v.cutDate.slice(8)), payment_day: card.payment_day ?? Number(v.dueDate.slice(8)) }).eq('id', card.id);
  }
  return done('Estado de cuenta guardado.');
}
