import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

/**
 * Debt abonos (ADR-0017 §D, migration 052): record_debt_payment writes one ledger row and updates the debt in one
 * transaction. The month's installment is settled when that month's payments add up to what was due; a replayed
 * client_ref changes nothing; above the balance is refused. Clients only read the ledger. Concurrency: committed
 * transactions on separate connections, like simultaneous requests.
 */
describe.skipIf(!DATABASE_URL)('debt payments (record_debt_payment)', () => {
  let pool: pg.Pool;
  const debt = async (user: string, balance = 500000, installment: number | null = 50000, extra: { total?: number; paid?: number } = {}) => (await pool.query(
    `insert into public.debts (user_id, name, currency, principal_minor, balance_minor, installment_minor, installments_total, installments_paid, due_day)
     values ($1, 'Préstamo', 'PEN', 600000, $2, $3, $4, $5, 20) returning id`, [user, balance, installment, extra.total ?? null, extra.paid ?? 0])).rows[0].id as string;
  const pay = 'select public.record_debt_payment($1, $2, $3) as r';
  const state = async (id: string, c: pg.Pool | pg.PoolClient = pool) => (await c.query('select balance_minor::int as balance, installments_paid as paid, last_payment_on is not null as dated from public.debts where id = $1', [id])).rows[0];
  const period = async () => (await pool.query(`select to_char((now() at time zone 'America/Lima')::date, 'YYYY-MM') as p`)).rows[0].p as string;

  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('review M2: S/ 300 + S/ 200 settle a S/ 500 installment (once); a later payment only lowers the balance', async () => {
    const d = await debt(USER_A);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const first = (await c.query(pay, [d, 30000, 'ref-abono-0001'])).rows[0].r;
      expect(first).toMatchObject({ replay: false, balance_minor: 470000, settles: false, period_settled: false, due_minor: 50000, period_paid_minor: 30000 });
      const second = (await c.query(pay, [d, 20000, 'ref-abono-0002'])).rows[0].r;
      expect(second).toMatchObject({ balance_minor: 450000, settles: true, period_settled: true, due_minor: 50000, period_paid_minor: 50000 });
      const extra = (await c.query(pay, [d, 10000, 'ref-abono-0003'])).rows[0].r;
      expect(extra).toMatchObject({ balance_minor: 440000, settles: false, period_settled: true, due_minor: null });
      const rows = (await c.query('select period, amount_minor::int as amount, settles from public.debt_payments order by created_at, amount_minor desc')).rows;
      expect(rows.map((x) => x.settles)).toEqual([false, true, false]);
      expect(new Set(rows.map((x) => x.period))).toEqual(new Set([await period()]));
    });
  });

  it('the installment is the balance when it is smaller; an unknown installment is never counted', async () => {
    const small = await debt(USER_A, 30000);
    const unknown = await debt(USER_A, 500000, null);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query(pay, [small, 10000, null])).rows[0].r).toMatchObject({ settles: false, due_minor: 30000 });
      expect((await c.query(pay, [small, 20000, null])).rows[0].r).toMatchObject({ settles: true, balance_minor: 0 });
      expect((await c.query(pay, [unknown, 90000, null])).rows[0].r).toMatchObject({ settles: false, period_settled: false, due_minor: null, installment_known: false });
      expect(await state(small, c)).toEqual({ balance: 0, paid: 1, dated: true });
      expect(await state(unknown, c)).toEqual({ balance: 410000, paid: 0, dated: false });
    });
  });

  it('the counter never passes the total; a month already settled before the ledger (last_payment_on) is not counted again', async () => {
    const last = await debt(USER_A, 50000, 50000, { total: 12, paid: 12 });
    const legacy = await debt(USER_A);
    await pool.query(`update public.debts set last_payment_on = (now() at time zone 'America/Lima')::date where id = $1`, [legacy]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query(pay, [last, 50000, null])).rows[0].r).toMatchObject({ settles: true, balance_minor: 0 });
      expect((await c.query(pay, [legacy, 50000, null])).rows[0].r).toMatchObject({ settles: false, period_settled: true });
      expect(await state(last, c)).toEqual({ balance: 0, paid: 12, dated: true });
      expect((await state(legacy, c)).paid).toBe(0);
    });
  });

  it('second review: the same client_ref twice lowers the balance once (retry, second tab)', async () => {
    const d = await debt(USER_A);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query(pay, [d, 10000, 'ref-retry-0001'])).rows[0].r).toMatchObject({ replay: false, balance_minor: 490000 });
      expect((await c.query(pay, [d, 10000, 'ref-retry-0001'])).rows[0].r).toMatchObject({ replay: true, balance_minor: 490000, period_paid_minor: 10000 });
      expect((await c.query('select count(*)::int as n from public.debt_payments')).rows[0].n).toBe(1);
      // Above the balance: refused (never capped), nothing written.
      expect(await errorMessage(c, pay, [d, 490001, 'ref-over-00001'])).toBe('over_balance');
      expect(await errorCode(c, pay, [d, 490001, 'ref-over-00001'])).toBe('23514');
      expect(await errorCode(c, pay, [d, 0, null])).toBe('22023');
      expect(await errorCode(c, pay, [d, 100, 'bad ref'])).toBe('22023');
      expect((await c.query('select balance_minor::int as b from public.debts where id = $1', [d])).rows[0].b).toBe(490000);
    });
  });

  it('5 simultaneous S/ 100 abonos on a S/ 500 installment: all land, the balance drops S/ 500, the month settles once', async () => {
    const d = await debt(USER_A);
    const attempt = async (i: number) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role authenticated');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER_A, role: 'authenticated' })]);
        await c.query(pay, [d, 10000, `ref-par-${i}-00000`]);
        await c.query('commit');
        return 'ok';
      } catch (e) {
        await c.query('rollback').catch(() => undefined);
        return (e as { code?: string }).code ?? 'unknown';
      } finally { c.release(); }
    };
    expect(await Promise.all([0, 1, 2, 3, 4].map(attempt))).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(await state(d)).toEqual({ balance: 450000, paid: 1, dated: true });
    expect((await pool.query('select count(*) filter (where settles)::int as s, count(*)::int as n from public.debt_payments where debt_id = $1', [d])).rows[0]).toEqual({ s: 1, n: 5 });
    // The same submission from two tabs at once: one row.
    const both = await Promise.all([attempt(9), attempt(9)]);
    expect(both).toEqual(['ok', 'ok']);
    expect((await state(d)).balance).toBe(440000);
  });

  it('A/B and privileges: only the function writes; B cannot pay or read A\'s debt; anon has nothing', async () => {
    const a = await debt(USER_A);
    await pool.query(`insert into public.debt_payments (user_id, debt_id, period, amount_minor) values ($1, $2, '2026-10', 100)`, [USER_A, a]);
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect(await errorMessage(c, pay, [a, 100, null])).toBe('not_found');
      expect((await c.query('select count(*)::int as n from public.debt_payments')).rows[0].n).toBe(0);
    });
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query('select count(*)::int as n from public.debt_payments')).rows[0].n).toBe(1);
      expect(await errorCode(c, `insert into public.debt_payments (user_id, debt_id, period, amount_minor) values ($1, $2, '2026-10', 100)`, [USER_A, a])).toBe('42501');
      expect(await errorCode(c, `update public.debt_payments set amount_minor = 1`)).toBe('42501');
      expect(await errorCode(c, `delete from public.debt_payments`)).toBe('42501');
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, 'select * from public.debt_payments')).toBe('42501');
      expect(await errorCode(c, pay, [a, 100, null])).toBe('42501');
    });
    // The composite FK: a ledger row never points to another person's debt, even from a privileged connection.
    const c = await pool.connect();
    try {
      await c.query('begin');
      expect(await errorCode(c, `insert into public.debt_payments (user_id, debt_id, period, amount_minor) values ($1, $2, '2026-10', 100)`, [USER_B, a])).toBe('23503');
      expect(await errorCode(c, `insert into public.debt_payments (user_id, debt_id, period, amount_minor) values ($1, $2, '2026-13', 100)`, [USER_A, a])).toBe('23514');
    } finally { await c.query('rollback'); c.release(); }
  });
});
