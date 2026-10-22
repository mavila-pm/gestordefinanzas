import type { BillingProvider, ProviderCharge, ProviderPlan, ProviderResult, ProviderSubscription } from '../src/billing/provider';
import { BillingRefused, type BillingStore, type OrderRow } from '../src/billing/store';

/**
 * Test doubles for the billing flows (ADR-0018). FakeProvider answers like Culqi and counts every call (the real API
 * is never reached). MemoryStore mimics the SQL contract of migrations 054–056 closely enough for flow tests; the
 * real SQL is exercised by tests/db/billing-checkout.test.ts with the same flows.
 */
export const ORDER = '11111111-1111-4111-8111-111111111111';
export const USER = '00000000-0000-4000-8000-00000000000a';
const err = (kind: 'declined' | 'unknown' | 'unavailable' | 'invalid' | 'not_found', code: string = kind) => ({ ok: false as const, kind, code, status: null });
export const providerError = err;

export function charge(o: Partial<ProviderCharge> = {}): ProviderCharge {
  return { id: 'chr_test_A1b2C3d4E5f6G7h8', amountMinor: 19800, currency: 'USD', succeeded: true, refundedMinor: 0, orderId: ORDER, subscriptionRef: null, livemode: false, ...o };
}
export function plan(o: Partial<ProviderPlan> = {}): ProviderPlan {
  return { id: 'pln_test_M1o2N3t4H5l6Y7t8', amountMinor: 400, currency: 'USD', interval: 'month', intervalCount: 1, freeInitialCycles: { count: 14, unit: 1 }, chargesAtStart: false, livemode: false, ...o };
}
export function subscription(o: Partial<ProviderSubscription> = {}): ProviderSubscription {
  const end = new Date(Date.now() + 14 * 86_400_000);
  return { id: 'sxn_test_S1u2B3s4C5r6I7p8', rawStatus: 1, planRef: 'pln_test_M1o2N3t4H5l6Y7t8', customerRef: 'cus_test_C1u2S3t4O5m6E7r8', cardRef: 'crd_test_C1a2R3d4O5k6A7b8', trialEnd: end, nextBillingDate: end, orderId: ORDER, livemode: false, ...o };
}

type Answer<T> = ProviderResult<T> | (() => ProviderResult<T>);
export class FakeProvider implements BillingProvider {
  readonly name = 'culqi';
  calls: string[] = [];
  answers: {
    charge?: Answer<ProviderCharge>; getCharge?: Answer<ProviderCharge>; refund?: Answer<{ id: string; chargeRef: string; amountMinor: number; livemode: boolean }>;
    getRefund?: Answer<{ id: string; chargeRef: string; amountMinor: number; livemode: boolean }>;
    createCustomer?: Answer<{ id: string }>; findCustomerByEmail?: Answer<{ id: string } | null>; createCard?: Answer<{ id: string }>;
    getPlan?: Answer<ProviderPlan>; createSubscription?: Answer<ProviderSubscription>; getSubscription?: Answer<ProviderSubscription>;
    cancelSubscription?: Answer<{ deleted: true }>;
  } = {};
  constructor(readonly livemode = false) {}
  private a<T>(name: keyof FakeProvider['answers'], fallback: ProviderResult<T>): Promise<ProviderResult<T>> {
    this.calls.push(name);
    const v = this.answers[name] as Answer<T> | undefined;
    return Promise.resolve(typeof v === 'function' ? v() : v ?? fallback);
  }
  charge() { return this.a('charge', { ok: true, value: charge() }); }
  getCharge() { return this.a('getCharge', { ok: true, value: charge() }); }
  refund(i: { chargeRef: string; amountMinor: number }) { return this.a('refund', { ok: true, value: { id: 'ref_test_R1e2F3u4N5d6O7k8', chargeRef: i.chargeRef, amountMinor: i.amountMinor, livemode: false } }); }
  getRefund() { return this.a('getRefund', { ok: true, value: { id: 'ref_test_R1e2F3u4N5d6O7k8', chargeRef: 'chr_test_A1b2C3d4E5f6G7h8', amountMinor: 19800, livemode: false } }); }
  createCustomer() { return this.a('createCustomer', { ok: true, value: { id: 'cus_test_C1u2S3t4O5m6E7r8' } }); }
  findCustomerByEmail() { return this.a<{ id: string } | null>('findCustomerByEmail', { ok: true, value: null }); }
  createCard() { return this.a('createCard', { ok: true, value: { id: 'crd_test_C1a2R3d4O5k6A7b8' } }); }
  getPlan() { return this.a('getPlan', { ok: true, value: plan() }); }
  createSubscription() { return this.a('createSubscription', { ok: true, value: subscription() }); }
  getSubscription() { return this.a('getSubscription', { ok: true, value: subscription() }); }
  cancelSubscription() { return this.a<{ deleted: true }>('cancelSubscription', { ok: true, value: { deleted: true } }); }
}

