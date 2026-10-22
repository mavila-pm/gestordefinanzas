import { settleCharge, settleSubscription, type CheckoutDeps } from '../../billing/checkout';
import { basicAuthOk, culqiId, parseWebhook, WEBHOOK_MAX_BYTES } from '../../billing/culqi';
import type { ProviderCharge, ProviderError, ProviderSubscription } from '../../billing/provider';
import { BillingRefused, type OrderRow } from '../../billing/store';

/**
 * Culqi webhook (ADR-0018). Culqi does not sign webhooks, so authenticity is layered:
 * 1. HTTP Basic credentials set in CulqiPanel ("Activar autenticación"), compared in constant time;
 * 2. the body is only a HINT: we read the event type and the object id, then RE-FETCH that object from Culqi with
 *    the secret key and act only on what Culqi returns (a forged "charge succeeded" for an unpaid charge does nothing);
 * 3. idempotency: one receipt per delivery in billing_events (provider, event_ref), plus per-reference idempotency
 *    inside every SQL lifecycle function (a replay is a no-op).
 * Answers: 401 bad credentials · 413 too large · 400 unreadable · 200 processed/ignored/duplicate/rejected (final)
 * · 500 transient (Culqi or the database failed: the receipt stays open and Culqi's retry processes it).
 */
export interface WebhookResult { status: number; body: { status: string } }
export interface WebhookDeps extends CheckoutDeps { auth: { user: string; password: string } }

const ok = (status: string): WebhookResult => ({ status: 200, body: { status } });
class Transient extends Error {}
const fetched = <T>(r: { ok: true; value: T } | ProviderError): T | null => {
  if (r.ok) return r.value;
  if (r.kind === 'not_found' || r.kind === 'invalid') return null;
  throw new Transient(r.code);
};

export async function handleCulqiWebhook(req: { headers: Headers; rawBody: string }, deps: WebhookDeps): Promise<WebhookResult> {
  if (Buffer.byteLength(req.rawBody, 'utf8') > WEBHOOK_MAX_BYTES) return { status: 413, body: { status: 'too_large' } };
  if (!basicAuthOk(req.headers.get('authorization'), deps.auth.user, deps.auth.password)) return { status: 401, body: { status: 'unauthorized' } };
  const event = parseWebhook(req.rawBody);
  if (!event) return { status: 400, body: { status: 'invalid_payload' } };

  const { store, provider } = deps;
  const receipt = await store.receive(provider.name, event.eventRef, event.type, event.objectRef, event.livemode);
  if (receipt.state === 'done') return ok('duplicate');
  const close = async (outcome: 'processed' | 'ignored' | 'rejected' | 'needs_refund', detail: string) => {
    await store.close(receipt.id, outcome, detail);
    deps.log?.({ event: 'culqi_webhook', type: event.type, outcome, detail });
    return ok(outcome);
  };
  if (!event.objectRef || event.livemode !== provider.livemode) return close('ignored', event.objectRef ? 'mode_mismatch' : 'no_object');

  try {
    switch (event.objectKind) {
      case 'chr': return await onCharge(deps, event.objectRef, close);
      case 'ref': return await onRefund(deps, event.objectRef, close);
      case 'sxn': return await onSubscription(deps, event.objectRef, close);
      default: return await close('ignored', `kind_${event.objectKind ?? 'none'}`);
    }
  } catch (e) {
    if (e instanceof BillingRefused) return close('rejected', e.code);
    deps.log?.({ event: 'culqi_webhook_error', type: event.type, code: e instanceof Transient ? e.message.slice(0, 60) : 'internal' });
    return { status: 500, body: { status: 'error' } };
  }
}

type Close = (outcome: 'processed' | 'ignored' | 'rejected' | 'needs_refund', detail: string) => Promise<WebhookResult>;

