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

  it('deleting the real movement removes its settlement (the occurrence becomes pending again, nothing invented)', async () => {
    const t = await tx(USER_A);
    const car = await obligation(USER_A);
    await pool.query(`insert into public.plan_settlements (user_id, fixed_expense_id, period, transaction_id) values ($1, $2, '2026-10', $3)`, [USER_A, car, t]);
    await pool.query('delete from public.transactions where id = $1', [t]);
    expect((await pool.query('select count(*)::int as n from public.plan_settlements')).rows[0].n).toBe(0);
  });
});
