import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

/** MVP P1 "Eliminar mi cuenta": the person deletes only themselves, with confirmation; every row of theirs goes (cascade). */
describe.skipIf(!DATABASE_URL)('delete_my_account', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
    for (const u of [USER_A, USER_B]) {
      await pool.query(`insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, status, confidence, fingerprint)
        values ($1, now(), 'expense', 'outflow', 1000, 'PEN', 'confirmed', 'high', $2)`, [u, `fp-${u}`]);
      await pool.query(`insert into public.debts (user_id, name, principal_minor, balance_minor) values ($1, 'Deuda', 1000, 500)`, [u]);
      await pool.query(`insert into public.balance_snapshots (user_id, currency, amount_minor) values ($1, 'PEN', 5000)`, [u]);
    }
  });

  /** Rows of a user across every public table that has user_id (same scan as tests/e2e/cleanup.sql). */
  const rowsOf = async (c: pg.PoolClient, user: string) => {
    const tables = (await c.query(`select c.table_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
      where c.table_schema = 'public' and c.column_name = 'user_id' and t.table_type = 'BASE TABLE'`)).rows.map((r) => r.table_name as string);
    let n = 0;
    for (const t of tables) n += (await c.query(`select count(*)::int n from public."${t}" where user_id = $1`, [user])).rows[0].n;
    return n;
  };

  it('A deletes A: auth user and every public row of A gone; B untouched', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(`select public.delete_my_account('ELIMINAR')`);
      await c.query('reset role');
      expect((await c.query(`select count(*)::int n from auth.users where id = $1`, [USER_A])).rows[0].n).toBe(0);
      expect(await rowsOf(c, USER_A)).toBe(0);
      expect(await rowsOf(c, USER_B)).toBeGreaterThanOrEqual(3);
      expect((await c.query(`select count(*)::int n from auth.users where id = $1`, [USER_B])).rows[0].n).toBe(1);
    });
  });

  it('refuses without the exact confirmation, for anon, and never touches another person', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, `select public.delete_my_account('eliminar')`)).toBe('22023');
      expect(await errorCode(c, `select public.delete_my_account(null)`)).toBe('22023');
      // Direct deletes stay impossible for the client.
      expect(await errorCode(c, `delete from auth.users where id = $1`, [USER_B])).toBe('42501');
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, `select public.delete_my_account('ELIMINAR')`)).toBe('42501');
    });
    expect((await pool.query(`select count(*)::int n from auth.users`)).rows[0].n).toBe(2);
  });
});
