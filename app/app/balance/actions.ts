'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient, authUser } from '../../../lib/supabase/server';
import { parseAmountToMinor } from '../../../src/domain/money';
import { errorText, isUuid } from '../../../src/web/transaction-input';
import type { ActionState } from '../actions';

/**
 * Balance financiero goals (migration 059): savings and investment, each a fixed monthly amount or a % of the monthly
 * income. Blank removes the goal. Own row of planning_settings (RLS). The investment named must be the person's and
 * in the same currency.
 */
export async function saveGoalAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const kind = form.get('kind');
  const currency = form.get('currency');
  const mode = form.get('mode');
  const raw = typeof form.get('value') === 'string' ? String(form.get('value')).trim() : '';
  const investmentId = form.get('investmentId');
  if ((kind !== 'savings' && kind !== 'investment') || (currency !== 'PEN' && currency !== 'USD') || (mode !== 'fixed' && mode !== 'percent')) {
    return { error: errorText('invalid_request') };
  }
  let amount: number | null = null;
  let bp: number | null = null;
  if (raw) {
    if (mode === 'fixed') {
      amount = parseAmountToMinor(raw);
      if (amount === null) return { error: 'Escribe un monto, por ejemplo 500.' };
    } else {
      const pct = Number(raw.replace(',', '.').replace('%', ''));
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return { error: 'Escribe un porcentaje entre 1 y 100.' };
      bp = Math.round(pct * 100);
    }
  }
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) return { error: errorText('not_authenticated') };
  let invId: string | null = null;
  if (kind === 'investment' && isUuid(investmentId)) {
    const { data } = await supabase.from('investments').select('id,currency').eq('id', investmentId).eq('active', true).maybeSingle();
    if (!data) return { error: 'Elige una de tus inversiones.' };
    if (data.currency !== currency) return { error: 'La inversión elegida está en otra moneda.' };
    invId = data.id;
  }
  const empty = amount === null && bp === null;
  const row = kind === 'savings'
    ? { savings_goal_mode: empty ? 'fixed' : mode, savings_goal_minor: amount, savings_goal_bp: bp }
    : { investment_goal_mode: empty ? 'fixed' : mode, investment_goal_minor: amount, investment_goal_bp: bp, investment_goal_investment_id: empty ? null : invId };
  const { error } = await supabase.from('planning_settings').upsert({ user_id: user.id, currency, ...row, updated_at: new Date().toISOString() });
  if (error) return { error: errorText(null) };
  revalidatePath('/app', 'layout');
  return { message: empty ? 'Meta quitada.' : 'Meta guardada.' };
}
