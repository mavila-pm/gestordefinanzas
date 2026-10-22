import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { beginCharge, orderFor, resetBilling } from './billing-helpers';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

/** A raw client acting as the signed-in person, transaction left OPEN (the caller commits or rolls back). */
async function openAs(user: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  await c.query('begin');
  await c.query('set local role authenticated');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
  return c;
}
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: { code?: string; message: string }) => ({ ok: false as const, code: e.code, message: e.message }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!DATABASE_URL)('billing flow: one lock order, a charge in flight is protected (ADR-0018)', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => { await resetBilling(pool); });
  afterAll(async () => { await pool?.end(); });

  it('port of the 40P01 repro: activation and a new order in parallel never deadlock', async () => {
    // Interleaving 1: the new order holds the person lock first; activation waits for it (no row lock taken before).
    const x = await orderFor(pool, USER_A, 'lifetime');
    await beginCharge(pool, x, USER_A);
    const creator = await openAs(USER_A);
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    try {
      const created = await settle(creator.query(`select public.billing_create_order('annual', public.billing_price('annual'))`));
      // The order X is processing: a new order is refused, X is not superseded.
      expect(created).toMatchObject({ ok: false, message: 'payment_in_progress' });
      await creator.query('rollback');
      await admin.query('begin');
      const act = await settle(admin.query(`select public.billing_activate($1, 'culqi', 'chr_test_x1', 19800, 'USD') as s`, [x]));
      expect(act.ok).toBe(true);
      // Interleaving 2: activation holds its locks (open transaction) while the person opens a new order.
      const c2 = await openAs(USER_A);
      const pending = settle(c2.query(`select public.billing_create_order('monthly', public.billing_price('monthly'))`));
      await sleep(200);
      await admin.query('commit');
      const r2 = await pending;
      expect(r2).toMatchObject({ ok: false, message: 'already_lifetime' });
      await c2.query('rollback');
      await c2.end();
    } finally { await creator.end(); await admin.end(); }

    // Stress: 8 rounds of activation ∥ order creation for the same person, committed transactions. No 40P01.
    for (let i = 0; i < 8; i++) {
      await pool.query('delete from public.subscriptions where user_id = $1', [USER_B]);
      const o = await orderFor(pool, USER_B, 'lifetime');
      if (i % 2 === 0) await beginCharge(pool, o, USER_B);
      const results = await Promise.all([
        settle(pool.query(`select public.billing_activate($1, 'culqi', $2, 19800, 'USD')`, [o, `chr_test_s${i}`])),
        settle((async () => { const c = await openAs(USER_B); try { const r = await c.query(`select public.billing_create_order('annual', public.billing_price('annual'))`); await c.query('commit'); return r; } catch (e) { await c.query('rollback'); throw e; } finally { await c.end(); } })()),
      ]);
      for (const r of results) if (!r.ok) expect(r.code, r.message).not.toBe('40P01');
    }
  });

  it('a processing order is never superseded, never expires, and activates hours later', async () => {
    const x = await orderFor(pool, USER_A, 'lifetime');
    const begun = await beginCharge(pool, x, USER_A);
    expect(begun).toEqual({ plan_code: 'lifetime', amount_minor: '19800', currency: 'USD', trial_days: 0 });
    expect((await pool.query('select status, provider, livemode, processing_at is not null as p from public.billing_orders where id = $1', [x])).rows[0])
      .toEqual({ status: 'processing', provider: 'culqi', livemode: true, p: true });
    // Double submit: the second claim never reaches the provider.
    await expect(beginCharge(pool, x, USER_A)).rejects.toThrow('order_not_pending');
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, `select public.billing_create_order('monthly', public.billing_price('monthly'))`)).toBe('payment_in_progress');
    });
    // 2 hours later (late webhook): still processing, a new order is allowed but X is NOT superseded, and X activates.
    await pool.query(`update public.billing_orders set created_at = now() - interval '2 hours', processing_at = now() - interval '2 hours' where id = $1`, [x]);
    const y = await orderFor(pool, USER_A, 'annual');
    expect((await pool.query('select status from public.billing_orders where id = $1', [x])).rows[0].status).toBe('processing');
    expect((await pool.query(`select public.billing_activate($1, 'culqi', 'chr_test_late', 19800, 'USD') as s`, [x])).rows[0].s).toBe('paid');
    // The pending order Y can no longer start a charge: the person already has Plus.
    await expect(beginCharge(pool, y, USER_A)).rejects.toThrow('already_plus');
  });

  it('begin_charge: own order only, pending orders still expire, test mode only for demo accounts', async () => {
    const x = await orderFor(pool, USER_A, 'lifetime');
    await expect(beginCharge(pool, x, USER_B)).rejects.toThrow('order_not_found');
    await expect(beginCharge(pool, x, USER_A, false)).rejects.toThrow('test_mode_demo_only');
    await pool.query('insert into public.demo_access (user_id) values ($1)', [USER_A]);
    await beginCharge(pool, x, USER_A, false);
    expect((await pool.query('select livemode from public.billing_orders where id = $1', [x])).rows[0].livemode).toBe(false);
    const stale = await orderFor(pool, USER_B, 'lifetime');
    await pool.query(`update public.billing_orders set created_at = now() - interval '61 minutes' where id = $1`, [stale]);
    await expect(beginCharge(pool, stale, USER_B)).rejects.toThrow('order_expired');
    // A processing order activates only with the provider that started it.
    await expect(pool.query(`select public.billing_activate($1, 'other', 'chr_test_x', 19800, 'USD')`, [x])).rejects.toThrow('bad_reference');
  });

  it('fail_order: a decline closes the order once; a charge that went through is kept for its refund', async () => {
    const x = await orderFor(pool, USER_A, 'lifetime');
    await beginCharge(pool, x, USER_A);
    expect((await pool.query(`select public.billing_fail_order($1, 'card_declined') as s`, [x])).rows[0].s).toBe('failed');
    expect((await pool.query(`select public.billing_fail_order($1, 'card_declined') as s`, [x])).rows[0].s).toBe('failed');
    expect((await pool.query('select status, failure from public.billing_orders where id = $1', [x])).rows[0]).toEqual({ status: 'failed', failure: 'card_declined' });
    await expect(pool.query(`select public.billing_activate($1, 'culqi', 'chr_test_y', 19800, 'USD')`, [x])).rejects.toThrow('order_not_pending');
    await expect(pool.query(`select public.billing_fail_order($1, 'Bad Code!')`, [x])).rejects.toThrow('bad_reference');
    const y = await orderFor(pool, USER_A, 'lifetime');
    await beginCharge(pool, y, USER_A);
    await pool.query(`select public.billing_fail_order($1, 'activation_refused:already_plus', 'chr_test_paid')`, [y]);
    expect((await pool.query('select status, provider_ref from public.billing_orders where id = $1', [y])).rows[0]).toEqual({ status: 'failed', provider_ref: 'chr_test_paid' });
    expect((await pool.query(`select outcome, detail from public.billing_events where event_ref = $1`, [`fail:${y}`])).rows[0]).toEqual({ outcome: 'needs_refund', detail: 'activation_refused:already_plus' });
    const z = await orderFor(pool, USER_B, 'lifetime');
    await pool.query(`select public.billing_activate($1, 'culqi', 'chr_test_z', 19800, 'USD')`, [z]);
    await expect(pool.query(`select public.billing_fail_order($1, 'card_declined')`, [z])).rejects.toThrow('order_already_settled');
  });

  it('orders record the terms version; the ledger keeps begin + activation; clients get no billing function', async () => {
    const x = await orderFor(pool, USER_A, 'lifetime');
    expect((await pool.query('select terms_version from public.billing_orders where id = $1', [x])).rows[0].terms_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await beginCharge(pool, x, USER_A);
    await pool.query(`select public.billing_activate($1, 'culqi', 'chr_test_l1', 19800, 'USD')`, [x]);
    expect((await pool.query(`select type, outcome, amount_minor, currency from public.billing_events where order_id = $1 order by id`, [x])).rows)
      .toEqual([{ type: 'order.processing', outcome: 'processed', amount_minor: '19800', currency: 'USD' }, { type: 'plan.activated', outcome: 'processed', amount_minor: '19800', currency: 'USD' }]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      for (const sql of [
        `select public.billing_begin_charge('${x}', '${USER_A}', 'culqi', true)`,
        `select public.billing_fail_order('${x}', 'x_code')`,
        `select public.billing_activate('${x}', 'culqi', 'chr_test_l1', 19800, 'USD')`,
      ]) expect(await errorCode(c, sql), sql).toBe('42501');
    });
  });
});
