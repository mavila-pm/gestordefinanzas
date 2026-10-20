import type { SupabaseClient } from '@supabase/supabase-js';
import { financialEffect } from '../src/domain/financial-effect';
import type { TransactionType } from '../src/domain/types';
import { isUuid } from '../src/web/transaction-input';
import { logLearning } from './learning';

/**
 * The one settle path (ADR-0017): every way of saying "this movement paid that" (Dinero disponible, Próximos pagos,
 * Vels buttons) goes through here. The rules are checked on the server with the person's session (RLS) and again by
 * the SQL guard (migration 051), so a button built from client JSON can never settle with a movement that cannot pay:
 *   confirmed only · an income never pays a bill · PEN ≠ USD · one movement settles at most one item (unique index).
 */
export type SettleError = 'invalid' | 'not_payment' | 'not_income' | 'duplicate' | 'failed';
export type SettleResult = { ok: true } | { ok: false; error: SettleError };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const INCOME_PERIOD = /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/;

function fromDb(code: string | undefined, rule: 'not_payment' | 'not_income'): SettleResult {
  return { ok: false, error: code === '23505' ? 'duplicate' : code === '23514' ? rule : 'failed' };
}

/** "Sí, es ese": a real outgoing movement settles one occurrence of a planned payment. */
export async function settleObligation(
  supabase: SupabaseClient, userId: string, input: { obligationId: unknown; transactionId: unknown; period: unknown },
): Promise<SettleResult> {
  const { obligationId, transactionId, period } = input;
  if (!isUuid(obligationId) || !isUuid(transactionId) || typeof period !== 'string' || !MONTH.test(period)) return { ok: false, error: 'invalid' };
  const [{ data: tx }, { data: ob }] = await Promise.all([
    supabase.from('transactions').select('type,status,currency,direction').eq('id', transactionId).maybeSingle(),
    supabase.from('fixed_expenses').select('currency').eq('id', obligationId).maybeSingle(),
  ]);
  if (!tx || !ob || tx.status !== 'confirmed' || tx.direction !== 'outflow' || tx.currency !== ob.currency || financialEffect(tx.type as TransactionType) === 'income') {
    return { ok: false, error: 'not_payment' };
  }
  const { error } = await supabase.from('plan_settlements').insert({ user_id: userId, fixed_expense_id: obligationId, period, transaction_id: transactionId });
  if (error) return fromDb(error.code, 'not_payment');
  await logLearning(supabase, userId, 'settlement', 'accepted', obligationId, { period, transactionId });
  return { ok: true };
}

/** "Sí, es ese" on a deposit: a confirmed income movement in the same currency settles one expected income. */
export async function settleIncome(
  supabase: SupabaseClient, userId: string, input: { incomeId: unknown; transactionId: unknown; period: unknown },
): Promise<SettleResult> {
  const { incomeId, transactionId, period } = input;
  if (!isUuid(incomeId) || !isUuid(transactionId) || typeof period !== 'string' || !INCOME_PERIOD.test(period)) return { ok: false, error: 'invalid' };
  const [{ data: tx }, { data: inc }] = await Promise.all([
    supabase.from('transactions').select('type,status,currency').eq('id', transactionId).maybeSingle(),
    supabase.from('expected_incomes').select('currency').eq('id', incomeId).maybeSingle(),
  ]);
  if (!tx || !inc || tx.type !== 'income' || tx.status !== 'confirmed' || tx.currency !== inc.currency) return { ok: false, error: 'not_income' };
  const { error } = await supabase.from('plan_settlements').insert({ user_id: userId, expected_income_id: incomeId, period, transaction_id: transactionId });
  if (error) return fromDb(error.code, 'not_income');
  await logLearning(supabase, userId, 'income', 'accepted', incomeId, { period, transactionId });
  return { ok: true };
}
