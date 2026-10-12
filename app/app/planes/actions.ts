'use server';

import { redirect } from 'next/navigation';
import { billingMode } from '../../../lib/billing';
import { authUser, createSupabaseServerClient } from '../../../lib/supabase/server';
import { isPlanCode } from '../../../src/domain/billing';
import type { ActionState } from '../actions';

const ERRORS: Record<string, string> = {
  already_lifetime: 'Ya tienes Plus Vitalicio.',
  already_plus: 'Ya tienes Plus. Puedes ver tu plan en Ajustes → Plan y uso.',
  too_many_orders: 'Hiciste varios intentos seguidos. Espera unos minutos y vuelve a intentarlo.',
  bad_plan: 'Elige un plan válido.',
  price_changed: 'El precio de este plan cambió. Revisa el nuevo precio antes de continuar.',
};

/**
 * "Pagar" / "Empezar prueba": the server prices the order (billing_create_order); the client only names the plan.
 * Demo accounts complete it without a charge; real accounts need the payment provider (never a fake success).
 */
export async function checkoutAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const plan = form.get('plan');
  if (!isPlanCode(plan)) return { error: ERRORS.bad_plan };
  if (form.get('terms') !== 'on') return { error: 'Para continuar, acepta los Términos y las condiciones de pago.' };
  const supabase = await createSupabaseServerClient();
  if (!(await authUser(supabase))) redirect('/login?next=/app/planes');
  const mode = await billingMode(supabase);
  if (mode === 'disabled') return { error: 'Los pagos con tarjeta se habilitarán muy pronto. No se hizo ningún cargo.' };
  if (mode === 'culqi') return { error: 'El pago con Culqi aún no está activo en esta versión. No se hizo ningún cargo.' };
  // The price the person saw and accepted: if the server price differs now, nothing is created (price_changed).
  const expected = Number(form.get('amount'));
  if (!Number.isSafeInteger(expected) || expected <= 0) return { error: ERRORS.price_changed };
  const { data: order, error } = await supabase.rpc('billing_create_order', { p_plan: plan, p_expected_minor: expected });
  if (error || typeof order !== 'string') return { error: ERRORS[error?.message ?? ''] ?? 'No pudimos iniciar tu compra. Inténtalo de nuevo.' };
  const { error: payError } = await supabase.rpc('billing_simulate_payment', { p_order: order });
  if (payError) return { error: 'No pudimos completar la compra de prueba. No se hizo ningún cargo.' };
  redirect(`/app/planes/gracias?pedido=${order}`);
}
