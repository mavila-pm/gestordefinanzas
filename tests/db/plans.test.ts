import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

describe.skipIf(!DATABASE_URL)('TASK-012: plans and trial', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
    await pool.query(`insert into public.subscriptions (user_id, plan, status) values ($1, 'plus', 'active')`, [USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('trial: 14 days from config, once per user; clients cannot write their plan', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const end = (await c.query('select public.start_plus_trial() as e')).rows[0].e as Date;
      const days = Math.round((end.getTime() - Date.now()) / 86_400_000);
      expect(days).toBe(14);
      expect((await c.query('select plan, status from public.subscriptions')).rows).toEqual([{ plan: 'plus', status: 'trialing' }]);
      expect(await errorMessage(c, 'select public.start_plus_trial()')).toBe('trial_already_used');
      expect(await errorCode(c, `update public.subscriptions set status = 'active' where user_id = $1`, [USER_A])).toBe('42501');
      expect(await errorCode(c, `insert into public.subscriptions (user_id, plan, status) values ($1, 'plus', 'active')`, [USER_A])).toBe('42501');
      expect(await errorCode(c, `update public.plan_config set value = 9999 where key = 'free_auto_movements_per_month'`)).toBe('42501');
      expect((await c.query('select value from public.plan_config where key = $1', ['trial_days'])).rows[0].value).toBe(14);
    });
  });

  it('A never sees B\'s subscription; anon gets nothing', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query('select * from public.subscriptions')).rowCount).toBe(0);
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, 'select * from public.plan_config')).toBe('42501');
      expect(await errorCode(c, 'select public.start_plus_trial()')).toBe('42501');
    });
  });

  it('a paying user cannot start a trial', async () => {
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect(await errorMessage(c, 'select public.start_plus_trial()')).toBe('already_plus');
    });
  });
});
