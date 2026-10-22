import { settleCharge, settleSubscription, type CheckoutDeps } from '../../billing/checkout';
import { basicAuthOk, parseWebhook, WEBHOOK_MAX_BYTES } from '../../billing/culqi';
import type { ProviderCharge, ProviderError, ProviderSubscription } from '../../billing/provider';
import { BillingRefused } from '../../billing/store';

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
  if (charge.orderId) {
    const order = await store.findOrder(charge.orderId);
    if (!order) return close('rejected', 'unknown_order');
    if (order.planCode !== 'lifetime') return close('ignored', 'subscription_order_charge');
    if (!charge.succeeded) {
      if (order.status === 'processing' || order.status === 'pending') await store.failOrder(order.id, 'charge_failed');
      return close('processed', 'charge_failed');
    }
    const r = await settleCharge(deps, order.id, order, charge);
    return close(r.status === 'needs_refund' ? 'needs_refund' : 'processed', `order_${r.status}`);
  }
  if (charge.subscriptionRef) return onPeriodCharge(deps, charge, close);
  return close('ignored', 'unmatched_charge');
}

/** A charge Culqi made for a subscription period (UNVERIFIED: how Culqi links it to the subscription). */
async function onPeriodCharge(deps: WebhookDeps, charge: ProviderCharge, close: Close): Promise<WebhookResult> {
  const { store, provider } = deps;
  const local = await store.findSubscription(provider.name, charge.subscriptionRef!);
  if (!local) return close('ignored', 'unknown_subscription');
  if (!charge.succeeded) {
    const s = await store.markPastDue(provider.name, charge.subscriptionRef!, charge.id, 'charge_failed');
    return close('processed', `past_due_${s}`);
  }
  const sub = fetched(await provider.getSubscription(charge.subscriptionRef!));
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
 * A subscription event: re-fetch it. When Culqi moved the next billing date past ours, a period was charged: record
 * the renewal keyed by (subscription, new date) at the amount the plan was sold at (Culqi plan amounts cannot change,
 * UNVERIFIED). Status codes are not interpreted (meanings not published).
 */
async function onSubscription(deps: WebhookDeps, id: string, close: Close): Promise<WebhookResult> {
  const { store, provider } = deps;
  const local = await store.findSubscription(provider.name, id);
  const sub = fetched(await provider.getSubscription(id));
  if (!sub) return close(local ? 'rejected' : 'ignored', 'subscription_not_found');
  if (!local) return onNewSubscription(deps, sub, close);
  const next = sub.nextBillingDate;
  if (!next || !local.amountMinor || !local.currency || (local.currentPeriodEnd && next.getTime() <= local.currentPeriodEnd.getTime())) return close('ignored', 'no_new_period');
  const r = await store.recordRenewal(provider.name, id, `${id}_${Math.floor(next.getTime() / 1000)}`, local.amountMinor, local.currency, next);
  return close(r === 'needs_refund' ? 'needs_refund' : 'processed', `renewal_${r}`);
}

/**
 * A subscription we have no row for: the checkout's answer from Culqi was lost (timeout) after Culqi created it.
 * Our order id travels in its metadata; activate it exactly as the checkout would have (same SQL checks), or stop it.
 */
async function onNewSubscription(deps: WebhookDeps, sub: ProviderSubscription, close: Close): Promise<WebhookResult> {
  if (!sub.orderId) return close('ignored', 'unknown_subscription');
  const order = await deps.store.findOrder(sub.orderId);
  if (!order || order.planCode === 'lifetime') return close('rejected', 'unknown_order');
  if (order.status !== 'processing') return close('ignored', `order_${order.status}`);
  if (!sub.customerRef || !sub.cardRef) return close('rejected', 'subscription_incomplete');
  const r = await settleSubscription(deps, order.id, order, sub, sub.customerRef, sub.cardRef);
  return close(r.status === 'needs_refund' ? 'needs_refund' : 'processed', `order_${r.status}`);
}
