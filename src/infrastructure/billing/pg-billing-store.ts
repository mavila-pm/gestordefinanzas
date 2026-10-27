import type { Pool } from 'pg';
import { BillingRefused, type BillingStore, type OrderRow, type SubscriptionRef } from '../../billing/store';

/**
 * BillingStore over the privileged pool (lib/server-db.ts, DATABASE_URL). It calls the service-only SQL functions
 * of migrations 20261020000054–56 and reads with explicit filters (the pool bypasses RLS, so every read names the
 * order, provider reference or person it needs). SQL refusals (SQLSTATE 22023/42501 with a stable message such as
 * 'order_not_pending') become BillingRefused; anything else (connection, deadlock, timeout) is rethrown as transient.
 */
const REFUSAL = /^[a-z_]{3,60}$/;

async function q<T = Record<string, unknown>>(pool: Pool, sql: string, params: unknown[]): Promise<T[]> {
  try {
    return (await pool.query(sql, params)).rows as T[];
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if ((err.code === '22023' || err.code === '42501') && err.message && REFUSAL.test(err.message)) throw new BillingRefused(err.message);
    throw e;
  }
}
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const order = (r: Record<string, unknown>): OrderRow => ({
  id: r.id as string, userId: r.user_id as string, planCode: r.plan_code as OrderRow['planCode'], status: r.status as string,
  amountMinor: Number(r.amount_minor), currency: r.currency as OrderRow['currency'], trialDays: Number(r.trial_days),
  provider: (r.provider as string | null) ?? null, providerRef: (r.provider_ref as string | null) ?? null, livemode: (r.livemode as boolean | null) ?? null,
});
const ORDER_COLS = 'id, user_id, plan_code, status, amount_minor, currency::text as currency, trial_days, provider, provider_ref, livemode';

export class PgBillingStore implements BillingStore {
  constructor(private readonly pool: Pool) {}

