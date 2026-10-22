import { planKey, type PlanKey } from './config';
import { isCulqiId } from './culqi';
import type { BillingProvider, ProviderCharge, ProviderError, ProviderPlan, ProviderSubscription } from './provider';
import { BillingRefused, type BillingStore, type ClaimedOrder } from './store';

/**
 * Billing flows (ADR-0018), provider- and database-agnostic so they are tested with a mocked provider and either a
 * fake or the real SQL store. Invariants:
 * - the amount charged is ALWAYS the order amount read from the database (billing_begin_charge), never the browser's;
 * - an order is claimed (pending → processing) before any money moves: a double submit gets order_not_pending and
 *   never reaches the provider;
 * - a definitive provider "no" closes the order (failOrder); an unknown outcome (timeout, 5xx, unreadable answer)
 *   leaves it processing for the webhook to settle — never "failed" while money may have moved;
 * - a charge that went through but cannot be activated is refunded (and flagged in the ledger if the refund fails);
 * - Plus is granted only by the SQL activation functions.
 */
export type CheckoutOutcome =
  | { status: 'paid' | 'trialing'; orderId: string }
  | { status: 'pending'; orderId: string }
  | { status: 'declined'; code: string }
  | { status: 'refused'; code: string }
  | { status: 'unavailable'; code: string }
  | { status: 'refunded'; code: string }
  | { status: 'needs_refund'; code: string };

export interface CheckoutDeps { store: BillingStore; provider: BillingProvider; log?: (e: Record<string, string | number | boolean | null>) => void }

const PROVIDER_DOWN = new Set(['unknown', 'unavailable']);

/** What to do after a provider error on a step that happens BEFORE the money-moving call (nothing to refund). */
async function closeBeforeMoney(store: BillingStore, orderId: string, e: ProviderError): Promise<CheckoutOutcome> {
  if (e.kind === 'declined' || e.kind === 'needs_authentication') {
    await store.failOrder(orderId, e.kind === 'needs_authentication' ? 'needs_3ds' : clip(e.code));
    return { status: 'declined', code: e.kind === 'needs_authentication' ? 'needs_3ds' : e.code };
  }
  await store.failOrder(orderId, PROVIDER_DOWN.has(e.kind) ? 'provider_unavailable' : e.kind === 'auth' ? 'provider_auth' : clip(`invalid_${e.code}`));
  return { status: 'unavailable', code: e.kind === 'invalid' ? `invalid_${e.code}` : e.code };
}

const clip = (code: string) => code.replace(/[^a-z0-9_:]/g, '_').slice(0, 60) || 'unknown';

async function claim(deps: CheckoutDeps, orderId: string, userId: string): Promise<ClaimedOrder | CheckoutOutcome> {
  try {
    return await deps.store.beginCharge(orderId, userId, deps.provider.name, deps.provider.livemode);
  } catch (e) {
    if (e instanceof BillingRefused) return { status: 'refused', code: e.code };
    throw e;
  }
}
const isOutcome = (v: ClaimedOrder | CheckoutOutcome): v is CheckoutOutcome => 'status' in v;

/**
 * A successful charge for an order (from the checkout or from a re-fetched webhook object): activate it, or refund
 * it when the activation is refused (e.g. the person got Plus some other way meanwhile). Idempotent.
 */
export async function settleCharge(deps: CheckoutDeps, orderId: string, order: { amountMinor: number; currency: string }, charge: ProviderCharge): Promise<CheckoutOutcome> {
  const { store, provider } = deps;
  if (charge.amountMinor !== order.amountMinor || charge.currency !== order.currency) {
    // Never activate on a different amount: give the money back.
    return refundOrphan(deps, orderId, charge, 'amount_mismatch');
  }
  try {
    const s = await store.activate(orderId, provider.name, charge.id, charge.amountMinor, charge.currency);
    return { status: s === 'paid' ? 'paid' : 'trialing', orderId };
  } catch (e) {
    if (!(e instanceof BillingRefused)) throw e;
    // Settled before with THIS charge (a replay): nothing more to do.
    const o = await store.findOrder(orderId);
    if (o && o.providerRef === charge.id && o.status === 'paid') return { status: 'paid', orderId };
    if (o && o.providerRef === charge.id && o.status === 'refunded') return { status: 'refunded', code: 'already_refunded' };
    return refundOrphan(deps, orderId, charge, `activation_refused:${e.code}`);
  }
}

async function refundOrphan(deps: CheckoutDeps, orderId: string, charge: ProviderCharge, code: string): Promise<CheckoutOutcome> {
  const { store, provider } = deps;
  try {
    await store.failOrder(orderId, clip(code), charge.id);
  } catch (e) {
    if (!(e instanceof BillingRefused)) throw e;
  }
  // Never refund twice: the provider's own copy says how much was already returned.
  if (charge.refundedMinor >= charge.amountMinor) return { status: 'refunded', code };
  const r = await provider.refund({ chargeRef: charge.id, amountMinor: charge.amountMinor - charge.refundedMinor });
  if (!r.ok) {
    deps.log?.({ event: 'billing_needs_refund', order: orderId, code: clip(code), refund_error: r.code });
    return { status: 'needs_refund', code };
  }
  try {
    await store.refund(provider.name, charge.id, r.value.id, r.value.amountMinor, charge.currency);
  } catch (e) {
    if (!(e instanceof BillingRefused)) throw e;
  }
  return { status: 'refunded', code };
}

