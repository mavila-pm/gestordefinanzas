import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { activateSub, beginCharge, orderFor, resetBilling } from './billing-helpers';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

describe.skipIf(!DATABASE_URL)('billing: plans, orders, demo purchase, server-only activation', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => { await resetBilling(pool); });
  afterAll(async () => { await pool?.end(); });

  it('prices come from the server: Mensual US$ 4 until 2026 and US$ 9 from 2027 (Lima), Anual 59, Vitalicio 198', async () => {
    const p = async (plan: string, at: string) => Number((await pool.query('select public.billing_price($1, $2) as v', [plan, at])).rows[0].v);
    expect(await p('monthly', '2026-12-31T23:59:00-05:00')).toBe(400);
    expect(await p('monthly', '2027-01-01T00:00:00-05:00')).toBe(900);
    expect(await p('annual', '2026-10-12T12:00:00-05:00')).toBe(5900);
    expect(await p('lifetime', '2026-10-12T12:00:00-05:00')).toBe(19800);
  });

  it('an order is priced and trialed by the server; clients cannot write orders or their plan', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const id = (await c.query(`select public.billing_create_order('monthly', public.billing_price('monthly')) as id`)).rows[0].id as string;
      const o = (await c.query('select plan_code, currency, amount_minor, trial_days, status from public.billing_orders where id = $1', [id])).rows[0];
      expect(o).toEqual({ plan_code: 'monthly', currency: 'USD', amount_minor: expect.anything(), trial_days: 14, status: 'pending' });
      expect([400, 900]).toContain(Number(o.amount_minor));
      const life = (await c.query(`select public.billing_create_order('lifetime', public.billing_price('lifetime')) as id`)).rows[0].id as string;
      expect((await c.query('select trial_days from public.billing_orders where id = $1', [life])).rows[0].trial_days).toBe(0);
      expect(await errorMessage(c, `select public.billing_create_order('weekly', 400)`)).toBe('bad_plan');
      expect(await errorCode(c, `insert into public.billing_orders (user_id, plan_code, amount_minor, terms_accepted_at) values ($1, 'lifetime', 1, now())`, [USER_A])).toBe('42501');
      expect(await errorCode(c, `update public.billing_orders set status = 'paid' where id = $1`, [id])).toBe('42501');
      expect(await errorCode(c, `select public.billing_activate($1, 'culqi', 'chr_x', 400, 'USD')`, [id])).toBe('42501');
      expect(await errorMessage(c, `select public.billing_create_order('lifetime', 100)`)).toBe('price_changed');
      // The first version (no expected price) can no longer be called.
      expect(await errorCode(c, `select public.billing_create_order('lifetime'::text)`)).toBe('42501');
    });
  });

  it('A never sees B orders; anon gets nothing', async () => {
    await orderFor(pool, USER_B, 'annual');
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query('select * from public.billing_orders')).rowCount).toBe(0);
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, 'select * from public.billing_orders')).toBe('42501');
      expect(await errorCode(c, `select public.billing_create_order('monthly', public.billing_price('monthly'))`)).toBe('42501');
    });
  });

  it('demo purchase: only demo accounts, once per order, the real subscription never changes', async () => {
    const order = await orderFor(pool, USER_A, 'annual');
    // Not a demo account: refused (a real account can never get Plus without a confirmed payment).
    expect(await asRole(pool, 'authenticated', USER_A, (c) => errorMessage(c, 'select public.billing_simulate_payment($1)', [order]))).toBe('not_demo');
    await pool.query('insert into public.demo_access (user_id) values ($1)', [USER_A]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query('select public.billing_simulate_payment($1) as s', [order])).rows[0].s).toBe('simulated');
      expect(await errorMessage(c, 'select public.billing_simulate_payment($1)', [order])).toBe('order_not_pending');
      expect((await c.query('select simulated_plan from public.demo_access')).rows[0].simulated_plan).toBe('trial');
      expect((await c.query('select * from public.subscriptions')).rowCount).toBe(0);
    });
    // Someone else's order cannot be completed.
    await pool.query('insert into public.demo_access (user_id) values ($1)', [USER_B]);
    const other = await orderFor(pool, USER_A, 'lifetime');
    expect(await asRole(pool, 'authenticated', USER_B, (c) => errorMessage(c, 'select public.billing_simulate_payment($1)', [other]))).toBe('order_not_pending');
  });

  it('server activation: paid Vitalicio = Plus without end; trial order = trialing; idempotent per reference', async () => {
    const life = await orderFor(pool, USER_A, 'lifetime');
    expect((await pool.query(`select public.billing_activate($1, 'culqi', 'chr_1', (select amount_minor from public.billing_orders where id = $1), 'USD') as s`, [life])).rows[0].s).toBe('paid');
    expect((await pool.query(`select public.billing_activate($1, 'culqi', 'chr_1', (select amount_minor from public.billing_orders where id = $1), 'USD') as s`, [life])).rows[0].s).toBe('paid');
    expect((await pool.query('select plan, status, billing_plan, current_period_end from public.subscriptions where user_id = $1', [USER_A])).rows[0])
      .toEqual({ plan: 'plus', status: 'active', billing_plan: 'lifetime', current_period_end: null });
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, `select public.billing_create_order('monthly', public.billing_price('monthly'))`)).toBe('already_lifetime');
    });
    const monthly = await orderFor(pool, USER_B, 'monthly');
    // Recurring plans are activated only with the provider's subscription and dates (ADR-0018).
    await expect(pool.query(`select public.billing_activate($1, 'culqi', 'sxn_1', (select amount_minor from public.billing_orders where id = $1), 'USD')`, [monthly])).rejects.toThrow('recurring_needs_subscription');
    await beginCharge(pool, monthly, USER_B);
    expect(await activateSub(pool, monthly, { sub: 'sxn_test_b1' })).toBe('trialing');
    const sub = (await pool.query('select status, billing_plan, trial_ends_at, current_period_end from public.subscriptions where user_id = $1', [USER_B])).rows[0];
    expect(sub.status).toBe('trialing');
    expect(Math.round((sub.trial_ends_at.getTime() - Date.now()) / 86_400_000)).toBe(14);
    // A second trial is never given: a new order for the same person has no trial days.
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect(await errorMessage(c, `select public.billing_create_order('annual', public.billing_price('annual'))`)).toBe('already_plus');
    });
  });

  it('one purchase at a time: a new order closes the pending one; a paid plan is never overwritten', async () => {
    const life = await orderFor(pool, USER_A, 'lifetime');
    const monthly = await orderFor(pool, USER_A, 'monthly');
    expect((await pool.query('select status, failure from public.billing_orders where id = $1', [life])).rows[0]).toEqual({ status: 'failed', failure: 'superseded' });
    await expect(pool.query(`select public.billing_activate($1, 'culqi', 'chr_c1', 19800, 'USD')`, [life])).rejects.toThrow('order_not_pending');
    await beginCharge(pool, monthly, USER_A);
    expect(await activateSub(pool, monthly, { sub: 'sxn_test_c2' })).toBe('trialing');
    // With a paid plan in place, nothing else can be bought or activated over it.
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, `select public.billing_create_order('lifetime', public.billing_price('lifetime'))`)).toBe('already_plus');
    });
  });

  it('activation checks what the provider charged, needs a reference, expires, and re-checks the trial', async () => {
    const o = await orderFor(pool, USER_A, 'lifetime');
    await expect(pool.query(`select public.billing_activate($1, 'culqi', 'chr_r1', 100, 'USD')`, [o])).rejects.toThrow('amount_mismatch');
    await expect(pool.query(`select public.billing_activate($1, 'culqi', 'chr_r1', 19800, 'PEN')`, [o])).rejects.toThrow('amount_mismatch');
    await expect(pool.query(`select public.billing_activate($1, 'culqi', null, 19800, 'USD')`, [o])).rejects.toThrow('bad_reference');
    await expect(pool.query(`select public.billing_activate($1, 'culqi', 'chr r1', 19800, 'USD')`, [o])).rejects.toThrow('bad_reference');
    // A card-less trial started between ordering and paying: the order's trial is no longer available, and this is
    // decided before any charge (billing_begin_charge).
    const a = await orderFor(pool, USER_B, 'annual');
    await asRole(pool, 'authenticated', USER_B, async (c) => { await c.query('select public.start_plus_trial()'); await c.query('commit'); await c.query('begin'); });
    await expect(beginCharge(pool, a, USER_B)).rejects.toThrow('trial_no_longer_available');
    const stale = await orderFor(pool, USER_A, 'lifetime');
    await pool.query(`update public.billing_orders set created_at = now() - interval '2 hours' where id = $1`, [stale]);
    await expect(pool.query(`select public.billing_activate($1, 'culqi', 'chr_r2', 19800, 'USD')`, [stale])).rejects.toThrow('order_expired');
  });

  it('parallel order creation for the same person is serialised (no two pending orders)', async () => {
    await Promise.all(['monthly', 'annual', 'lifetime', 'monthly'].map((p) => orderFor(pool, USER_A, p)));
    expect(Number((await pool.query(`select count(*) as n from public.billing_orders where user_id = $1 and status = 'pending'`, [USER_A])).rows[0].n)).toBe(1);
  });
});
