'use server';

/**
 * Mis suscripciones writes. A subscription is an obligation (fixed_expenses, kind 'subscription'): saving one never
 * creates a movement, editing changes only what comes (real payments stay in plan_settlements → transactions), and
 * a service already tracked as a payment is converted, not added twice. Ownership: RLS + composite FKs (card/account).
 * Pause / resume / stop following and payment links reuse the planning actions (recurrenceAction, markObligationPaidAction).
 */
import { revalidatePath } from 'next/cache';
import { isReplay, ref } from '../../../../lib/idempotency';
import { createSupabaseServerClient, authUser } from '../../../../lib/supabase/server';
import { limaToday } from '../../../../src/domain/dates';
import { matchProvider } from '../../../../src/domain/subscriptions';
import { startPause } from '../../../../src/engine/subscriptions';
import { parseSubscriptionForm } from '../../../../src/web/subscription-input';
import { isUuid } from '../../../../src/web/transaction-input';
import type { ActionState } from '../../actions';

const SAVE_ERROR = 'No se guardó. Intenta de nuevo.';
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
function done(message: string): ActionState {
  revalidatePath('/app', 'layout');
  return { message };
}

export async function saveSubscriptionAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const today = limaToday();
  const parsed = parseSubscriptionForm((k) => form.get(k), today);
  if (!parsed.ok) return { error: parsed.error };
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) return { error: SAVE_ERROR };
  const v = parsed.value;
  const row = {
    name: v.name, kind: 'subscription', provider: v.provider, currency: v.currency, amount_minor: v.amountMinor, amount_status: v.amountStatus,
    frequency: v.frequency, anchor_month: v.anchorMonth, due_day: v.dueDay, due_day_max: null, target_day: null, card_id: v.cardId, account_id: v.accountId,
    updated_at: new Date().toISOString(),
  };
  const nextDate = String(form.get('nextDate'));
  const id = form.get('id');
  if (isUuid(id)) {
    // Editing a price or date changes the plan from now on; past payments keep their real amounts.
    const { data, error } = await supabase.from('fixed_expenses').update(row).eq('id', id).eq('kind', 'subscription').select('id');
    if (error || !data?.length) return { error: SAVE_ERROR };
    return done('Suscripción actualizada.');
  }
  // Never twice: the same service (catalogue slug or name) already tracked, as a subscription or as a payment.
  const { data: existing } = await supabase.from('fixed_expenses').select('id,name,kind,provider,currency,ended_on').eq('active', true).is('ended_on', null).limit(300);
  const same = (existing ?? []).find((r) => (v.provider && (r.provider === v.provider || matchProvider(r.name)?.slug === v.provider)) || fold(r.name) === fold(v.name));
  if (same) {
    return { error: same.kind === 'subscription' ? `${same.name} ya está en tus suscripciones.` : `Ya tienes «${same.name}» en tus pagos. Pásalo a suscripciones para no duplicarlo.` };
  }
  const paused = startPause({ frequency: v.frequency, anchorMonth: v.anchorMonth, dueDay: v.dueDay, dueDayMax: null, targetDay: null }, today, nextDate);
  const { error } = await supabase.from('fixed_expenses').insert({ ...row, user_id: user.id, paused_until: paused, client_ref: ref(form) });
  return error && !isReplay(error) ? { error: SAVE_ERROR } : done('Suscripción agregada.');
}

/** A payment already tracked that is really a subscription (e.g. "Netflix"): the same row changes kind — no copy. */
export async function convertToSubscriptionAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const id = form.get('id');
  if (!isUuid(id)) return { error: SAVE_ERROR };
  const supabase = await createSupabaseServerClient();
  if (!(await authUser(supabase))) return { error: SAVE_ERROR };
  const { data: r } = await supabase.from('fixed_expenses').select('name').eq('id', id).maybeSingle();
  if (!r) return { error: SAVE_ERROR };
  const { data, error } = await supabase.from('fixed_expenses').update({ kind: 'subscription', provider: matchProvider(r.name)?.slug ?? null, updated_at: new Date().toISOString() })
    .eq('id', id).neq('kind', 'subscription').select('id');
  return error || !data?.length ? { error: SAVE_ERROR } : done('Listo: ahora está en tus suscripciones, con su historial.');
}
