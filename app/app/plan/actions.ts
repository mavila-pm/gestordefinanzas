'use server';

/**
 * Planning write actions (ADR-0005). Domain verbs a future conversational interface can call too:
 * recordBalance, saveObligation / patchObligation, saveIncome, saveSettings, markObligationPaid, resolveVariation.
 * RLS + composite FKs enforce ownership; nothing here creates or changes transactions.
 */
import { revalidatePath } from 'next/cache';
import { decide, logLearning } from '../../../lib/learning';
import { limaToday } from '../../../src/engine/planning';
import { createSupabaseServerClient, authUser } from '../../../lib/supabase/server';
import { parseBalanceForm, parseIncomeForm, parseObligationForm, parseSettingsForm } from '../../../src/web/planning-input';
import { isUuid } from '../../../src/web/transaction-input';
import type { ActionState } from '../actions';

const SAVE_ERROR = 'No pudimos guardar el cambio. Intenta de nuevo.';
async function session() {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  return { supabase, user };
}
function done(message: string): ActionState {
  revalidatePath('/app', 'layout');
  return { message };
}

export async function recordBalanceAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseBalanceForm((k) => form.get(k));
  if (!parsed.ok) return { error: parsed.error };
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  const { error } = await supabase.from('balance_snapshots').insert({ user_id: user.id, currency: parsed.value.currency, amount_minor: parsed.value.amountMinor });
  return error ? { error: SAVE_ERROR } : done('Saldo actualizado.');
}

export async function saveObligationAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseObligationForm((k) => form.get(k));
  if (!parsed.ok) return { error: parsed.error };
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  const v = parsed.value;
  const row = {
    user_id: user.id, name: v.name, kind: v.kind, currency: v.currency, amount_minor: v.amountMinor, amount_status: v.amountStatus,
    frequency: v.frequency, anchor_month: v.anchorMonth, due_day: v.dueDay, due_day_max: v.dueDayMax, target_day: v.targetDay,
    category_id: v.categoryId, updated_at: new Date().toISOString(),
  };
  const id = form.get('id');
  const { error } = isUuid(id)
    ? await supabase.from('fixed_expenses').update(row).eq('id', id)
    : await supabase.from('fixed_expenses').insert(row);
  return error ? { error: SAVE_ERROR } : done(isUuid(id) ? 'Pago actualizado.' : 'Pago agregado.');
}

/** Resolve one missing piece in context ("Falta el monto de Internet") without the full form. */
export async function patchObligationAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  if (!isUuid(id)) return { error: SAVE_ERROR };
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const amount = form.get('amount');
  if (typeof amount === 'string') {
    const { parseAmountToMinor } = await import('../../../src/domain/money');
    const minor = parseAmountToMinor(amount.trim());
    if (minor === null) return { error: 'Revisa el monto (por ejemplo 129.90).' };
    Object.assign(patch, { amount_minor: minor, amount_status: 'confirmed' });
  }
  const dueDay = form.get('dueDay');
  if (typeof dueDay === 'string') {
    const n = Number(dueDay);
    if (!/^\d{1,2}$/.test(dueDay) || n < 1 || n > 31) return { error: 'Elige un día del 1 al 31.' };
    Object.assign(patch, { due_day: n, due_day_max: null });
  }
  if (Object.keys(patch).length === 1) return { error: SAVE_ERROR };
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  // Keep the preferred payment day only if it is still before the (new) due day.
  const { data, error } = await supabase.from('fixed_expenses').update(patch).eq('id', id).select('target_day,due_day');
  if (error || !data?.length) return { error: SAVE_ERROR };
  const r = data[0]!;
  if (r.target_day && r.due_day && r.target_day > r.due_day) await supabase.from('fixed_expenses').update({ target_day: null }).eq('id', id);
  return done('Listo.');
}

