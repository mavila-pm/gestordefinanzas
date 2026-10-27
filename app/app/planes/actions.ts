'use server';

import { redirect } from 'next/navigation';
import { billingMode, loadBillingState, purchasable } from '../../../lib/billing';
import { culqiCheckout } from '../../../lib/culqi';
import { authUser, createSupabaseServerClient } from '../../../lib/supabase/server';
import { payLifetime, paySubscription, type CheckoutOutcome } from '../../../src/billing/checkout';
import { declineMessage } from '../../../src/billing/culqi';
import { isPlanCode } from '../../../src/domain/billing';
import { billingCustomer, CHECKOUT_COPY, CHECKOUT_FALLBACK, isTokenId, parseAddress } from '../../../src/web/billing-input';
import { isUuid } from '../../../src/web/transaction-input';
import type { ActionState } from '../actions';

const copy = (code: string | undefined) => (code && CHECKOUT_COPY[code]) || CHECKOUT_FALLBACK;

/**
 * Demo accounts without Culqi sandbox keys: "Pagar" / "Empezar prueba" completes the order without a charge
 * (billing_simulate_payment). The server prices the order (billing_create_order); the client only names the plan.
 */
export async function checkoutAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const plan = form.get('plan');
  if (!isPlanCode(plan)) return { error: copy('bad_plan') };
  if (form.get('terms') !== 'on') return { error: copy('terms') };
  const supabase = await createSupabaseServerClient();
  if (!(await authUser(supabase))) redirect('/login?next=/app/planes');
  const mode = await billingMode(supabase);
  if (mode.kind === 'disabled') return { error: copy('disabled') };
  // Card payments go through the Culqi button (startCardOrderAction + payWithCardAction), never through this form.
  if (mode.kind === 'culqi') return { error: CHECKOUT_FALLBACK };
  // The price the person saw and accepted: if the server price differs now, nothing is created (price_changed).
  const expected = Number(form.get('amount'));
  if (!Number.isSafeInteger(expected) || expected <= 0) return { error: copy('price_changed') };
  const { data: order, error } = await supabase.rpc('billing_create_order', { p_plan: plan, p_expected_minor: expected });
  if (error || typeof order !== 'string') return { error: copy(error?.message) };
  const { error: payError } = await supabase.rpc('billing_simulate_payment', { p_order: order });
  if (payError) return { error: 'No pudimos completar la compra de prueba. No se hizo ningún cargo.' };
  redirect(`/app/planes/gracias?pedido=${order}`);
}

export type CardOrderResult = { ok: true; orderId: string; amountMinor: number; currency: 'USD' } | { ok: false; error: string };

/**
 * Step 1 of a card payment (before Culqi Checkout opens): the person accepted the terms; the server creates the
 * order at ITS price (price_changed if the shown one is stale) and returns the amount Checkout displays. Nothing is
 * charged here.
 */
