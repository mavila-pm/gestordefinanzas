import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

/**
 * Partial payments (ADR-0017, migration 052): several abonos per occurrence, exactly one closing row (paid / skipped),
 * nothing added after it closes, a partial is always a payment linked to a real movement, one movement settles one
 * item. Concurrency is tested with committed transactions on separate connections (like simultaneous requests).
 */
describe.skipIf(!DATABASE_URL)('partial settlements', () => {
  let pool: pg.Pool;
  const tx = async (user: string, amount = 50000) => (await pool.query(`insert into public.transactions (user_id, occurred_at, type, direction, amount_minor,
    currency, merchant_raw, status, confidence, fingerprint) values ($1, '2026-10-03 12:00-05', 'expense', 'outflow', $2, 'PEN', 'ALQUILER', 'confirmed', 'high', 'fp')
    returning id`, [user, amount])).rows[0].id as string;
  const rent = async (user: string) => (await pool.query(`insert into public.fixed_expenses (user_id, name, currency, amount_minor, due_day)
    values ($1, 'Alquiler', 'PEN', 150000, 5) returning id`, [user])).rows[0].id as string;
  const ins = `insert into public.plan_settlements (user_id, fixed_expense_id, period, transaction_id, status) values ($1, $2, '2026-10', $3, $4)`;

  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('partial + partial + paid is one occurrence; after it closes, nothing else is linked or skipped', async () => {
    const r = await rent(USER_A);
    const [t1, t2, t3, t4, t5] = [await tx(USER_A), await tx(USER_A, 70000), await tx(USER_A, 30000), await tx(USER_A, 10000), await tx(USER_A, 10000)];
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, ins, [USER_A, r, t1, 'partial'])).toBeNull();
      expect(await errorCode(c, ins, [USER_A, r, t2, 'partial'])).toBeNull();
      expect(await errorCode(c, ins, [USER_A, r, t3, 'paid'])).toBeNull();
      expect(await errorCode(c, ins, [USER_A, r, t4, 'paid'])).toBe('23505');
      expect(await errorCode(c, ins, [USER_A, r, t4, 'partial'])).toBe('23505');
      expect(await errorCode(c, `insert into public.plan_settlements (user_id, fixed_expense_id, period, status) values ($1, $2, '2026-10', 'skipped')`, [USER_A, r])).toBe('23505');
      // Another month is another occurrence; the same movement can never count twice.
      expect(await errorCode(c, ins.replace("'2026-10'", "'2026-11'"), [USER_A, r, t5, 'partial'])).toBeNull();
      expect(await errorCode(c, ins.replace("'2026-10'", "'2026-12'"), [USER_A, r, t1, 'partial'])).toBe('23505');
      const { rows } = await c.query(`select status, count(*)::int as n from public.plan_settlements where period = '2026-10' group by status order by status`);
      expect(rows).toEqual([{ status: 'paid', n: 1 }, { status: 'partial', n: 2 }]);
    });
  });

  it('a skipped occurrence takes no abono; a partial needs a payment and a movement', async () => {
    const r = await rent(USER_A);
    const t = await tx(USER_A);
    const inc = (await pool.query(`insert into public.expected_incomes (user_id, name, amount_minor, day_of_month) values ($1, 'Sueldo', 400000, 15) returning id`, [USER_A])).rows[0].id;
    const income = (await pool.query(`insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, status, confidence, fingerprint)
      values ($1, now(), 'income', 'inflow', 100000, 'PEN', 'confirmed', 'high', 'fp') returning id`, [USER_A])).rows[0].id;
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(`insert into public.plan_settlements (user_id, fixed_expense_id, period, status) values ($1, $2, '2026-10', 'skipped')`, [USER_A, r]);
      expect(await errorCode(c, ins, [USER_A, r, t, 'partial'])).toBe('23505');
      expect(await errorCode(c, `insert into public.plan_settlements (user_id, fixed_expense_id, period, status) values ($1, $2, '2026-11', 'partial')`, [USER_A, r])).toBe('23514');
      expect(await errorCode(c, `insert into public.plan_settlements (user_id, expected_income_id, period, transaction_id, status) values ($1, $2, '2026-10', $3, 'partial')`, [USER_A, inc, income])).toBe('23514');
      expect(await errorCode(c, ins.replace("'2026-10'", "'2026-11'"), [USER_A, r, t, 'refunded'])).toBe('23514');
    });
  });

  it('review m2: a month with abonos is never skipped; a row is never moved into a closed month', async () => {
    const r = await rent(USER_A);
    const [t1, t2, t3] = [await tx(USER_A), await tx(USER_A, 150000), await tx(USER_A, 20000)];
    const skip = `insert into public.plan_settlements (user_id, fixed_expense_id, period, status) values ($1, $2, $3, 'skipped')`;
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(ins, [USER_A, r, t1, 'partial']);
      expect(await errorCode(c, skip, [USER_A, r, '2026-10'])).toBe('23514');
      // 2026-09 is closed (paid); 2026-11 has an abono: moving it into 2026-09 (or turning it into a skip) is refused.
      await c.query(ins.replace("'2026-10'", "'2026-09'"), [USER_A, r, t2, 'paid']);
      const p = (await c.query(`${ins.replace("'2026-10'", "'2026-11'")} returning id`, [USER_A, r, t3, 'partial'])).rows[0].id;
      expect(await errorCode(c, `update public.plan_settlements set period = '2026-09' where id = $1`, [p])).toBe('23505');
      expect(await errorCode(c, `update public.plan_settlements set period = '2026-10' where id = $1`, [p])).toBeNull();
      expect(await errorCode(c, `update public.plan_settlements set status = 'skipped' where id = $1`, [p])).toBe('23514');
      const { rows } = await c.query(`select period, status from public.plan_settlements order by period, status`);
      expect(rows).toEqual([{ period: '2026-09', status: 'paid' }, { period: '2026-10', status: 'partial' }, { period: '2026-10', status: 'partial' }]);
    });
  });

  it('review m2: "Fue un abono" and "No lo pago" at the same time never both commit', async () => {
    const r = await rent(USER_A);
    const t = await tx(USER_A);
    const run = async (sql: string, params: unknown[]) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role authenticated');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER_A, role: 'authenticated' })]);
        await c.query(sql, params);
        await new Promise((res) => setTimeout(res, 50));
        await c.query('commit');
        return 'ok';
      } catch (e) {
        await c.query('rollback').catch(() => undefined);
        return (e as { code?: string }).code ?? 'unknown';
      } finally { c.release(); }
    };
    const out = await Promise.all([run(ins, [USER_A, r, t, 'partial']),
      run(`insert into public.plan_settlements (user_id, fixed_expense_id, period, status) values ($1, $2, '2026-10', 'skipped')`, [USER_A, r])]);
    expect(out.filter((x) => x === 'ok')).toHaveLength(1);
    expect(['23505', '23514']).toContain(out.find((x) => x !== 'ok'));
    expect((await pool.query(`select count(*)::int as n from public.plan_settlements where fixed_expense_id = $1`, [r])).rows[0].n).toBe(1);
  });

  it('5 simultaneous "pago completo" with different movements: exactly one closes the occurrence', async () => {
    const r = await rent(USER_A);
    const txs = await Promise.all(Array.from({ length: 5 }, () => tx(USER_A, 150000)));
    const attempt = async (t: string) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role authenticated');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER_A, role: 'authenticated' })]);
        await c.query(ins, [USER_A, r, t, 'paid']);
        await c.query('commit');
        return 'ok';
      } catch (e) {
        await c.query('rollback').catch(() => undefined);
        return (e as { code?: string }).code ?? 'unknown';
      } finally { c.release(); }
    };
    const out = await Promise.all(txs.map(attempt));
    expect(out.filter((x) => x === 'ok')).toHaveLength(1);
    expect(out.filter((x) => x !== 'ok').every((x) => x === '23505')).toBe(true);
    expect((await pool.query(`select count(*)::int as n from public.plan_settlements where fixed_expense_id = $1`, [r])).rows[0].n).toBe(1);
  });

  it('an abono racing a closing payment never lands after it', async () => {
    const r = await rent(USER_A);
    const [a, b, c1] = [await tx(USER_A), await tx(USER_A, 100000), await tx(USER_A, 20000)];
    await pool.query(ins, [USER_A, r, a, 'partial']);
    const c = await pool.connect();
    const other = await pool.connect();
    try {
      await c.query('begin');
      await c.query(ins, [USER_A, r, b, 'paid']); // holds the occurrence lock until commit
      await other.query('begin');
      const late = other.query(ins, [USER_A, r, c1, 'partial']).then(() => 'ok', (e: { code?: string }) => e.code);
      await new Promise((res) => setTimeout(res, 150));
      await c.query('commit');
      expect(await late).toBe('23505');
      await other.query('rollback');
    } finally { c.release(); other.release(); }
    const { rows } = await pool.query(`select status from public.plan_settlements where fixed_expense_id = $1 order by status`, [r]);
    expect(rows.map((x) => x.status)).toEqual(['paid', 'partial']);
  });

  it('deleting one abono\'s movement removes only that abono (the rest of the history stays)', async () => {
    const r = await rent(USER_A);
    const [t1, t2] = [await tx(USER_A), await tx(USER_A, 40000)];
    await pool.query(ins, [USER_A, r, t1, 'partial']);
    await pool.query(ins, [USER_A, r, t2, 'partial']);
    await pool.query('delete from public.transactions where id = $1', [t1]);
    const { rows } = await pool.query(`select transaction_id from public.plan_settlements where fixed_expense_id = $1`, [r]);
    expect(rows).toEqual([{ transaction_id: t2 }]);
  });

  it('A/B: B cannot add an abono to A\'s payment, nor read A\'s; anon has nothing', async () => {
    const aRent = await rent(USER_A);
    const aTx = await tx(USER_A);
    const bTx = await tx(USER_B);
    await pool.query(ins, [USER_A, aRent, aTx, 'partial']);
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect((await c.query('select count(*)::int as n from public.plan_settlements')).rows[0].n).toBe(0);
      expect(await errorCode(c, ins, [USER_B, aRent, bTx, 'partial'])).toBe('23503');
      expect(await errorCode(c, ins, [USER_A, aRent, aTx, 'partial'])).toBe('42501');
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, 'select * from public.plan_settlements', [])).toBe('42501');
    });
  });
});
