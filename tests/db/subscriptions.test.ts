import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

/** Mis suscripciones (migration 042): provider + payment instrument on fixed_expenses, owner-only, one instrument max. */
describe.skipIf(!DATABASE_URL)('subscriptions on fixed_expenses', () => {
  let pool: pg.Pool;
  let cardA: string, cardB: string, accountA: string;
  beforeAll(() => { pool = makePool(); });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    await pool.query('delete from public.fixed_expenses');
    await pool.query('delete from public.cards');
    await pool.query('delete from public.accounts');
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
    cardA = (await pool.query(`insert into public.cards (user_id, alias, kind, currency, last4) values ($1, 'Visa A', 'credit', 'PEN', '4821') returning id`, [USER_A])).rows[0].id;
    cardB = (await pool.query(`insert into public.cards (user_id, alias, kind, currency, last4) values ($1, 'Visa B', 'credit', 'PEN', '1111') returning id`, [USER_B])).rows[0].id;
    accountA = (await pool.query(`insert into public.accounts (user_id, alias, currency) values ($1, 'Ahorros A', 'PEN') returning id`, [USER_A])).rows[0].id;
  });

  const insert = (c: pg.PoolClient, extra: Record<string, unknown>) => {
    const cols = ['user_id', 'name', 'kind', 'amount_minor', 'due_day', ...Object.keys(extra)];
    const vals = [USER_A, 'Netflix', 'subscription', 4490, 15, ...Object.values(extra)];
    return errorCode(c, `insert into public.fixed_expenses (${cols.join(',')}) values (${vals.map((_, i) => `$${i + 1}`).join(',')})`, vals);
  };

  it('owner links own card or account and a catalogue provider; one instrument at most; bad slug refused', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await insert(c, { provider: 'netflix', card_id: cardA })).toBeNull();
      expect(await insert(c, { provider: 'spotify', account_id: accountA })).toBeNull();
      expect(await insert(c, { card_id: cardA, account_id: accountA })).toBe('23514');
      expect(await insert(c, { provider: 'Bad Slug!' })).toBe('23514');
    });
  });

  it("another person's card cannot be linked (composite FK), and their subscriptions stay invisible", async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await insert(c, { provider: 'netflix', card_id: cardB })).toBe('23503');
    });
    await pool.query(`insert into public.fixed_expenses (user_id, name, kind, amount_minor, due_day, provider) values ($1, 'Disney+', 'subscription', 3490, 3, 'disney-plus')`, [USER_A]);
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect((await c.query(`select * from public.fixed_expenses where kind = 'subscription'`)).rowCount).toBe(0);
      expect((await c.query(`update public.fixed_expenses set amount_minor = 1 where provider = 'disney-plus' returning id`)).rowCount).toBe(0);
    });
  });

  it('removing a card keeps the subscription and only clears its card', async () => {
    await pool.query(`insert into public.fixed_expenses (user_id, name, kind, amount_minor, due_day, provider, card_id) values ($1, 'Netflix', 'subscription', 4490, 15, 'netflix', $2)`, [USER_A, cardA]);
    await pool.query('delete from public.cards where id = $1', [cardA]);
    const r = (await pool.query(`select user_id, card_id, amount_minor from public.fixed_expenses where provider = 'netflix'`)).rows[0];
    expect(r).toEqual({ user_id: USER_A, card_id: null, amount_minor: '4490' });
  });
});
