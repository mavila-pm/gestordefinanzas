import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

describe.skipIf(!DATABASE_URL)('TASK-010: budgets isolation', () => {
  let pool: pg.Pool;
  let food: string;
  let catB: string;
  beforeAll(async () => {
    pool = makePool();
    food = (await pool.query(`select id from public.categories where user_id is null and name = 'Alimentación'`)).rows[0].id;
  });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
    catB = (await pool.query(`insert into public.categories (user_id, name) values ($1, 'Privada B') returning id`, [USER_B])).rows[0].id;
    await pool.query(`insert into public.budgets (user_id, category_id, amount_minor) values ($1, $2, 50000)`, [USER_B, food]);
  });
  afterAll(async () => { await pool?.end(); });

  it('A manages only own budgets, never B\'s nor with B\'s category; amounts must be positive', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query('select * from public.budgets')).rowCount).toBe(0);
      await c.query(`insert into public.budgets (user_id, category_id, amount_minor) values ($1, $2, 30000)`, [USER_A, food]);
      expect(await errorCode(c, `insert into public.budgets (user_id, category_id, amount_minor) values ($1, $2, 1)`, [USER_B, food])).toBe('42501');
      expect(await errorCode(c, `insert into public.budgets (user_id, category_id, amount_minor) values ($1, $2, 1)`, [USER_A, catB])).toBe('42501');
      expect(await errorCode(c, `update public.budgets set amount_minor = 0 where user_id = $1`, [USER_A])).toBe('23514');
      expect((await c.query(`update public.budgets set amount_minor = 1 where user_id = $1`, [USER_B])).rowCount).toBe(0);
      expect((await c.query(`delete from public.budgets where user_id = $1`, [USER_B])).rowCount).toBe(0);
    });
    expect((await pool.query('select amount_minor from public.budgets where user_id = $1', [USER_B])).rows[0].amount_minor).toBe('50000');
  });
});

describe.skipIf(!DATABASE_URL)('TASK-011: fixed expenses and debts isolation', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
    await pool.query(`insert into public.debts (user_id, name, principal_minor, balance_minor) values ($1, 'B debt', 100000, 50000)`, [USER_B]);
    await pool.query(`insert into public.fixed_expenses (user_id, name, amount_minor, due_day) values ($1, 'B rent', 100000, 5)`, [USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('A cannot see, change or create B\'s commitments; invariants enforced', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query('select * from public.debts')).rowCount).toBe(0);
      expect((await c.query('select * from public.fixed_expenses')).rowCount).toBe(0);
      expect((await c.query(`update public.debts set balance_minor = 0 where user_id = $1`, [USER_B])).rowCount).toBe(0);
      expect(await errorCode(c, `insert into public.debts (user_id, name, principal_minor, balance_minor) values ($1, 'x', 1, 1)`, [USER_B])).toBe('42501');
      expect(await errorCode(c, `insert into public.debts (user_id, name, principal_minor, balance_minor, installments_total, installments_paid) values ($1, 'x', 1, 1, 2, 3)`, [USER_A])).toBe('23514');
      expect(await errorCode(c, `insert into public.fixed_expenses (user_id, name, amount_minor, due_day) values ($1, 'x', 1, 0)`, [USER_A])).toBe('23514');
    });
    expect((await pool.query('select balance_minor from public.debts where user_id = $1', [USER_B])).rows[0].balance_minor).toBe('50000');
  });
});