/** Vitalicio: one charge of the stored order amount with the card token from Culqi Checkout. */
export async function payLifetime(deps: CheckoutDeps, i: { orderId: string; userId: string; email: string; tokenRef: string }): Promise<CheckoutOutcome> {
  const { store, provider } = deps;
  if (!isCulqiId(i.tokenRef, 'tkn', provider.livemode)) return { status: 'refused', code: 'bad_token' };
  const claimed = await claim(deps, i.orderId, i.userId);
  if (isOutcome(claimed)) return claimed;
  if (claimed.planCode !== 'lifetime' || claimed.trialDays !== 0) {
    await store.failOrder(i.orderId, 'wrong_flow');
    return { status: 'refused', code: 'wrong_flow' };
  }
  const charge = await provider.charge({
    amountMinor: claimed.amountMinor, currency: claimed.currency, email: i.email, sourceRef: i.tokenRef,
    description: 'Velsuno Plus Vitalicio', orderId: i.orderId,
  });
  if (!charge.ok) {
    if (charge.kind === 'unknown') return { status: 'pending', orderId: i.orderId };
    return closeBeforeMoney(store, i.orderId, charge);
  }
  if (!charge.value.succeeded) return { status: 'pending', orderId: i.orderId };
  if (charge.value.orderId && charge.value.orderId !== i.orderId) return refundOrphan(deps, i.orderId, charge.value, 'order_mismatch');
  return settleCharge(deps, i.orderId, claimed, charge.value);
}

/** The Culqi plan behind an order must be exactly what the person accepted: amount, currency, period and trial. */
export function planMatches(plan: ProviderPlan, order: ClaimedOrder): boolean {
  if (plan.amountMinor !== order.amountMinor || plan.currency !== order.currency) return false;
  if (plan.interval !== (order.planCode === 'monthly' ? 'month' : 'year') || plan.intervalCount !== 1) return false;
  // No trial: no initial cycles at all — neither free months nor a first charge at another price.
  if (order.trialDays === 0) return plan.initialCycles === 0 && !plan.freeInitialCycles && plan.chargesAtStart;
  // The free period must be exactly the trial the person accepted (UNVERIFIED: unit 1 = day).
  const f = plan.freeInitialCycles;
  return !!f && !plan.chargesAtStart && plan.initialCycles === f.count && f.unit === TRIAL_UNIT_DAY && f.count === order.trialDays;
}
/** Culqi interval_unit_time for days (UNVERIFIED, see src/billing/culqi.ts). */
export const TRIAL_UNIT_DAY = 1;

export interface SubscriptionInput {
  orderId: string; userId: string; email: string; tokenRef: string;
  customer: { firstName: string; lastName: string; phoneNumber: string; address: string; addressCity: string };
}

/**
 * Mensual/Anual: plan check (before anything is created) → customer (reused) → card → subscription → activation with
 * the dates Culqi returned. A refused activation cancels the subscription at Culqi right away.
 */
export async function paySubscription(deps: CheckoutDeps & { plans: Partial<Record<PlanKey, string>> }, i: SubscriptionInput): Promise<CheckoutOutcome> {
  const { store, provider } = deps;
  if (!isCulqiId(i.tokenRef, 'tkn', provider.livemode)) return { status: 'refused', code: 'bad_token' };
  const claimed = await claim(deps, i.orderId, i.userId);
  if (isOutcome(claimed)) return claimed;
  if (claimed.planCode === 'lifetime') {
    await store.failOrder(i.orderId, 'wrong_flow');
    return { status: 'refused', code: 'wrong_flow' };
  }
  const planRef = deps.plans[planKey(claimed.planCode, claimed.amountMinor, claimed.trialDays > 0)];
  if (!planRef) {
    await store.failOrder(i.orderId, 'price_config_mismatch');
    return { status: 'unavailable', code: 'price_config_mismatch' };
  }
  const plan = await provider.getPlan(planRef);
  if (!plan.ok) return closeBeforeMoney(store, i.orderId, plan);
  if (!planMatches(plan.value, claimed)) {
    deps.log?.({ event: 'billing_plan_mismatch', plan_key: planKey(claimed.planCode, claimed.amountMinor, claimed.trialDays > 0) });
    await store.failOrder(i.orderId, 'price_config_mismatch');
    return { status: 'unavailable', code: 'price_config_mismatch' };
  }

  // One provider customer per person and mode, reused across purchases.
  let customerRef = (await store.getCustomer(i.userId, provider.name, provider.livemode))?.customerRef ?? null;
  if (!customerRef) {
    const created = await provider.createCustomer({ ...i.customer, email: i.email, countryCode: 'PE' });
    if (created.ok) customerRef = created.value.id;
    else if (created.kind === 'invalid') {
      // UNVERIFIED: Culqi refuses a second customer with the same email; reuse it only on an exact email match.
      const found = await provider.findCustomerByEmail(i.email);
      if (found.ok && found.value) customerRef = found.value.id;
      else {
        await store.failOrder(i.orderId, 'customer_rejected');
        return { status: 'refused', code: 'customer_rejected' };
      }
    } else return closeBeforeMoney(store, i.orderId, created);
    await store.saveCustomer(i.userId, provider.name, provider.livemode, customerRef, null);
  }
  const card = await provider.createCard({ customerRef, tokenRef: i.tokenRef });
  if (!card.ok) return closeBeforeMoney(store, i.orderId, card.kind === 'unknown' ? { ...card, kind: 'unavailable' } : card);

  const sub = await provider.createSubscription({ cardRef: card.value.id, planRef, orderId: i.orderId });
  if (!sub.ok) {
    if (sub.kind === 'unknown') return { status: 'pending', orderId: i.orderId };
    return closeBeforeMoney(store, i.orderId, sub);
  }
  return settleSubscription(deps, i.orderId, claimed, sub.value, customerRef, card.value.id);
}

