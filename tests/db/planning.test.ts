import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

describe.skipIf(!DATABASE_URL)('cash-flow planning tables (ADR-0005)', () => {
  let pool: pg.Pool;
  const tx = async (user: string) => (await pool.query(`insert into public.transactions (user_id, occurred_at, type, direction, amount_minor,
    currency, merchant_raw, status, confidence, fingerprint) values ($1, '2026-10-08 12:00-05', 'expense', 'outflow', 95000, 'PEN', 'CUOTA CARRO',
    'confirmed', 'high', 'fp') returning id`, [user])).rows[0].id as string;
  const obligation = async (user: string, extra = '') => (await pool.query(`insert into public.fixed_expenses (user_id, name, currency, amount_minor, due_day ${extra ? ', ' + extra.split('=')[0] : ''})
    values ($1, 'Carro', 'PEN', 95000, 9 ${extra ? ', ' + extra.split('=')[1] : ''}) returning id`, [user])).rows[0].id as string;

  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('unknown amount is null (never 0); a date window needs a start; non-monthly needs an anchor', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(`insert into public.fixed_expenses (user_id, name, amount_minor, amount_status, due_day, due_day_max) values ($1, 'Internet', null, 'unknown', 9, 10)`, [USER_A]);
      expect(await errorCode(c, `insert into public.fixed_expenses (user_id, name, amount_minor, amount_status, due_day) values ($1, 'X', 0, 'confirmed', 9)`, [USER_A])).toBe('23514');
      expect(await errorCode(c, `insert into public.fixed_expenses (user_id, name, amount_minor, amount_status, due_day) values ($1, 'X', null, 'confirmed', 9)`, [USER_A])).toBe('23514');
      expect(await errorCode(c, `insert into public.fixed_expenses (user_id, name, amount_minor, due_day, due_day_max) values ($1, 'X', 100, null, 10)`, [USER_A])).toBe('23514');
      expect(await errorCode(c, `insert into public.fixed_expenses (user_id, name, amount_minor, due_day, frequency) values ($1, 'X', 100, 1, 'yearly')`, [USER_A])).toBe('23514');
      expect(await errorCode(c, `insert into public.expected_incomes (user_id, name, frequency) values ($1, 'Sueldo', 'monthly')`, [USER_A])).toBe('23514');
      // A declared income whose pay day is not known yet is kept (day "por confirmar"; the planner does not project it).
      await c.query(`insert into public.expected_incomes (user_id, name, amount_minor, frequency) values ($1, 'Sueldo', 500000, 'monthly')`, [USER_A]);
      expect(await errorCode(c, `insert into public.expected_incomes (user_id, name, amount_minor, frequency, day_of_month) values ($1, 'Sueldo', 500000, 'semimonthly', 15)`, [USER_A])).toBe('23514');
      expect(await errorCode(c, `insert into public.expected_incomes (user_id, name, amount_minor, frequency, second_day) values ($1, 'Sueldo', 500000, 'semimonthly', 30)`, [USER_A])).toBe('23514');
      expect(await errorCode(c, `insert into public.expected_incomes (user_id, name, amount_minor, frequency) values ($1, 'Sueldo', 500000, 'weekly')`, [USER_A])).toBe('23514');
    });
  });

  it('one real movement settles one planned item; an occurrence is settled once', async () => {
    const t = await tx(USER_A);
    const car = await obligation(USER_A);
    const net = await obligation(USER_A);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(`insert into public.plan_settlements (user_id, fixed_expense_id, period, transaction_id) values ($1, $2, '2026-10', $3)`, [USER_A, car, t]);
      expect(await errorCode(c, `insert into public.plan_settlements (user_id, fixed_expense_id, period, transaction_id) values ($1, $2, '2026-10', $3)`, [USER_A, net, t])).toBe('23505');
      const t2 = (await c.query(`select id from public.transactions limit 1`)).rows[0].id;
      expect(await errorCode(c, `insert into public.plan_settlements (user_id, fixed_expense_id, period, status) values ($1, $2, '2026-10', 'skipped')`, [USER_A, car])).toBe('23505');
      expect(t2).toBe(t);
      expect(await errorCode(c, `insert into public.plan_settlements (user_id, fixed_expense_id, period, status) values ($1, $2, '2026-11', 'paid')`, [USER_A, car])).toBe('23514');
    });
  });

  it('A/B: B cannot read A\'s plan data, nor settle A\'s obligation with its own movement, nor use A\'s movement', async () => {
    const aTx = await tx(USER_A);
    const bTx = await tx(USER_B);
    const aCar = await obligation(USER_A);
    await pool.query(`insert into public.expected_incomes (user_id, name, amount_minor, day_of_month) values ($1, 'Sueldo', 400000, 15)`, [USER_A]);
    await pool.query(`insert into public.balance_snapshots (user_id, currency, amount_minor) values ($1, 'PEN', 500000)`, [USER_A]);
    await pool.query(`insert into public.planning_settings (user_id, currency, essentials_monthly_minor) values ($1, 'PEN', 80000)`, [USER_A]);
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      for (const t of ['expected_incomes', 'balance_snapshots', 'planning_settings', 'plan_settlements', 'fixed_expenses']) {
        expect((await c.query(`select count(*)::int as n from public.${t}`)).rows[0].n).toBe(0);
      }
      expect(await errorCode(c, `insert into public.plan_settlements (user_id, fixed_expense_id, period, transaction_id) values ($1, $2, '2026-10', $3)`, [USER_B, aCar, bTx])).toBe('23503');
      expect(await errorCode(c, `insert into public.plan_settlements (user_id, fixed_expense_id, period, transaction_id) values ($1, $2, '2026-10', $3)`, [USER_A, aCar, aTx])).toBe('42501');
      expect((await c.query(`update public.expected_incomes set amount_minor = 1 returning id`)).rowCount).toBe(0);
      expect((await c.query(`delete from public.fixed_expenses returning id`)).rowCount).toBe(0);
    });
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, `update public.balance_snapshots set amount_minor = 1`, [])).toBe('42501'); // history is append-only
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, 'select * from public.expected_incomes', [])).toBe('42501');
    });
  });

  // ADR-0017 guard (migration 051): whatever the path (planning action, Vels button, direct API call), only a movement
  // that can pay settles an item. Rejections are CHECK-class (23514); ownership stays with RLS / composite FKs.
  const movement = async (user: string, type: string, direction: string, currency = 'PEN', status = 'confirmed') => (await pool.query(`insert into public.transactions
    (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, status, confidence, fingerprint)
    values ($1, '2026-10-08 12:00-05', $2, $3, 95000, $4, 'X', $5, 'high', 'fp') returning id`, [user, type, direction, currency, status])).rows[0].id as string;
  const settle = `insert into public.plan_settlements (user_id, fixed_expense_id, period, transaction_id) values ($1, $2, '2026-10', $3)`;
  const settleIncome = `insert into public.plan_settlements (user_id, expected_income_id, period, transaction_id) values ($1, $2, '2026-10', $3)`;

  it('guard: a pending, income, inflow or other-currency movement never settles a payment', async () => {
    const car = await obligation(USER_A);
    const pending = await movement(USER_A, 'expense', 'outflow', 'PEN', 'review_required');
    const income = await movement(USER_A, 'income', 'inflow');
    const deposit = await movement(USER_A, 'deposit', 'inflow');
    const refund = await movement(USER_A, 'refund', 'inflow');
    const usd = await movement(USER_A, 'expense', 'outflow', 'USD');
    const ok = await movement(USER_A, 'credit_card_payment', 'outflow');
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      for (const t of [pending, income, deposit, refund, usd]) expect(await errorCode(c, settle, [USER_A, car, t])).toBe('23514');
      expect(await errorCode(c, settle, [USER_A, car, ok])).toBeNull();
      expect((await c.query('select count(*)::int as n from public.plan_settlements')).rows[0].n).toBe(1);
    });
  });

  it('guard: an expected income is settled only by a confirmed income in its own currency', async () => {
    const inc = (await pool.query(`insert into public.expected_incomes (user_id, name, currency, amount_minor, day_of_month) values ($1, 'Sueldo', 'PEN', 400000, 15) returning id`, [USER_A])).rows[0].id;
    const expense = await movement(USER_A, 'expense', 'outflow');
    const usd = await movement(USER_A, 'income', 'inflow', 'USD');
    const pending = await movement(USER_A, 'income', 'inflow', 'PEN', 'possible_duplicate');
    const ok = await movement(USER_A, 'income', 'inflow');
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      for (const t of [expense, usd, pending]) expect(await errorCode(c, settleIncome, [USER_A, inc, t])).toBe('23514');
      expect(await errorCode(c, settleIncome, [USER_A, inc, ok])).toBeNull();
    });
  });

  it('guard: re-checked when the link changes, not when the person acknowledges a variance', async () => {
    const car = await obligation(USER_A);
    const t = await movement(USER_A, 'expense', 'outflow');
    const usd = await movement(USER_A, 'expense', 'outflow', 'USD');
    const id = (await pool.query(`${settle} returning id`, [USER_A, car, t])).rows[0].id;
    await pool.query(`update public.transactions set status = 'review_required' where id = $1`, [t]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, `update public.plan_settlements set variance_ack = true where id = $1`, [id])).toBeNull();
      expect(await errorCode(c, `update public.plan_settlements set transaction_id = $2 where id = $1`, [id, usd])).toBe('23514');
    });
    // Privileged paths (seed, service) get the same floor.
    const c = await pool.connect();
    try {
      await c.query('begin');
      expect(await errorCode(c, settle.replace("'2026-10'", "'2026-11'"), [USER_A, car, usd])).toBe('23514');
    } finally { await c.query('rollback'); c.release(); }
  });

  it('deleting the real movement removes its settlement (the occurrence becomes pending again, nothing invented)', async () => {
    const t = await tx(USER_A);
    const car = await obligation(USER_A);
    await pool.query(`insert into public.plan_settlements (user_id, fixed_expense_id, period, transaction_id) values ($1, $2, '2026-10', $3)`, [USER_A, car, t]);
    await pool.query('delete from public.transactions where id = $1', [t]);
    expect((await pool.query('select count(*)::int as n from public.plan_settlements')).rows[0].n).toBe(0);
  });
});
