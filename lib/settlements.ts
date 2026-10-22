import type { SupabaseClient } from '@supabase/supabase-js';
import { financialEffect } from '../src/domain/financial-effect';
import type { Currency } from '../src/domain/money';
import type { TransactionType } from '../src/domain/types';
import { abonosByOccurrence, remainingMinor, settlementStatus } from '../src/engine/planning';
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
/** remainingMinor: what the occurrence still owes after this abono (null = unknown price; 0 once closed). */
export type ObligationSettleResult = { ok: true; status: 'paid' | 'partial'; remainingMinor: number | null; currency: Currency } | { ok: false; error: SettleError };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const INCOME_PERIOD = /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/;

function fromDb(code: string | undefined, rule: 'not_payment' | 'not_income'): { ok: false; error: SettleError } {
  return { ok: false, error: code === '23505' ? 'duplicate' : code === '23514' ? rule : 'failed' };
}

/**
 * "Sí, es ese" / "Pago completo" (mode 'full') or "Fue un abono" (mode 'partial'): a real outgoing movement settles
 * one occurrence of a planned payment, or adds an abono to it. The status comes from the REAL amounts read here
 * (this movement + earlier abonos vs the planned amount), never from the request (settlementStatus, ADR-0017).
 */
export async function settleObligation(
  supabase: SupabaseClient, userId: string, input: { obligationId: unknown; transactionId: unknown; period: unknown; mode?: unknown },
): Promise<ObligationSettleResult> {
  const { obligationId, transactionId, period } = input;
  const mode = input.mode === 'partial' ? 'partial' : 'full';
  if (!isUuid(obligationId) || !isUuid(transactionId) || typeof period !== 'string' || !MONTH.test(period)) return { ok: false, error: 'invalid' };
  const [{ data: tx }, { data: ob }, { data: prior }] = await Promise.all([
    supabase.from('transactions').select('type,status,currency,direction,amount_minor').eq('id', transactionId).maybeSingle(),
    supabase.from('fixed_expenses').select('currency,amount_minor,amount_status').eq('id', obligationId).maybeSingle(),
    supabase.from('plan_settlements').select('status,tx:transactions(amount_minor,currency,status)').eq('fixed_expense_id', obligationId).eq('period', period).limit(50),
  ]);
  if (!tx || !ob || tx.status !== 'confirmed' || tx.direction !== 'outflow' || tx.currency !== ob.currency || financialEffect(tx.type as TransactionType) === 'income') {
    return { ok: false, error: 'not_payment' };
  }
  const rows = ((prior ?? []) as unknown as Array<{ status: 'paid' | 'partial' | 'skipped'; tx: { amount_minor: number; currency: Currency; status: string } | null }>);
  if (rows.some((r) => r.status !== 'partial')) return { ok: false, error: 'duplicate' }; // already closed (the SQL guard says the same)
  const currency = ob.currency as Currency;
  const planned = ob.amount_status === 'unknown' || ob.amount_minor === null ? null : Number(ob.amount_minor);
  const abonos = abonosByOccurrence(rows.map((r) => ({ obligationId, period, status: r.status, amountMinor: r.tx ? Number(r.tx.amount_minor) : null,
    currency: r.tx?.currency ?? null, txConfirmed: r.tx?.status === 'confirmed' })), new Map([[obligationId, currency]])).get(obligationId)?.get(period) ?? 0;
  const amount = Number(tx.amount_minor);
  const status = settlementStatus(mode, planned, abonos, amount);
  const { error } = await supabase.from('plan_settlements').insert({ user_id: userId, fixed_expense_id: obligationId, period, transaction_id: transactionId, status });
  if (error) return fromDb(error.code, 'not_payment');
  await logLearning(supabase, userId, 'settlement', 'accepted', obligationId, { period, transactionId, mode, status });
  return { ok: true, status, currency, remainingMinor: status === 'paid' ? 0 : remainingMinor(planned, abonos + amount) };
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