/**
 * A subscription Culqi created for an order (from the checkout, or re-fetched by the webhook when the checkout's
 * answer was lost): activate it with the dates Culqi returned, or stop it at Culqi when the activation is refused.
 */
export async function settleSubscription(
  deps: CheckoutDeps, orderId: string, order: Pick<ClaimedOrder, 'amountMinor' | 'currency' | 'trialDays'>, s: ProviderSubscription,
  customerRef: string, cardRef: string,
): Promise<CheckoutOutcome> {
  const { store, provider } = deps;
  // Trial: the free period ends at the first charge (UNVERIFIED which field Culqi fills: trial_end or next date).
  const trialEnd = order.trialDays > 0 ? (s.trialEnd ?? s.nextBillingDate) : null;
  const periodEnd = s.nextBillingDate ?? trialEnd;
  try {
    if (s.orderId && s.orderId !== orderId) throw new BillingRefused('order_mismatch');
    if (!periodEnd) throw new BillingRefused('bad_period');
    const status = await store.activateSubscription({
      orderId, provider: provider.name, subRef: s.id, customerRef, cardRef,
      amountMinor: order.amountMinor, currency: order.currency, trialEnd, periodEnd, livemode: provider.livemode,
    });
    return { status: status === 'trialing' ? 'trialing' : 'paid', orderId };
  } catch (e) {
    if (!(e instanceof BillingRefused)) throw e;
    // Settled before with THIS subscription (a replay): nothing more to do.
    const o = await store.findOrder(orderId);
    if (o && o.providerRef === s.id && (o.status === 'paid' || o.status === 'trialing')) return { status: o.status as 'paid' | 'trialing', orderId };
    // Not what the person accepted (trial length, dates, already Plus, an older renewal still open): stop it at Culqi
    // now and close the order WITH the subscription reference, so every later event of it is attributed: a failed
    // cancel is retried by its next webhook, and any charge it makes is flagged and refunded (culqi-webhook.ts).
    const cancel = await provider.cancelSubscription(s.id);
    deps.log?.({ event: 'billing_subscription_refused', code: clip(e.code), canceled_at_provider: cancel.ok || cancel.kind === 'not_found' });
    try {
      await store.failOrder(orderId, clip(`activation_refused:${e.code}`), s.id);
    } catch (f) {
      if (!(f instanceof BillingRefused)) throw f;
    }
    // A trial charged nothing. Without a trial the plan charged at creation: that charge is refunded when its webhook
    // arrives (flagged as needs_refund in the ledger until then).
    return order.trialDays > 0 ? { status: 'refused', code: e.code } : { status: 'needs_refund', code: e.code };
  }
}

/**
 * "Cancelar renovación": cancel at Culqi first (no more charges), then record it. If Culqi fails nothing changes.
 * Returns the date until which Plus stays.
 */
export async function cancelRenewal(deps: CheckoutDeps, i: { userId: string; subRef: string }): Promise<{ ok: true; until: Date | null } | { ok: false; code: string }> {
  const { store, provider } = deps;
  if (!isCulqiId(i.subRef, 'sxn', provider.livemode)) return { ok: false, code: 'bad_subscription' };
  const r = await provider.cancelSubscription(i.subRef);
  if (!r.ok) {
    if (r.kind !== 'not_found') return { ok: false, code: r.code };
    // DELETE said "not found": maybe a previous attempt cancelled it and the database step did not finish. Recorded
    // only when Culqi confirms it is gone (GET 404); anything else is not proof that no other charge can happen.
    // UNVERIFIED: whether a cancelled subscription answers GET 404 or 200 with a status (meanings not published).
    const g = await provider.getSubscription(i.subRef);
    if (g.ok) return { ok: false, code: 'still_at_provider' };
    if (g.kind !== 'not_found') return { ok: false, code: g.code };
  }
  try {
    return { ok: true, until: await store.cancel(i.userId, provider.name, i.subRef) };
  } catch (e) {
    if (e instanceof BillingRefused) return { ok: false, code: e.code };
    throw e;
  }
}