  async beginCharge(orderId: string, userId: string, provider: string, livemode: boolean) {
    const [r] = await q(this.pool, 'select * from public.billing_begin_charge($1, $2, $3, $4)', [orderId, userId, provider, livemode]);
    if (!r) throw new BillingRefused('order_not_found');
    return { planCode: r.plan_code as 'monthly' | 'annual' | 'lifetime', amountMinor: Number(r.amount_minor), currency: r.currency as 'USD' | 'PEN', trialDays: Number(r.trial_days) };
  }
  async failOrder(orderId: string, code: string, providerRef: string | null = null) {
    await q(this.pool, 'select public.billing_fail_order($1, $2, $3)', [orderId, code, providerRef]);
  }
  async activate(orderId: string, provider: string, chargeRef: string, amountMinor: number, currency: string) {
    const [r] = await q<{ s: string }>(this.pool, 'select public.billing_activate($1, $2, $3, $4, $5) as s', [orderId, provider, chargeRef, amountMinor, currency]);
    return r!.s;
  }
  async activateSubscription(i: Parameters<BillingStore['activateSubscription']>[0]) {
    const [r] = await q<{ s: string }>(this.pool, 'select public.billing_activate_subscription($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as s',
      [i.orderId, i.provider, i.subRef, i.customerRef, i.cardRef, i.amountMinor, i.currency, iso(i.trialEnd), iso(i.periodEnd), i.livemode]);
    return r!.s;
  }
  async getCustomer(userId: string, provider: string, livemode: boolean) {
    const [r] = await q<{ customer_ref: string; card_ref: string | null }>(this.pool,
      'select customer_ref, card_ref from public.billing_customers where user_id = $1 and provider = $2 and livemode = $3', [userId, provider, livemode]);
    return r ? { customerRef: r.customer_ref, cardRef: r.card_ref } : null;
  }
  async saveCustomer(userId: string, provider: string, livemode: boolean, customerRef: string, cardRef: string | null) {
    await q(this.pool, 'select public.billing_save_customer($1, $2, $3, $4, $5)', [userId, provider, livemode, customerRef, cardRef]);
  }
  async recordRenewal(provider: string, subRef: string, chargeRef: string, amountMinor: number, currency: string, periodEnd: Date) {
    const [r] = await q<{ s: string }>(this.pool, 'select public.billing_record_renewal($1, $2, $3, $4, $5, $6) as s', [provider, subRef, chargeRef, amountMinor, currency, periodEnd.toISOString()]);
    return r!.s;
  }
  async markPastDue(provider: string, subRef: string, chargeRef: string, code: string) {
    const [r] = await q<{ s: string }>(this.pool, 'select public.billing_mark_past_due($1, $2, $3, $4) as s', [provider, subRef, chargeRef, code]);
    return r!.s;
  }
  async cancel(userId: string, provider: string, subRef: string) {
    const [r] = await q<{ d: Date | null }>(this.pool, 'select public.billing_cancel($1, $2, $3) as d', [userId, provider, subRef]);
    return r?.d ?? null;
  }
  async refund(provider: string, chargeRef: string, refundRef: string, amountMinor: number, currency: string) {
    const [r] = await q<{ s: string }>(this.pool, 'select public.billing_refund($1, $2, $3, $4, $5) as s', [provider, chargeRef, refundRef, amountMinor, currency]);
    return r!.s;
  }
  async findOrder(orderId: string) {
    const [r] = await q(this.pool, `select ${ORDER_COLS} from public.billing_orders where id = $1`, [orderId]);
    return r ? order(r) : null;
  }
  async findOrderByRef(provider: string, ref: string) {
    const [r] = await q(this.pool, `select ${ORDER_COLS} from public.billing_orders where provider = $1 and provider_ref = $2`, [provider, ref]);
    return r ? order(r) : null;
  }
  async flagCharge(i: Parameters<BillingStore['flagCharge']>[0]) {
    const [r] = await q<{ state: string; ours: boolean }>(this.pool, 'select * from public.billing_flag_charge($1, $2, $3, $4, $5, $6, $7)',
      [i.provider, i.chargeRef, i.subRef, i.amountMinor, i.currency, i.livemode, i.code]);
    return { state: r!.state === 'duplicate' ? ('duplicate' as const) : ('flagged' as const), ours: r!.ours === true };
  }
  async findSubscription(provider: string, ref: string): Promise<SubscriptionRef | null> {
    const [r] = await q(this.pool, `select user_id, status, billing_plan, provider_ref, cancel_at_period_end, livemode, trial_ends_at, current_period_end, billing_amount_minor, billing_currency::text as billing_currency
      from public.subscriptions where provider = $1 and provider_ref = $2`, [provider, ref]);
    if (!r) return null;
    return {
      userId: r.user_id as string, status: r.status as string, billingPlan: (r.billing_plan as string | null) ?? null, providerRef: r.provider_ref as string,
      cancelAtPeriodEnd: !!r.cancel_at_period_end, livemode: (r.livemode as boolean | null) ?? null,
      trialEndsAt: (r.trial_ends_at as Date | null) ?? null, currentPeriodEnd: (r.current_period_end as Date | null) ?? null,
      amountMinor: r.billing_amount_minor == null ? null : Number(r.billing_amount_minor), currency: (r.billing_currency as string | null) ?? null,
    };
  }
  async receive(provider: string, eventRef: string, type: string, objectRef: string | null, livemode: boolean | null) {
    const ins = await q<{ id: string }>(this.pool, `insert into public.billing_events (provider, event_ref, source, type, object_ref, livemode, outcome)
      values ($1, $2, 'webhook', $3, $4, $5, 'received') on conflict (provider, event_ref) do nothing returning id`, [provider, eventRef, type, objectRef, livemode]);
    if (ins[0]) return { id: Number(ins[0].id), state: 'new' as const };
    const [r] = await q<{ id: string; processed_at: Date | null }>(this.pool, 'select id, processed_at from public.billing_events where provider = $1 and event_ref = $2', [provider, eventRef]);
    return { id: Number(r!.id), state: r!.processed_at ? ('done' as const) : ('retry' as const) };
  }
  async close(id: number, outcome: 'processed' | 'ignored' | 'rejected' | 'needs_refund', detail: string | null) {
    await q(this.pool, 'update public.billing_events set outcome = $2, detail = $3, processed_at = now() where id = $1 and processed_at is null', [id, outcome, detail]);
  }
}
