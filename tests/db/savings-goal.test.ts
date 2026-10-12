import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, makePool, USER_A, USER_B } from './helpers';

/** Migration 038: a monthly savings goal is the person's own explicit amount (positive, bounded), never someone else's. */
describe.skipIf(!DATABASE_URL)('savings goal (planning_settings.savings_goal_minor)', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = makePool();
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.invalid'), ($2, 'b@test.invalid') on conflict do nothing`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('the owner sets and clears it; 0 or negative is refused; another user cannot read or write it', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(`insert into public.planning_settings (user_id, currency, savings_goal_minor) values ($1, 'PEN', 200000)`, [USER_A]);
      expect((await c.query(`select savings_goal_minor from public.planning_settings where currency = 'PEN'`)).rows[0].savings_goal_minor).toBe('200000');
      await c.query(`update public.planning_settings set savings_goal_minor = null where currency = 'PEN'`);
      await expect(c.query(`update public.planning_settings set savings_goal_minor = 0 where currency = 'PEN'`)).rejects.toThrow(/check/);
    });
    await pool.query(`insert into public.planning_settings (user_id, currency, savings_goal_minor) values ($1, 'PEN', 150000) on conflict (user_id, currency) do update set savings_goal_minor = 150000`, [USER_A]);
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect((await c.query(`select * from public.planning_settings where user_id = $1`, [USER_A])).rows).toHaveLength(0);
      expect((await c.query(`update public.planning_settings set savings_goal_minor = 1 where user_id = $1 returning 1`, [USER_A])).rowCount).toBe(0);
    });
    await pool.query(`delete from public.planning_settings where user_id = $1`, [USER_A]);
  });
});