export async function startCardOrderAction(input: { plan: unknown; amount: unknown; terms: unknown; address?: unknown; city?: unknown }): Promise<CardOrderResult> {
  if (!isPlanCode(input.plan)) return { ok: false, error: copy('bad_plan') };
  if (input.terms !== true) return { ok: false, error: copy('terms') };
  if (input.plan !== 'lifetime') {
    const a = parseAddress(input.address, input.city);
    if ('error' in a) return { ok: false, error: copy(a.error) };
  }
  const expected = Number(input.amount);
  if (!Number.isSafeInteger(expected) || expected <= 0) return { ok: false, error: copy('price_changed') };
  const supabase = await createSupabaseServerClient();
  if (!(await authUser(supabase))) return { ok: false, error: 'Inicia sesión de nuevo. No se hizo ningún cargo.' };
  const [mode, state] = await Promise.all([billingMode(supabase), loadBillingState(supabase)]);
  if (mode.kind !== 'culqi') return { ok: false, error: copy('disabled') };
  if (state.paid) return { ok: false, error: copy('already_plus') };
  // An older Mensual/Anual Culqi can still charge: the person cancels it first (SQL refuses too), never two at once.
  if (state.renewalOpen) return { ok: false, error: copy('subscription_still_open') };
  // Never a wrong price: a Mensual/Anual order needs the Culqi plan of exactly this amount and trial configured.
  if (!purchasable(mode, input.plan, expected, input.plan !== 'lifetime' && !state.trialUsed)) return { ok: false, error: copy('price_config_mismatch') };
  const { data: order, error } = await supabase.rpc('billing_create_order', { p_plan: input.plan, p_expected_minor: expected });
  if (error || typeof order !== 'string') return { ok: false, error: copy(error?.message) };
  const { data: row } = await supabase.from('billing_orders').select('amount_minor,currency').eq('id', order).maybeSingle();
  if (!row || row.currency !== 'USD') return { ok: false, error: CHECKOUT_FALLBACK };
  return { ok: true, orderId: order, amountMinor: Number(row.amount_minor), currency: 'USD' };
}

export type CardPayResult = { ok: true; redirectTo: string } | { ok: false; error: string };

/**
 * Step 2, after Culqi Checkout returned a card token: the server charges the STORED order amount (Vitalicio) or
 * saves the card and subscribes (Mensual/Anual), then SQL grants Plus. The browser's success is never trusted:
 * the gracias page reads the order status from the database.
 */
export async function payWithCardAction(input: { orderId: unknown; tokenId: unknown; address?: unknown; city?: unknown }): Promise<CardPayResult> {
  if (!isUuid(input.orderId) || !isTokenId(input.tokenId)) return { ok: false, error: copy('bad_token') };
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user?.email) return { ok: false, error: 'Inicia sesión de nuevo. No se hizo ningún cargo.' };
  const mode = await billingMode(supabase);
  if (mode.kind !== 'culqi') return { ok: false, error: copy('disabled') };
  const deps = culqiCheckout();
  if (!deps.ok) return { ok: false, error: copy('disabled') };
  // RLS: the order must be the person's own (billing_begin_charge checks the owner again).
  const { data: order } = await supabase.from('billing_orders').select('id,plan_code').eq('id', input.orderId).maybeSingle();
  if (!order || !isPlanCode(order.plan_code)) return { ok: false, error: copy('order_not_found') };
  const flow = { store: deps.store, provider: deps.provider, log: (e: Record<string, string | number | boolean | null>) => console.warn(JSON.stringify(e)) };

  let outcome: CheckoutOutcome;
  if (order.plan_code === 'lifetime') {
    outcome = await payLifetime(flow, { orderId: order.id, userId: user.id, email: user.email, tokenRef: input.tokenId });
  } else {
    const { data: profile } = await supabase.from('profiles').select('given_names,family_names,phone_e164').maybeSingle();
    const customer = billingCustomer(profile, input.address, input.city);
    if ('error' in customer) return { ok: false, error: copy(customer.error) };
    outcome = await paySubscription({ ...flow, plans: deps.plans }, { orderId: order.id, userId: user.id, email: user.email, tokenRef: input.tokenId, customer });
  }
  return outcomeResult(outcome);
}

function outcomeResult(o: CheckoutOutcome): CardPayResult {
  switch (o.status) {
    case 'paid': case 'trialing': case 'pending': return { ok: true, redirectTo: `/app/planes/gracias?pedido=${o.orderId}` };
    case 'declined': return { ok: false, error: declineMessage(o.code) };
    case 'unavailable': return { ok: false, error: copy(o.code === 'price_config_mismatch' ? o.code : 'unavailable') };
    case 'refunded': return { ok: false, error: copy('refunded') };
    case 'needs_refund': return { ok: false, error: copy('needs_refund') };
    case 'refused': return { ok: false, error: copy(o.code) };
  }
}
