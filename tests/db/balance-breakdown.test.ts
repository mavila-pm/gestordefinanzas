import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, makePool } from './helpers';

// Own users: this file never shares rows with the other suites running in parallel.
const USER_A = '0b000000-0000-4000-8000-0000000000a4';
const USER_B = '0b000000-0000-4000-8000-0000000000b4';

/** Migration 044: today's money keeps its breakdown (cuentas / efectivo); parts add up to the total; own rows only. */
describe.skipIf(!DATABASE_URL)('balance breakdown (balance_snapshots.bank_minor / cash_minor)', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = makePool();
    await pool.query(`insert into auth.users (id, email) values ($1, 'bal-a@test.invalid'), ($2, 'bal-b@test.invalid') on conflict do nothing`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('stores bank + cash with their total; a mismatch or a negative part is refused; B cannot see A', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(`insert into public.balance_snapshots (user_id, currency, amount_minor, bank_minor, cash_minor) values ($1, 'PEN', 415000, 400000, 15000)`, [USER_A]);
      await c.query(`insert into public.balance_snapshots (user_id, currency, amount_minor, bank_minor) values ($1, 'PEN', 400000, 400000)`, [USER_A]);
      await c.query(`insert into public.balance_snapshots (user_id, currency, amount_minor) values ($1, 'PEN', 300000)`, [USER_A]);
      const rows = (await c.query(`select amount_minor, bank_minor, cash_minor from public.balance_snapshots order by created_at`)).rows;
      expect(rows[0]).toEqual({ amount_minor: '415000', bank_minor: '400000', cash_minor: '15000' });
    });
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await expect(c.query(`insert into public.balance_snapshots (user_id, currency, amount_minor, bank_minor, cash_minor) values ($1, 'PEN', 15000, 400000, 15000)`, [USER_A])).rejects.toThrow(/breakdown_sum/);
    });
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await expect(c.query(`insert into public.balance_snapshots (user_id, currency, amount_minor, cash_minor) values ($1, 'PEN', 100, -5)`, [USER_A])).rejects.toThrow(/check/);
    });
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect((await c.query(`select * from public.balance_snapshots where user_id = $1`, [USER_A])).rows).toHaveLength(0);
    });
    await pool.query(`delete from auth.users where id in ($1, $2)`, [USER_A, USER_B]);
  });
});