export async function removeObligationAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  if (!isUuid(id)) return { error: SAVE_ERROR };
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  const { error } = await supabase.from('fixed_expenses').update({ active: false }).eq('id', id);
  return error ? { error: SAVE_ERROR } : done('Quitado. Lo ya pagado queda en tu historial.');
}

export async function saveIncomeAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseIncomeForm((k) => form.get(k));
  if (!parsed.ok) return { error: parsed.error };
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  const v = parsed.value;
  const row = { user_id: user.id, name: v.name, currency: v.currency, amount_minor: v.amountMinor, amount_status: v.amountStatus, frequency: v.frequency,
    day_of_month: v.dayOfMonth, day_max: v.dayMax, second_day: v.secondDay, anchor_date: v.anchorDate };
  const id = form.get('id');
  const { error } = isUuid(id) ? await supabase.from('expected_incomes').update(row).eq('id', id) : await supabase.from('expected_incomes').insert(row);
  return error ? { error: SAVE_ERROR } : done('Ingreso guardado. Solo lo usamos para saber hasta cuándo planificar.');
}

export async function removeIncomeAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  if (!isUuid(id)) return { error: SAVE_ERROR };
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  const { error } = await supabase.from('expected_incomes').update({ active: false }).eq('id', id);
  return error ? { error: SAVE_ERROR } : done('Ingreso quitado.');
}

export async function saveSettingsAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseSettingsForm((k) => form.get(k));
  if (!parsed.ok) return { error: parsed.error };
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  const v = parsed.value;
  const { data: before } = await supabase.from('planning_settings').select('allow_zero_for_debt').eq('currency', v.currency).maybeSingle();
  const { error } = await supabase.from('planning_settings').upsert({ user_id: user.id, currency: v.currency,
    essentials_monthly_minor: v.essentialsMonthlyMinor, cushion_minor: v.cushionMinor, allow_zero_for_debt: v.allowZeroForDebt, updated_at: new Date().toISOString() });
  if (error) return { error: SAVE_ERROR };
  if ((before?.allow_zero_for_debt ?? false) !== v.allowZeroForDebt) {
    await logLearning(supabase, user.id, 'preference', v.allowZeroForDebt ? 'accepted' : 'restored', null, { key: 'allow_zero_for_debt', value: v.allowZeroForDebt });
  }
  return done('Guardado.');
}

/** "Parece la cuota del carro" -> the person confirms: the real movement settles that month's payment. */
export async function markObligationPaidAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const obligationId = form.get('obligationId');
  const transactionId = form.get('transactionId');
  const period = form.get('period');
  if (!isUuid(obligationId) || !isUuid(transactionId) || typeof period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return { error: SAVE_ERROR };
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  const { error } = await supabase.from('plan_settlements').insert({ user_id: user.id, fixed_expense_id: obligationId, period, transaction_id: transactionId });
  if (error) return { error: error.code === '23505' ? 'Ese pago ya estaba registrado.' : SAVE_ERROR };
  return done('Pago confirmado. El siguiente ya está en tus próximos pagos.');
}

/**
 * "Parece tu sueldo de octubre" -> the person confirms: the real deposit settles that expected income, so the plan
 * horizon moves to the next one. Only an income movement can settle an income (checked here; RLS checks ownership).
 */
export async function linkIncomeAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const incomeId = form.get('incomeId');
  const transactionId = form.get('transactionId');
  const period = form.get('period');
  if (!isUuid(incomeId) || !isUuid(transactionId) || typeof period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(period)) return { error: SAVE_ERROR };
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  const { data: tx } = await supabase.from('transactions').select('type,status').eq('id', transactionId).maybeSingle();
  if (!tx || tx.type !== 'income' || tx.status !== 'confirmed') return { error: 'Ese movimiento no es un ingreso confirmado.' };
  const { error } = await supabase.from('plan_settlements').insert({ user_id: user.id, expected_income_id: incomeId, period, transaction_id: transactionId });
  if (error) return { error: error.code === '23505' ? 'Ese ingreso ya estaba registrado.' : SAVE_ERROR };
  await logLearning(supabase, user.id, 'income', 'accepted', incomeId, { period, transactionId });
  return done('Listo. Planificamos hasta el siguiente.');
}

