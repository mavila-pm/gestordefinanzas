'use server';

import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { ref } from '../../../lib/idempotency';
import { createSupabaseServerClient, authUser } from '../../../lib/supabase/server';
import { parseAmountToMinor } from '../../../src/domain/money';
import { limaDatePlus } from '../../../src/domain/billing';
import { errorText, isUuid } from '../../../src/web/transaction-input';
import { accountsJson, cardJson, MONEY_SOURCE_ERRORS, parseAccounts, parseMoneySourceForm } from '../../../src/web/money-source-input';
import type { ActionState } from '../actions';

/**
 * Cuentas y tarjetas writes (ADR-0020). Each one re-validates the session and the payload, then calls a SECURITY
 * INVOKER function or inserts under RLS (own rows only). Balances are never edited: "actualizar saldo" appends a new
 * checkpoint. Idempotent per submission (client_ref).
 */
async function session() {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  return { supabase, user };
}
const text = (code: string | null | undefined) => (code && MONEY_SOURCE_ERRORS[code]) || errorText(code ?? null);
const done = (message: string): ActionState => { revalidatePath('/app', 'layout'); return { message }; };
const submissionRef = (form: FormData) => ref(form) ?? randomUUID();

export async function saveCardAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseMoneySourceForm((k) => form.get(k), limaDatePlus(new Date(), 0));
  if (!parsed.ok) return { error: text(parsed.error) };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { card, accounts } = parsed.value;
  const { data, error } = await supabase.rpc('save_money_source', {
    p_client_ref: submissionRef(form), p_card: cardJson(card), p_card_id: null, p_accounts: accountsJson(accounts),
  });
  if (error) return { error: text(error.code === '23505' ? 'duplicate_card' : error.message) };
  const cardId = (data as { card_id?: string } | null)?.card_id;
  // Past unlinked movements with these digits are linked in the database (only when this card is unambiguous).
  if (cardId) await supabase.rpc('link_card_history', { p_card_id: cardId });
  const n = accounts.length;
  return done(card.kind === 'debit' && n ? `Tarjeta registrada con ${n === 1 ? '1 cuenta' : `${n} cuentas`}.` : 'Tarjeta registrada.');
}

export async function addCardAccountsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const cardId = form.get('cardId');
  if (!isUuid(cardId)) return { error: errorText('invalid_request') };
  const parsed = parseAccounts((k) => form.get(k));
  if (!parsed.ok) return { error: text(parsed.error) };
  if (parsed.value.length === 0) return { error: 'Escribe el nombre de la cuenta.' };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { error } = await supabase.rpc('save_money_source', {
    p_client_ref: submissionRef(form), p_card: null, p_card_id: cardId, p_accounts: accountsJson(parsed.value),
  });
  if (error) return { error: text(error.message) };
  return done(parsed.value.length === 1 ? 'Cuenta agregada.' : `${parsed.value.length} cuentas agregadas.`);
}

/** Blank is refused here (an unknown balance is simply not registered); "0" is a real 0. */
function amountField(v: FormDataEntryValue | null): number | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (/^0+([.,]0{1,2})?$/.test(s)) return 0;
  return s ? parseAmountToMinor(s) : null;
}

export async function setCashAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const currency = form.get('currency');
  const amount = amountField(form.get('amount'));
  if ((currency !== 'PEN' && currency !== 'USD') || amount === null) return { error: 'Escribe cuánto tienes en efectivo, por ejemplo 150.' };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { error } = await supabase.rpc('set_cash_balance', { p_currency: currency, p_amount_minor: amount, p_client_ref: submissionRef(form) });
  if (error) return { error: text(error.message) };
  return done('Efectivo actualizado.');
}

/** "Actualizar saldo" of a bank account: a new checkpoint at this moment (the past is never rewritten). */
export async function adjustAccountBalanceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const accountId = form.get('accountId');
  const amount = amountField(form.get('amount'));
  if (!isUuid(accountId) || amount === null) return { error: 'Escribe el saldo que ves hoy en tu banco, por ejemplo 1500.' };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { data: acc } = await supabase.from('accounts').select('currency,kind').eq('id', accountId).maybeSingle();
  if (!acc) return { error: errorText('not_found') };
  const { count } = await supabase.from('account_balance_checkpoints').select('id', { count: 'exact', head: true }).eq('account_id', accountId);
  const { error } = await supabase.from('account_balance_checkpoints').insert({
    user_id: user.id, account_id: accountId, currency: acc.currency, amount_minor: amount, source: count ? 'adjustment' : 'opening', client_ref: submissionRef(form),
  });
  if (error && !(error.code === '23505' && /client_ref/.test(error.message))) return { error: errorText(null) };
  return done('Saldo actualizado.');
}

/** "Actualizar línea usada" of a credit card: a new used checkpoint (what the bank app shows today). */
export async function adjustCardUsedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const cardId = form.get('cardId');
  const amount = amountField(form.get('amount'));
  if (!isUuid(cardId) || amount === null) return { error: 'Escribe cuánto de la línea tienes usado hoy, por ejemplo 1200.' };
  const { supabase, user } = await session();
  if (!user) return { error: errorText('not_authenticated') };
  const { data: card } = await supabase.from('cards').select('currency,kind,credit_limit_minor').eq('id', cardId).maybeSingle();
  if (!card || card.kind !== 'credit') return { error: errorText('not_found') };
  if (card.credit_limit_minor !== null && amount > Number(card.credit_limit_minor)) return { error: MONEY_SOURCE_ERRORS.used_over_limit };
  const { count } = await supabase.from('card_used_checkpoints').select('id', { count: 'exact', head: true }).eq('card_id', cardId);
  const { error } = await supabase.from('card_used_checkpoints').insert({
    user_id: user.id, card_id: cardId, currency: card.currency, used_minor: amount, source: count ? 'adjustment' : 'opening', client_ref: submissionRef(form),
  });
  if (error && !(error.code === '23505' && /client_ref/.test(error.message))) return { error: errorText(null) };
  return done('Línea usada actualizada.');
}