async function onCharge(deps: WebhookDeps, id: string, close: Close): Promise<WebhookResult> {
  const { store, provider } = deps;
  const charge = fetched(await provider.getCharge(id));
  if (!charge) return close('rejected', 'charge_not_found');
  const order = charge.orderId ? await store.findOrder(charge.orderId) : null;
  if (charge.orderId && !order) return close('rejected', 'unknown_order');
  // A subscription's charge — it names its subscription, or carries the order of a Mensual/Anual (Culqi may copy the
  // subscription's metadata onto its charges, UNVERIFIED) — is a period charge, never a Vitalicio settlement.
  if (charge.subscriptionRef || (order && order.planCode !== 'lifetime')) {
    const subRef = charge.subscriptionRef ?? (culqiId(order!.providerRef, 'sxn') ? order!.providerRef : null);
    if (subRef) return onPeriodCharge(deps, charge, subRef, order, close);
    // Its subscription is not settled yet (the checkout's answer was lost): Culqi retries this delivery, and the
    // subscription's own event (or support) settles the order first. Nothing is recorded meanwhile.
    if (order!.status === 'processing') throw new Transient('subscription_pending');
    return close('ignored', `subscription_order_${order!.status}`);
  }
  if (order) {
    if (!charge.succeeded) {
      if (order.status === 'processing' || order.status === 'pending') await store.failOrder(order.id, 'charge_failed');
      return close('processed', 'charge_failed');
    }
    const r = await settleCharge(deps, order.id, order, charge);
    return close(r.status === 'needs_refund' ? 'needs_refund' : 'processed', `order_${r.status}`);
  }
  return close('ignored', 'unmatched_charge');
}

/** A charge Culqi made for a subscription (UNVERIFIED: how Culqi links it to the subscription). */
async function onPeriodCharge(deps: WebhookDeps, charge: ProviderCharge, subRef: string, order: OrderRow | null, close: Close): Promise<WebhookResult> {
  const { store, provider } = deps;
  const local = await store.findSubscription(provider.name, subRef);
  if (!local) return onUnheldCharge(deps, charge, subRef, order, close);
  if (!charge.succeeded) {
    const s = await store.markPastDue(provider.name, subRef, charge.id, 'charge_failed');
    return close('processed', `past_due_${s}`);
  }
  const sub = fetched(await provider.getSubscription(subRef));
  if (!sub?.nextBillingDate) return close('rejected', 'no_next_billing_date');
  const r = await store.recordRenewal(provider.name, sub.id, charge.id, charge.amountMinor, charge.currency, sub.nextBillingDate);
  if (r === 'needs_refund') {
    // Charged after the person cancelled: give it back.
    const back = await provider.refund({ chargeRef: charge.id, amountMinor: charge.amountMinor - charge.refundedMinor });
    if (!back.ok) return close('needs_refund', 'charged_after_cancel');
    return close('processed', 'charged_after_cancel_refunded');
  }
  return close('processed', `renewal_${r}`);
}

/**
 * A charge of a subscription NO row holds: its activation was refused, a later purchase replaced it after it was
 * cancelled, or Velsuno never knew it. Nothing is granted for it, ever: flagged once (needs_refund). When it is
 * provably Velsuno's, the subscription is stopped at Culqi (a failed cancel is retried here) and the charge refunded
 * once; otherwise the owner reviews it (runbook §7) — never an automatic refund of a charge nothing links to us.
 */
async function onUnheldCharge(deps: WebhookDeps, charge: ProviderCharge, subRef: string, order: OrderRow | null, close: Close): Promise<WebhookResult> {
  const { store, provider } = deps;
  if (!charge.succeeded) return close('ignored', 'unknown_subscription_failed_charge');
  // Its order still waits for the subscription's activation (lost checkout answer): settle that first (retry).
  const pending = order ?? (await orderOfSubscription(deps, subRef));
  if (pending?.status === 'processing') throw new Transient('subscription_pending');
  let flag: { state: 'flagged' | 'duplicate'; ours: boolean };
  try {
    flag = await store.flagCharge({ provider: provider.name, chargeRef: charge.id, subRef, amountMinor: charge.amountMinor, currency: charge.currency, livemode: charge.livemode, code: 'unknown_subscription' });
  } catch (e) {
    // Activated meanwhile (a race with its own event): Culqi retries and the charge takes the period path.
    if (e instanceof BillingRefused && e.code === 'subscription_known') throw new Transient('subscription_known');
    throw e;
  }
  if (!flag.ours) return close(flag.state === 'flagged' ? 'needs_refund' : 'ignored', 'unknown_subscription');
  const stop = await provider.cancelSubscription(subRef);
  const stopped = stop.ok || stop.kind === 'not_found';
  if (flag.state === 'flagged' && charge.refundedMinor < charge.amountMinor) {
    const back = await provider.refund({ chargeRef: charge.id, amountMinor: charge.amountMinor - charge.refundedMinor });
    if (!back.ok) {
      deps.log?.({ event: 'billing_needs_refund', code: 'charge_of_unheld_subscription', refund_error: back.code, canceled_at_provider: stopped });
      return close('needs_refund', 'charge_of_unheld_subscription');
    }
    try {
      await store.refund(provider.name, charge.id, back.value.id, back.value.amountMinor, charge.currency);
    } catch (e) {
      if (!(e instanceof BillingRefused)) throw e;
    }
  }
  // The refund is done once (the flag is its key); a cancel that failed is retried on Culqi's next delivery.
  if (!stopped) throw new Transient(stop.code);
  return close('processed', flag.state === 'flagged' ? 'charge_of_unheld_subscription_refunded' : 'charge_of_unheld_subscription_seen');
}

