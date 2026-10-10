import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

/** Migration 039: preferences are the person's own; the main account must be theirs; values are whitelisted. */
describe.skipIf(!DATABASE_URL)('user_preferences', () => {
  let pool: pg.Pool;
  let accA: string, accB: string;
  beforeAll(async () => {
    pool = makePool();
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.invalid'), ($2, 'b@test.invalid') on conflict do nothing`, [USER_A, USER_B]);
    accA = (await pool.query(`insert into public.accounts (user_id, institution_code, alias, currency) values ($1, 'BCP', 'A soles', 'PEN') returning id`, [USER_A])).rows[0].id;
    accB = (await pool.query(`insert into public.accounts (user_id, institution_code, alias, currency) values ($1, 'BBVA', 'B soles', 'PEN') returning id`, [USER_B])).rows[0].id;
  });
  afterAll(async () => {
    await pool.query(`delete from public.user_preferences where user_id in ($1, $2)`, [USER_A, USER_B]);
    await pool.query(`delete from public.accounts where id in ($1, $2)`, [accA, accB]);
    await pool?.end();
  });

  it('owner saves and reads; defaults are balanced / proactive / PEN / notices on', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(`insert into public.user_preferences (user_id) values ($1)`, [USER_A]);
      expect((await c.query(`select vels_style, vels_proactive, primary_currency, notify_upcoming, notify_review, notify_monthly, notify_limits from public.user_preferences`)).rows[0])
        .toEqual({ vels_style: 'balanced', vels_proactive: true, primary_currency: 'PEN', notify_upcoming: true, notify_review: true, notify_monthly: true, notify_limits: true });
      await c.query(`update public.user_preferences set vels_style = 'brief', primary_currency = 'USD', primary_account_id = $1, notify_monthly = false`, [accA]);
      expect((await c.query(`select vels_style, primary_currency, primary_account_id from public.user_preferences`)).rows[0]).toEqual({ vels_style: 'brief', primary_currency: 'USD', primary_account_id: accA });
    });
  });
  it('refuses unknown values, another person\'s account, and any access to another person\'s row', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(`insert into public.user_preferences (user_id) values ($1)`, [USER_A]);
      expect(await errorCode(c, `update public.user_preferences set vels_style = 'verbose'`)).toBe('23514');
      expect(await errorCode(c, `update public.user_preferences set primary_account_id = $1`, [accB])).toBe('23503');
      expect(await errorCode(c, `insert into public.user_preferences (user_id) values ($1)`, [USER_B])).toBe('42501');
    });
    await pool.query(`insert into public.user_preferences (user_id, vels_style) values ($1, 'detailed') on conflict (user_id) do update set vels_style = 'detailed'`, [USER_B]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query(`select * from public.user_preferences where user_id = $1`, [USER_B])).rows).toHaveLength(0);
      expect((await c.query(`update public.user_preferences set vels_style = 'brief' where user_id = $1 returning 1`, [USER_B])).rowCount).toBe(0);
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, `select * from public.user_preferences`)).toBe('42501');
    });
  });
  it('deleting the main account clears the preference only', async () => {
    const tmp = (await pool.query(`insert into public.accounts (user_id, institution_code, alias, currency) values ($1, 'BCP', 'tmp', 'PEN') returning id`, [USER_A])).rows[0].id;
    await pool.query(`insert into public.user_preferences (user_id, primary_account_id) values ($1, $2) on conflict (user_id) do update set primary_account_id = $2`, [USER_A, tmp]);
    await pool.query(`delete from public.accounts where id = $1`, [tmp]);
    expect((await pool.query(`select primary_account_id, vels_style from public.user_preferences where user_id = $1`, [USER_A])).rows[0]).toMatchObject({ primary_account_id: null });
  });
});