/** "Tus básicos vienen siendo S/ 450": recomputed here (never trusted from the form), applied only on request. */
export async function acceptEssentialsAction(_p: ActionState, _form: FormData): Promise<ActionState> {
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  const { loadPlanningData, loadEssentialsSuggestion } = await import('../../../lib/planning');
  const s = await loadEssentialsSuggestion(supabase, await loadPlanningData(supabase));
  if (!s) return { error: 'Ya no hay una sugerencia vigente.' };
  const { error } = await supabase.from('planning_settings').update({ essentials_monthly_minor: s.observedMinor, updated_at: new Date().toISOString() })
    .eq('currency', 'PEN');
  if (error) return { error: SAVE_ERROR };
  await logLearning(supabase, user.id, 'essentials', 'accepted', null, { from: s.estimateMinor, to: s.observedMinor, months: s.months });
  return done('Listo. Básicos actualizados.');
}

/** "Internet subió S/31": update the expected amount, or keep the previous reference. History is never rewritten. */
export async function resolveVariationAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const obligationId = form.get('obligationId');
  const period = form.get('period');
  const choice = form.get('choice');
  const actual = Number(form.get('actual'));
  if (!isUuid(obligationId) || typeof period !== 'string' || (choice !== 'update' && choice !== 'keep')) return { error: SAVE_ERROR };
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  if (choice === 'update') {
    if (!Number.isSafeInteger(actual) || actual <= 0) return { error: SAVE_ERROR };
    const { error } = await supabase.from('fixed_expenses').update({ amount_minor: actual, amount_status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', obligationId);
    if (error) return { error: SAVE_ERROR };
  }
  const { error } = await supabase.from('plan_settlements').update({ variance_ack: true }).eq('fixed_expense_id', obligationId).eq('period', period);
  if (error) return { error: SAVE_ERROR };
  await logLearning(supabase, user.id, 'obligation', choice === 'update' ? 'accepted' : 'dismissed', obligationId, { period, actual: choice === 'update' ? actual : null });
  return done(choice === 'update' ? 'Monto actualizado.' : 'Listo.');
}

/** "Deshacer" a confirmed link (payment or income): the planned item is pending again; the movement is untouched. */
export async function unlinkSettlementAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  if (!isUuid(id)) return { error: SAVE_ERROR };
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  const { data, error } = await supabase.from('plan_settlements').delete().eq('id', id).select('id,period,fixed_expense_id,expected_income_id,transaction_id');
  if (error || !data?.length) return { error: SAVE_ERROR };
  const r = data[0]!;
  await logLearning(supabase, user.id, 'settlement', 'invalidated', r.id, { period: r.period, obligationId: r.fixed_expense_id, incomeId: r.expected_income_id, transactionId: r.transaction_id });
  return done('Deshecho. Vuelve a estar pendiente.');
}

/** "Ahora no" / "Descartar" / "No es ese" on a suggestion: hides it (the data behind it stays as it is). */
export async function decideSuggestionAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const kind = form.get('kind');
  const subject = form.get('subject');
  const decision = form.get('decision');
  const value = form.get('value');
  const valueMinor = typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : null;
  if (!['essentials', 'observed_amount', 'income_match'].includes(String(kind)) || typeof subject !== 'string' || !/^[A-Za-z0-9:-]{1,120}$/.test(subject)
    || (decision !== 'later' && decision !== 'dismissed')) return { error: SAVE_ERROR };
  const { supabase, user } = await session();
  if (!user) return { error: SAVE_ERROR };
  const ok = await decide(supabase, user.id, kind as 'essentials', subject, valueMinor, decision, limaToday());
  return ok ? done(decision === 'later' ? 'Te lo recuerdo luego.' : 'Listo, no lo sugiero más.') : { error: SAVE_ERROR };
}
