import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { activateSub, beginCharge, days, effectivePlan, orderFor, resetBilling } from './billing-helpers';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

const sub = async (pool: pg.Pool, user: string) =>
  (await pool.query('select plan, status, billing_plan, cancel_at_period_end, canceled_at is not null as canceled, livemode, billing_amount_minor, billing_currency, provider_ref, provider_customer_ref, trial_ends_at, current_period_end from public.subscriptions where user_id = $1', [user])).rows[0];
const q1 = async (pool: pg.Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0]?.s as string;

describe.skipIf(!DATABASE_URL)('billing lifecycle (service only, idempotent per provider reference)', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => { await resetBilling(pool); });
  afterAll(async () => { await pool?.end(); });

  /** A monthly order with a trial, claimed and activated with the provider's dates. */
  async function trialing(user = USER_A, ref = 'sxn_test_a1') {
    const o = await orderFor(pool, user, 'monthly');
    await beginCharge(pool, o, user);
    await pool.query(`select public.billing_save_customer($1, 'culqi', true, $2, null)`, [user, `cus_test_${user.slice(-1)}`]);
    expect(await activateSub(pool, o, { sub: ref })).toBe('trialing');
    return o;
  }

  it('subscription activation stores the provider dates, mode, amount; replay is a no-op; another ref is refused', async () => {
    const trialEnd = days(14);
    const o = await orderFor(pool, USER_A, 'annual');
    // Not claimed yet (no charge in flight): refused.
    await expect(activateSub(pool, o)).rejects.toThrow('order_not_pending');
    await beginCharge(pool, o, USER_A);
    await pool.query(`select public.billing_save_customer($1, 'culqi', true, 'cus_test_a1', null)`, [USER_A]);
    expect(await activateSub(pool, o, { trialEnd, periodEnd: trialEnd })).toBe('trialing');
    expect(await activateSub(pool, o, { trialEnd, periodEnd: trialEnd })).toBe('trialing');
    await expect(activateSub(pool, o, { sub: 'sxn_test_other' })).rejects.toThrow('order_already_settled');
    const s = await sub(pool, USER_A);
    expect(s).toMatchObject({ plan: 'plus', status: 'trialing', billing_plan: 'annual', cancel_at_period_end: false, livemode: true,
      billing_amount_minor: '5900', billing_currency: 'USD', provider_ref: 'sxn_test_a1', provider_customer_ref: 'cus_test_a1' });
    expect(s.trial_ends_at.toISOString()).toBe(trialEnd);
    expect((await pool.query(`select card_ref from public.billing_customers where user_id = $1`, [USER_A])).rows[0].card_ref).toBe('crd_test_a1');
    expect(await effectivePlan(pool, USER_A)).toBe('trial');
  });

  it('activation refuses what was not sold: amount, currency, mode, trial length, period bounds', async () => {
    const o = await orderFor(pool, USER_A, 'monthly');
    await beginCharge(pool, o, USER_A);
    await expect(activateSub(pool, o, { amount: 900 })).rejects.toThrow('amount_mismatch');
    await expect(activateSub(pool, o, { currency: 'PEN' })).rejects.toThrow('amount_mismatch');
    await expect(activateSub(pool, o, { livemode: false })).rejects.toThrow('bad_reference');
    await expect(activateSub(pool, o, { trialEnd: null, periodEnd: days(30) })).rejects.toThrow('trial_mismatch');
    await expect(activateSub(pool, o, { trialEnd: days(30) })).rejects.toThrow('trial_mismatch');
    await expect(activateSub(pool, o, { periodEnd: days(60) })).rejects.toThrow('bad_period');
    await expect(activateSub(pool, o, { sub: 'sxn test' })).rejects.toThrow('bad_reference');
    // A person who already used the trial: the provider must not apply one either.
    const b = await orderFor(pool, USER_B, 'annual');
    await pool.query(`update public.billing_orders set trial_days = 0 where id = $1`, [b]);
    await beginCharge(pool, b, USER_B);
    await expect(activateSub(pool, b, { sub: 'sxn_test_b1' })).rejects.toThrow('trial_mismatch');
    await expect(activateSub(pool, b, { sub: 'sxn_test_b1', trialEnd: null, periodEnd: days(400) })).rejects.toThrow('bad_period');
    expect(await activateSub(pool, b, { sub: 'sxn_test_b1', trialEnd: null, periodEnd: days(365) })).toBe('paid');
    expect((await sub(pool, USER_B)).status).toBe('active');
  });

  it('renewal: trial → active until the provider next billing date; replay, wrong amount, unknown sub, stale period', async () => {
    await trialing();
    const next = days(44);
    expect(await q1(pool, `select public.billing_record_renewal('culqi', 'sxn_test_a1', 'chr_test_r1', 400, 'USD', $1) as s`, [next])).toBe('renewed');
    expect(await q1(pool, `select public.billing_record_renewal('culqi', 'sxn_test_a1', 'chr_test_r1', 400, 'USD', $1) as s`, [next])).toBe('duplicate');
    expect(await sub(pool, USER_A)).toMatchObject({ status: 'active' });
    expect((await sub(pool, USER_A)).current_period_end.toISOString()).toBe(next);
    await expect(pool.query(`select public.billing_record_renewal('culqi', 'sxn_test_a1', 'chr_test_r2', 900, 'USD', $1)`, [days(20)])).rejects.toThrow('amount_mismatch');
    await expect(pool.query(`select public.billing_record_renewal('culqi', 'sxn_test_zz', 'chr_test_r2', 400, 'USD', $1)`, [days(20)])).rejects.toThrow('unknown_subscription');
    await expect(pool.query(`select public.billing_record_renewal('culqi', 'sxn_test_a1', 'chr_test_r2', 400, 'USD', $1)`, [days(20)])).rejects.toThrow('bad_period');
    expect(await effectivePlan(pool, USER_A)).toBe('plus');
  });

  it('past_due keeps Plus during the grace days only, then a successful charge brings it back to active', async () => {
    await trialing();
    // The first charge at the end of the trial failed.
    await pool.query(`update public.subscriptions set trial_ends_at = now() - interval '1 day', current_period_end = now() - interval '1 day' where user_id = $1`, [USER_A]);
    expect(await q1(pool, `select public.billing_mark_past_due('culqi', 'sxn_test_a1', 'chr_test_f1', 'card_declined') as s`)).toBe('past_due');
    expect(await q1(pool, `select public.billing_mark_past_due('culqi', 'sxn_test_a1', 'chr_test_f1', 'card_declined') as s`)).toBe('duplicate');
    expect((await sub(pool, USER_A)).status).toBe('past_due');
    expect(await effectivePlan(pool, USER_A)).toBe('plus');
    await pool.query(`update public.subscriptions set current_period_end = now() - interval '4 days' where user_id = $1`, [USER_A]);
    expect(await effectivePlan(pool, USER_A)).toBe('free');
    // Data is never touched by payment state; a later successful charge restores Plus.
    expect(await q1(pool, `select public.billing_record_renewal('culqi', 'sxn_test_a1', 'chr_test_ok', 400, 'USD', $1) as s`, [days(30)])).toBe('renewed');
    expect(await effectivePlan(pool, USER_A)).toBe('plus');
  });

  it('cancel at period end: Plus until the paid date, no grace, idempotent; a charge after it is flagged, never granted', async () => {
    await trialing();
    await pool.query(`select public.billing_record_renewal('culqi', 'sxn_test_a1', 'chr_test_r1', 400, 'USD', $1)`, [days(25)]);
    const until = (await pool.query(`select public.billing_cancel($1, 'culqi', 'sxn_test_a1') as d`, [USER_A])).rows[0].d as Date;
    expect(until.toISOString()).toBe(days(25).slice(0, 10) + until.toISOString().slice(10));
    expect((await pool.query(`select public.billing_cancel($1, 'culqi', 'sxn_test_a1') as d`, [USER_A])).rows[0].d.toISOString()).toBe(until.toISOString());
    expect(await sub(pool, USER_A)).toMatchObject({ status: 'active', cancel_at_period_end: true, canceled: true });
    expect(await effectivePlan(pool, USER_A)).toBe('plus');
    // Bought nothing twice while it lasts.
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, `select public.billing_create_order('annual', public.billing_price('annual'))`)).toBe('already_plus');
    });
    expect(await q1(pool, `select public.billing_record_renewal('culqi', 'sxn_test_a1', 'chr_test_r9', 400, 'USD', $1) as s`, [days(30)])).toBe('needs_refund');
    expect((await sub(pool, USER_A)).current_period_end.toISOString()).toBe(until.toISOString());
    await pool.query(`update public.subscriptions set current_period_end = now() - interval '1 minute' where user_id = $1`, [USER_A]);
    expect(await effectivePlan(pool, USER_A)).toBe('free');
    // After the period: a new purchase is possible (no trial again).
    const again = await orderFor(pool, USER_A, 'annual');
    expect((await pool.query('select trial_days from public.billing_orders where id = $1', [again])).rows[0].trial_days).toBe(0);
    await expect(pool.query(`select public.billing_cancel($1, 'culqi', 'sxn_test_bad')`, [USER_A])).rejects.toThrow('unknown_subscription');
    await expect(pool.query(`select public.billing_cancel($1, 'culqi', 'sxn_test_a1')`, [USER_B])).rejects.toThrow('unknown_subscription');
  });

  it('cancelling a card-backed trial: Plus until the trial ends, then Free with no charge', async () => {
    await trialing();
    const until = (await pool.query(`select public.billing_cancel($1, 'culqi', 'sxn_test_a1') as d`, [USER_A])).rows[0].d as Date;
    expect(Math.round((until.getTime() - Date.now()) / 86_400_000)).toBe(14);
    expect(await effectivePlan(pool, USER_A)).toBe('trial');
    await pool.query(`update public.subscriptions set trial_ends_at = now() - interval '1 minute' where user_id = $1`, [USER_A]);
    expect(await effectivePlan(pool, USER_A)).toBe('free');
  });

  it('refunds: full Vitalicio refund ends the plan (traceable), partial is recorded, replay no-op, unknown refused', async () => {
    const life = await orderFor(pool, USER_A, 'lifetime');
    await beginCharge(pool, life, USER_A);
    await pool.query(`select public.billing_activate($1, 'culqi', 'chr_test_life', 19800, 'USD')`, [life]);
    await expect(pool.query(`select public.billing_cancel($1, 'culqi', 'chr_test_life')`, [USER_A])).rejects.toThrow('not_recurring');
    expect(await q1(pool, `select public.billing_refund('culqi', 'chr_test_life', 'ref_test_p1', 1000, 'USD') as s`)).toBe('partial');
    expect(await effectivePlan(pool, USER_A)).toBe('plus');
    await expect(pool.query(`select public.billing_refund('culqi', 'chr_test_life', 'ref_test_x', 30000, 'USD')`)).rejects.toThrow('amount_mismatch');
    expect(await q1(pool, `select public.billing_refund('culqi', 'chr_test_life', 'ref_test_f1', 19800, 'USD') as s`)).toBe('refunded');
    expect(await q1(pool, `select public.billing_refund('culqi', 'chr_test_life', 'ref_test_f1', 19800, 'USD') as s`)).toBe('duplicate');
    expect((await pool.query('select status from public.billing_orders where id = $1', [life])).rows[0].status).toBe('refunded');
    expect(await sub(pool, USER_A)).toMatchObject({ status: 'canceled', billing_plan: 'lifetime' });
    expect(await effectivePlan(pool, USER_A)).toBe('free');
    // A charge that went through but could not be activated closes as refunded.
    const y = await orderFor(pool, USER_B, 'lifetime');
    await beginCharge(pool, y, USER_B);
    await pool.query(`select public.billing_fail_order($1, 'activation_refused:already_plus', 'chr_test_orphan')`, [y]);
    expect(await q1(pool, `select public.billing_refund('culqi', 'chr_test_orphan', 'ref_test_o1', 19800, 'USD') as s`)).toBe('refunded');
    expect((await pool.query('select status from public.billing_orders where id = $1', [y])).rows[0].status).toBe('refunded');
    // A period charge is recorded only; an unknown charge is refused.
    await trialing(USER_B, 'sxn_test_b1');
    await pool.query(`select public.billing_record_renewal('culqi', 'sxn_test_b1', 'chr_test_b_r1', 400, 'USD', $1)`, [days(30)]);
    expect(await q1(pool, `select public.billing_refund('culqi', 'chr_test_b_r1', 'ref_test_b1', 400, 'USD') as s`)).toBe('recorded');
    await expect(pool.query(`select public.billing_refund('culqi', 'chr_test_nope', 'ref_test_n1', 400, 'USD')`)).rejects.toThrow('unknown_charge');
  });

  it('customers: one per person and mode; a different reference is refused; references are unique across people', async () => {
    await pool.query(`select public.billing_save_customer($1, 'culqi', true, 'cus_test_a1', null)`, [USER_A]);
    await pool.query(`select public.billing_save_customer($1, 'culqi', true, 'cus_test_a1', 'crd_test_a9')`, [USER_A]);
    await pool.query(`select public.billing_save_customer($1, 'culqi', false, 'cus_test_a2', null)`, [USER_A]);
    expect((await pool.query('select livemode, card_ref from public.billing_customers where user_id = $1 order by livemode', [USER_A])).rows)
      .toEqual([{ livemode: false, card_ref: null }, { livemode: true, card_ref: 'crd_test_a9' }]);
    await expect(pool.query(`select public.billing_save_customer($1, 'culqi', true, 'cus_test_zz', null)`, [USER_A])).rejects.toThrow('customer_mismatch');
    await expect(pool.query(`select public.billing_save_customer($1, 'culqi', true, 'cus_test_a1', null)`, [USER_B])).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(`select public.billing_save_customer($1, 'culqi', true, '<script>', null)`, [USER_B])).rejects.toThrow('bad_reference');
  });

  it('the ledger is server-only and append-only; clients cannot run any lifecycle function', async () => {
    await trialing();
    const ledger = (await pool.query('select type, outcome from public.billing_events where user_id = $1 order by id', [USER_A])).rows;
    expect(ledger).toEqual([{ type: 'order.processing', outcome: 'processed' }, { type: 'plan.activated', outcome: 'processed' }]);
    const id = (await pool.query('select id from public.billing_events limit 1')).rows[0].id;
    await expect(pool.query('update public.billing_events set amount_minor = 1 where id = $1', [id])).rejects.toThrow('billing_events_append_only');
    await expect(pool.query(`update public.billing_events set outcome = 'ignored', processed_at = now() where id = $1`, [id])).rejects.toThrow('billing_events_append_only');
    await expect(pool.query('delete from public.billing_events where id = $1', [id])).rejects.toThrow('billing_events_append_only');
    // A receipt is closed exactly once.
    await pool.query(`insert into public.billing_events (provider, event_ref, source, type, outcome) values ('culqi', 'evt_test_1', 'webhook', 'charge.creation.succeeded', 'received')`);
    await pool.query(`update public.billing_events set outcome = 'processed', processed_at = now() where event_ref = 'evt_test_1'`);
    await expect(pool.query(`update public.billing_events set outcome = 'ignored' where event_ref = 'evt_test_1'`)).rejects.toThrow('billing_events_append_only');
    await expect(pool.query(`insert into public.billing_events (provider, event_ref, source, type, outcome) values ('culqi', 'evt_test_1', 'webhook', 'x.y', 'received')`)).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(`insert into public.billing_events (provider, event_ref, source, type, outcome) values ('culqi', 'evt_test_2', 'webhook', 'x.y', 'hacked')`)).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`insert into public.billing_events (provider, event_ref, source, type, outcome, detail) values ('culqi', 'evt_test_3', 'webhook', 'x.y', 'received', 'Has Spaces')`)).rejects.toMatchObject({ code: '23514' });
    // An event can only reference an order of the same person (composite FK).
    const o = (await pool.query('select id from public.billing_orders where user_id = $1 limit 1', [USER_A])).rows[0].id;
    await expect(pool.query(`insert into public.billing_events (provider, event_ref, source, type, outcome, user_id, order_id) values ('culqi', 'evt_test_4', 'action', 'x.y', 'processed', $1, $2)`, [USER_B, o])).rejects.toMatchObject({ code: '23503' });
    await pool.query(`select public.billing_save_customer($1, 'culqi', true, 'cus_test_b', null)`, [USER_B]);
    for (const [role, user] of [['authenticated', USER_A], ['anon', null]] as const) {
      await asRole(pool, role, user, async (c) => {
        expect(await errorCode(c, 'select * from public.billing_events')).toBe('42501');
        expect(await errorCode(c, 'select * from public.billing_customers')).toBe('42501');
        expect(await errorCode(c, `insert into public.billing_events (provider, event_ref, source, type, outcome) values ('culqi', 'evt_forged', 'webhook', 'x.y', 'received')`)).toBe('42501');
        for (const sql of [
          `select public.billing_save_customer('${USER_A}', 'culqi', true, 'cus_test_x', null)`,
          `select public.billing_activate_subscription('${o}', 'culqi', 'sxn_x1', 'cus_x1', 'crd_x1', 400, 'USD', null, now() + interval '1 month', true)`,
          `select public.billing_record_renewal('culqi', 'sxn_test_a1', 'chr_x1', 400, 'USD', now() + interval '1 month')`,
          `select public.billing_mark_past_due('culqi', 'sxn_test_a1', 'chr_x1', 'x_code')`,
          `select public.billing_cancel('${USER_A}', 'culqi', 'sxn_test_a1')`,
          `select public.billing_refund('culqi', 'chr_x1', 'ref_x1', 400, 'USD')`,
        ]) expect(await errorCode(c, sql), `${role}: ${sql}`).toBe('42501');
      });
    }
    // The person still sees their own subscription and orders (read-only), never another's.
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect((await c.query('select * from public.subscriptions')).rowCount).toBe(0);
      expect((await c.query('select * from public.billing_orders')).rowCount).toBe(0);
      expect(await errorCode(c, `update public.subscriptions set cancel_at_period_end = true`)).toBe('42501');
    });
  });
});
