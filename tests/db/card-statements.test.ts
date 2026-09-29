import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

/** ADR-0014: card statements — own rows only, currency of its credit card, one per cut, no delete, unknown stays null. */
describe.skipIf(!DATABASE_URL)('card statements', () => {
  let pool: pg.Pool;
  let cardA: string, cardAusd: string, debitA: string, cardB: string;
  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
    const ins = async (u: string, kind: string, cur: string, l4: string) => (await pool.query(
      `insert into public.cards (user_id, alias, kind, currency, last4) values ($1, 'T', $2, $3, $4) returning id`, [u, kind, cur, l4])).rows[0].id as string;
    cardA = await ins(USER_A, 'credit', 'PEN', '1111'); cardAusd = await ins(USER_A, 'credit', 'USD', '2222');
    debitA = await ins(USER_A, 'debit', 'PEN', '3333'); cardB = await ins(USER_B, 'credit', 'PEN', '4444');
  });
  afterAll(async () => { await pool?.end(); });
  const INS = `insert into public.card_statements (user_id, card_id, currency, cut_date, due_date, billed_minor, minimum_minor) values ($1, $2, $3, '2026-09-23', '2026-10-19', $4, $5)`;

  it('owner writes; unknown amounts stay null; one statement per cut (a correction is an update)', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, INS, [USER_A, cardA, 'PEN', null, null])).toBeNull();
      expect(await errorCode(c, INS, [USER_A, cardA, 'PEN', 300000, 15000])).toBe('23505');
      expect((await c.query(`update public.card_statements set billed_minor = 300000, minimum_minor = 15000 where card_id = $1`, [cardA])).rowCount).toBe(1);
      expect(await errorCode(c, `delete from public.card_statements where card_id = $1`, [cardA])).toBe('42501');
    });
  });

  it('currency must match its credit card; debit cards have no statement; minimum ≤ total; due after cut', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, INS, [USER_A, cardAusd, 'PEN', 1, 1])).toBe('23514');
      expect(await errorCode(c, INS, [USER_A, debitA, 'PEN', 1, 1])).toBe('23514');
      expect(await errorCode(c, INS, [USER_A, cardA, 'PEN', 100, 200])).toBe('23514');
      expect(await errorCode(c, `insert into public.card_statements (user_id, card_id, currency, cut_date, due_date) values ($1, $2, 'PEN', '2026-09-23', '2026-09-20')`, [USER_A, cardA])).toBe('23514');
    });
  });

  it('A/B: A cannot attach a statement to B\'s card, see or change B\'s statements; anon has no access', async () => {
    await pool.query(INS, [USER_B, cardB, 'PEN', 777700, 1000]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, INS, [USER_A, cardB, 'PEN', 1, 1])).not.toBeNull();
      expect(await errorCode(c, INS, [USER_B, cardB, 'PEN', 1, 1])).not.toBeNull();
      expect((await c.query(`select count(*)::int n from public.card_statements`)).rows[0].n).toBe(0);
      expect((await c.query(`update public.card_statements set billed_minor = 1`)).rowCount).toBe(0);
    });
    await asRole(pool, 'anon', null, async (c) => { expect(await errorCode(c, `select 1 from public.card_statements`)).toBe('42501'); });
  });
});
