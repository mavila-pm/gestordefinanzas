/**
 * BillingStore: the database side of the billing flows (ADR-0018). Implemented over the privileged pool by
 * src/infrastructure/billing/pg-billing-store.ts, which calls ONLY the service-only SQL functions of migrations
 * 20261020000054–56 (they re-check ownership, amount, currency, mode and dates, and write the ledger).
 * A refusal from SQL (a stable code such as 'order_not_pending') is a BillingRefused; anything else is transient.
 */
export class BillingRefused extends Error {
  constructor(readonly code: string) { super(code); this.name = 'BillingRefused'; }
}

export interface ClaimedOrder { planCode: 'monthly' | 'annual' | 'lifetime'; amountMinor: number; currency: 'USD' | 'PEN'; trialDays: number }

export interface OrderRow {
  id: string; userId: string; planCode: 'monthly' | 'annual' | 'lifetime'; status: string; amountMinor: number; currency: 'USD' | 'PEN';
  trialDays: number; provider: string | null; providerRef: string | null; livemode: boolean | null;
}

export interface SubscriptionRef {
  userId: string; status: string; billingPlan: string | null; providerRef: string | null; cancelAtPeriodEnd: boolean;
  livemode: boolean | null; trialEndsAt: Date | null; currentPeriodEnd: Date | null; amountMinor: number | null; currency: string | null;
}

export interface BillingStore {
  beginCharge(orderId: string, userId: string, provider: string, livemode: boolean): Promise<ClaimedOrder>;
  failOrder(orderId: string, code: string, providerRef?: string | null): Promise<void>;
  activate(orderId: string, provider: string, chargeRef: string, amountMinor: number, currency: string): Promise<string>;
  activateSubscription(i: {
    orderId: string; provider: string; subRef: string; customerRef: string; cardRef: string; amountMinor: number; currency: string;
    trialEnd: Date | null; periodEnd: Date; livemode: boolean;
  }): Promise<string>;
  getCustomer(userId: string, provider: string, livemode: boolean): Promise<{ customerRef: string; cardRef: string | null } | null>;
  saveCustomer(userId: string, provider: string, livemode: boolean, customerRef: string, cardRef: string | null): Promise<void>;
  recordRenewal(provider: string, subRef: string, chargeRef: string, amountMinor: number, currency: string, periodEnd: Date): Promise<string>;
  markPastDue(provider: string, subRef: string, chargeRef: string, code: string): Promise<string>;
  cancel(userId: string, provider: string, subRef: string): Promise<Date | null>;
  refund(provider: string, chargeRef: string, refundRef: string, amountMinor: number, currency: string): Promise<string>;
  findOrder(orderId: string): Promise<OrderRow | null>;
  /** The order the provider object (charge or subscription) was settled or closed with, if any. */
  findOrderByRef(provider: string, ref: string): Promise<OrderRow | null>;
  /**
   * A successful charge of a subscription no row holds (billing_flag_charge): recorded once as needs_refund. 'ours'
   * when an order or a recorded cancellation links the subscription to Velsuno (refund it); else the owner reviews it.
   * Refused with 'subscription_known' when a row holds the subscription (a period charge).
   */
  flagCharge(i: { provider: string; chargeRef: string; subRef: string; amountMinor: number; currency: string; livemode: boolean; code: string }): Promise<{ state: 'flagged' | 'duplicate'; ours: boolean }>;
  findSubscription(provider: string, ref: string): Promise<SubscriptionRef | null>;
  /** Webhook receipt (idempotency): 'new' (process it), 'retry' (received before, never closed) or 'done'. */
  receive(provider: string, eventRef: string, type: string, objectRef: string | null, livemode: boolean | null): Promise<{ id: number; state: 'new' | 'retry' | 'done' }>;
  close(id: number, outcome: 'processed' | 'ignored' | 'rejected' | 'needs_refund', detail: string | null): Promise<void>;
}