/** In-memory BillingStore with the SQL contract's essentials: claim once, settle once, refuse what was not sold. */
export class MemoryStore implements BillingStore {
  orders = new Map<string, OrderRow>();
  customers = new Map<string, { customerRef: string; cardRef: string | null }>();
  subs = new Map<string, { userId: string; status: string; cancel: boolean; periodEnd: Date | null; trialEnd: Date | null; amountMinor: number; currency: string; plan: string }>();
  events: string[] = [];
  plusUsers = new Set<string>();

  addOrder(o: Partial<OrderRow> = {}) {
    const row: OrderRow = { id: ORDER, userId: USER, planCode: 'lifetime', status: 'pending', amountMinor: 19800, currency: 'USD', trialDays: 0, provider: null, providerRef: null, livemode: null, ...o };
    this.orders.set(row.id, row);
    return row;
  }
  private order(id: string) { const o = this.orders.get(id); if (!o) throw new BillingRefused('order_not_found'); return o; }
  async beginCharge(orderId: string, userId: string, provider: string, livemode: boolean) {
    const o = this.order(orderId);
    if (o.userId !== userId) throw new BillingRefused('order_not_found');
    if (o.status !== 'pending') throw new BillingRefused('order_not_pending');
    if (this.plusUsers.has(userId)) throw new BillingRefused('already_plus');
    Object.assign(o, { status: 'processing', provider, livemode });
    this.events.push(`begin:${orderId}`);
    return { planCode: o.planCode, amountMinor: o.amountMinor, currency: o.currency, trialDays: o.trialDays };
  }
  async failOrder(orderId: string, code: string, ref: string | null = null) {
    const o = this.order(orderId);
    if (o.status === 'failed' || o.status === 'refunded') return;
    if (o.status !== 'pending' && o.status !== 'processing') throw new BillingRefused('order_already_settled');
    Object.assign(o, { status: 'failed', providerRef: ref ?? o.providerRef });
    this.events.push(`fail:${orderId}:${code}${ref ? ':needs_refund' : ''}`);
  }
  async activate(orderId: string, provider: string, ref: string, amount: number, currency: string) {
    const o = this.order(orderId);
    if (o.status === 'paid') { if (o.providerRef === ref) return 'paid'; throw new BillingRefused('order_already_settled'); }
    if (o.status !== 'processing' || o.provider !== provider) throw new BillingRefused('order_not_pending');
    if (amount !== o.amountMinor || currency !== o.currency) throw new BillingRefused('amount_mismatch');
    if (this.plusUsers.has(o.userId)) throw new BillingRefused('already_plus');
    Object.assign(o, { status: 'paid', providerRef: ref });
    this.plusUsers.add(o.userId);
    this.events.push(`activate:${orderId}`);
    return 'paid';
  }
  async activateSubscription(i: Parameters<BillingStore['activateSubscription']>[0]) {
    const o = this.order(i.orderId);
    if ((o.status === 'paid' || o.status === 'trialing') && o.providerRef === i.subRef) return o.status;
    if (o.status !== 'processing') throw new BillingRefused('order_not_pending');
    if (i.amountMinor !== o.amountMinor || i.currency !== o.currency) throw new BillingRefused('amount_mismatch');
    if ((o.trialDays > 0) !== (i.trialEnd !== null)) throw new BillingRefused('trial_mismatch');
    // Same bound as SQL: the trial Culqi applied is the one accepted (± 1 day).
    if (i.trialEnd && Math.abs(i.trialEnd.getTime() - (Date.now() + o.trialDays * 86_400_000)) > 86_400_000) throw new BillingRefused('trial_mismatch');
    const status = o.trialDays > 0 ? 'trialing' : 'paid';
    Object.assign(o, { status, providerRef: i.subRef });
    this.subs.set(i.subRef, { userId: o.userId, status: o.trialDays > 0 ? 'trialing' : 'active', cancel: false, periodEnd: i.periodEnd, trialEnd: i.trialEnd, amountMinor: o.amountMinor, currency: o.currency, plan: o.planCode });
    this.plusUsers.add(o.userId);
    this.events.push(`activate:${i.orderId}`);
    return status;
  }
  async getCustomer(userId: string) { return this.customers.get(userId) ?? null; }
  async saveCustomer(userId: string, _p: string, _l: boolean, customerRef: string, cardRef: string | null) { this.customers.set(userId, { customerRef, cardRef }); }
  async recordRenewal(_p: string, subRef: string, chargeRef: string, amount: number, currency: string, periodEnd: Date) {
    const s = this.subs.get(subRef);
    if (!s) throw new BillingRefused('unknown_subscription');
    if (this.events.includes(`renewal:${chargeRef}`)) return 'duplicate';
    if (amount !== s.amountMinor || currency !== s.currency) throw new BillingRefused('amount_mismatch');
    this.events.push(`renewal:${chargeRef}`);
    if (s.cancel) return 'needs_refund';
    Object.assign(s, { status: 'active', periodEnd });
    return 'renewed';
  }
  async markPastDue(_p: string, subRef: string, chargeRef: string) {
    const s = this.subs.get(subRef);
    if (!s) throw new BillingRefused('unknown_subscription');
    if (this.events.includes(`past_due:${chargeRef}`)) return 'duplicate';
    this.events.push(`past_due:${chargeRef}`);
    s.status = 'past_due';
    return 'past_due';
  }
  async cancel(userId: string, _p: string, subRef: string) {
    const s = this.subs.get(subRef);
    if (!s || s.userId !== userId) throw new BillingRefused('unknown_subscription');
    if (!s.cancel) { s.cancel = true; this.events.push(`cancel:${subRef}`); }
    return s.status === 'trialing' ? s.trialEnd : s.periodEnd;
  }
  async refund(_p: string, chargeRef: string, refundRef: string, amount: number) {
    if (this.events.includes(`refund:${refundRef}`)) return 'duplicate';
    const o = [...this.orders.values()].find((x) => x.providerRef === chargeRef);
    if (!o) throw new BillingRefused('unknown_charge');
    this.events.push(`refund:${refundRef}`);
    if (amount === o.amountMinor && (o.status === 'paid' || o.status === 'failed')) { o.status = 'refunded'; this.plusUsers.delete(o.userId); }
    return 'refunded';
  }
  async findOrder(id: string) { return this.orders.get(id) ?? null; }
  async findOrderByProviderRef(_p: string, ref: string) { return [...this.orders.values()].find((o) => o.providerRef === ref) ?? null; }
  async findSubscription(_p: string, ref: string) {
    const s = this.subs.get(ref);
    return s ? { userId: s.userId, status: s.status, billingPlan: s.plan, providerRef: ref, cancelAtPeriodEnd: s.cancel, livemode: false, trialEndsAt: s.trialEnd, currentPeriodEnd: s.periodEnd, amountMinor: s.amountMinor, currency: s.currency } : null;
  }
  receipts = new Map<string, { id: number; done: boolean; outcome?: string; detail?: string | null }>();
  async receive(_p: string, eventRef: string) {
    const r = this.receipts.get(eventRef);
    if (r) return { id: r.id, state: r.done ? ('done' as const) : ('retry' as const) };
    const id = this.receipts.size + 1;
    this.receipts.set(eventRef, { id, done: false });
    return { id, state: 'new' as const };
  }
  async close(id: number, outcome: string, detail: string | null) {
    for (const r of this.receipts.values()) if (r.id === id && !r.done) Object.assign(r, { done: true, outcome, detail });
  }
}
