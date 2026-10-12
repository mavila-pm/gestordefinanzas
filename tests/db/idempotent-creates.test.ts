import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

/** ADR-0012: the same submission reference stores one row, even from parallel committed requests (two tabs). */
describe.skipIf(!DATABASE_URL)('idempotent creates (client_ref)', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  async function asUser(user: string, sql: string, params: unknown[]): Promise<string | null> {
    const c = await pool.connect();
    try {
      await c.query('begin'); await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
      await c.query(sql, params); await c.query('commit'); return null;
    } catch (e) { await c.query('rollback').catch(() => undefined); return (e as { code?: string }).code ?? 'err'; } finally { c.release(); }
  }

  it('5 parallel requests with the same reference → exactly one debt; the rest are recognizable replays (23505)', async () => {
    const sql = `insert into public.debts (user_id, name, principal_minor, balance_minor, client_ref) values ($1, 'Deuda con tu pareja', 100000, 100000, 'vels:11111111-1111-4111-8111-111111111111')`;
    const codes = await Promise.all(Array.from({ length: 5 }, () => asUser(USER_A, sql, [USER_A])));
    expect(codes.filter((c) => c === null)).toHaveLength(1);
    expect(codes.filter((c) => c === '23505')).toHaveLength(4);
    expect((await pool.query(`select count(*)::int n from public.debts where user_id = $1`, [USER_A])).rows[0].n).toBe(1);
  });

  it('references are per user (B can use the same value) and malformed ones are rejected; null stays allowed', async () => {
    for (const t of ['fixed_expenses', 'expected_incomes']) {
      const cols = t === 'fixed_expenses' ? '(user_id, name, amount_minor, due_day, client_ref)' : '(user_id, name, amount_minor, day_of_month, client_ref)';
      expect(await asUser(USER_A, `insert into public.${t} ${cols} values ($1, 'X', 1000, 5, 'ref-12345678')`, [USER_A])).toBeNull();
      expect(await asUser(USER_B, `insert into public.${t} ${cols} values ($1, 'X', 1000, 5, 'ref-12345678')`, [USER_B])).toBeNull();
      expect(await asUser(USER_A, `insert into public.${t} ${cols} values ($1, 'X', 1000, 5, 'ref-12345678')`, [USER_A])).toBe('23505');
      expect(await asUser(USER_A, `insert into public.${t} ${cols} values ($1, 'X', 1000, 5, null)`, [USER_A])).toBeNull();
    }
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, `insert into public.accounts (user_id, alias, currency, client_ref) values ($1, 'A', 'PEN', 'bad ref; drop')`, [USER_A])).toBe('23514');
      expect(await errorCode(c, `insert into public.accounts (user_id, alias, currency, client_ref) values ($1, 'A', 'PEN', 'ref-12345678')`, [USER_B])).toBe('42501');
    });
  });
});