/** The order a subscription was created for, from Culqi's own copy of its metadata (never from the webhook body). */
async function orderOfSubscription(deps: WebhookDeps, subRef: string): Promise<OrderRow | null> {
  const byRef = await deps.store.findOrderByRef(deps.provider.name, subRef);
  if (byRef) return byRef;
  const sub = fetched(await deps.provider.getSubscription(subRef));
  return sub?.orderId ? deps.store.findOrder(sub.orderId) : null;
}

async function onRefund(deps: WebhookDeps, id: string, close: Close): Promise<WebhookResult> {
  const { store, provider } = deps;
  const refund = fetched(await provider.getRefund(id));
  if (!refund) return close('rejected', 'refund_not_found');
  const charge = fetched(await provider.getCharge(refund.chargeRef));
  if (!charge) return close('rejected', 'charge_not_found');
  try {
    const r = await store.refund(provider.name, refund.chargeRef, refund.id, refund.amountMinor, charge.currency);
    return close('processed', `refund_${r}`);
  } catch (e) {
    if (e instanceof BillingRefused && e.code === 'unknown_charge') return close('ignored', 'unknown_charge');
    throw e;
  }
}

/**
 * A subscription event. A period is NEVER granted from it: renewals are recorded only from a re-fetched successful
 * charge (onPeriodCharge), so a moved next billing date without a payment gives nothing and a past_due stays past_due.
 * A subscription no row holds: the checkout's answer was lost (activate it), or its activation was refused (stop it
 * at Culqi again — the cancel at checkout may have failed). Status codes are not interpreted (meanings not published).
 */
async function onSubscription(deps: WebhookDeps, id: string, close: Close): Promise<WebhookResult> {
  const { store, provider } = deps;
  if (await store.findSubscription(provider.name, id)) return close('ignored', 'subscription_event');
  const sub = fetched(await provider.getSubscription(id));
  if (!sub) return close('ignored', 'subscription_not_found');
  return onNewSubscription(deps, sub, close);
}

/**
 * A subscription we have no row for. Our order id travels in its metadata (or the order was closed with its
 * reference): activate it exactly as the checkout would have (same SQL checks), or stop it.
 */
async function onNewSubscription(deps: WebhookDeps, sub: ProviderSubscription, close: Close): Promise<WebhookResult> {
  const { store, provider } = deps;
  const order = sub.orderId ? await store.findOrder(sub.orderId) : await store.findOrderByRef(provider.name, sub.id);
  if (!order) return sub.orderId ? close('rejected', 'unknown_order') : close('ignored', 'unknown_subscription');
  if (order.planCode === 'lifetime') return close('rejected', 'unknown_order');
  if (order.status === 'processing') {
    if (!sub.customerRef || !sub.cardRef) return close('rejected', 'subscription_incomplete');
    const r = await settleSubscription(deps, order.id, order, sub, sub.customerRef, sub.cardRef);
    return close(r.status === 'needs_refund' ? 'needs_refund' : 'processed', `order_${r.status}`);
  }
  // Its order closed without granting anything (refused activation): it must not stay alive at Culqi.
  if ((order.status === 'failed' || order.status === 'refunded') && (order.providerRef === sub.id || order.providerRef === null)) {
    const stop = await provider.cancelSubscription(sub.id);
    if (!stop.ok && stop.kind !== 'not_found') throw new Transient(stop.code);
    return close('processed', 'refused_subscription_canceled');
  }
  return close('ignored', `order_${order.status}`);
}
