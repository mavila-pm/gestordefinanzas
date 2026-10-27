'use server';

import { revalidatePath } from 'next/cache';
import { culqiServiceDeps } from '../../../../lib/culqi';
import { authUser, createSupabaseServerClient } from '../../../../lib/supabase/server';
import { cancelRenewal } from '../../../../src/billing/checkout';
import { billingDate } from '../../../../src/domain/billing';
import type { ActionState } from '../../actions';

const CANCEL_FAILED = 'No pudimos cancelar con Culqi. Tu plan no cambió. Inténtalo de nuevo en unos minutos.';

/**
 * "Cancelar renovación" (spec §85, ADR-0019): Culqi first (the subscription is deleted there, so no other charge can
 * happen), then SQL records cancel_at_period_end. Plus stays until the end of the paid period (or of the trial) and
 * then the plan becomes Free with every datum kept. If Culqi fails, nothing changes and the person is told so.
 * The subscription reference comes from the person's own row (RLS), never from the form.
 */
export async function cancelRenewalAction(_p: ActionState, form: FormData): Promise<ActionState> {
  if (form.get('confirm') !== 'yes') return { error: 'Confirma que quieres cancelar la renovación.' };
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) return { error: 'Inicia sesión de nuevo.' };
  const { data: sub } = await supabase.from('subscriptions')
    .select('provider,provider_ref,billing_plan,cancel_at_period_end,livemode').maybeSingle();
  if (!sub || sub.provider !== 'culqi' || !sub.provider_ref || (sub.billing_plan !== 'monthly' && sub.billing_plan !== 'annual')) {
    return { error: 'No tienes una renovación activa que cancelar.' };
  }
  if (sub.cancel_at_period_end) return { message: 'Tu renovación ya estaba cancelada. No se hará ningún otro cobro.' };
  const deps = culqiServiceDeps();
  // The subscription lives in Culqi's test or live mode: only the deployment with the same keys can cancel it.
  if (!deps || deps.provider.livemode !== sub.livemode) return { error: CANCEL_FAILED };
  const r = await cancelRenewal(deps, { userId: user.id, subRef: sub.provider_ref });
  if (!r.ok) return { error: CANCEL_FAILED };
  revalidatePath('/app', 'layout');
  // A cancelled renewal has no grace days: Plus stays only until a date still ahead (else the plan is Free now).
  const until = r.until && r.until.getTime() > Date.now() ? r.until : null;
  return { message: until ? `Listo. Conservas Plus hasta el ${billingDate(until.toISOString())}. No se hará ningún otro cobro.` : 'Listo. No se hará ningún otro cobro. Quedas en Free con todos tus datos.' };
}
