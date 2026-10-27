import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

/**
 * Inversiones, goals and the onboarding profile (migration 059, CR-002). Own rows only, entries append-only, never
 * more withdrawn than contributed, value = last valuation (never invented), goals fixed or % of income.
 */
describe.skipIf(!DATABASE_URL)('investments, goals, profile', () => {
  let pool: pg.Pool;
  const inv = `insert into public.investments (user_id, name, kind, currency, institution) values ($1, $2, 'fondo_mutuo', 'PEN', 'Credicorp') returning id`;
  const entry = `insert into public.investment_entries (user_id, investment_id, kind, amount_minor, on_date) values ($1, $2, $3, $4, $5)`;

  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('position: contributed = aportes − retiros; value = the last valuation, unknown without one', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const id = (await c.query(inv, [USER_A, 'Fondo conservador'])).rows[0].id;
      expect((await c.query('select contributed_minor, value_minor from public.investment_positions')).rows).toEqual([{ contributed_minor: '0', value_minor: null }]);
      await c.query(entry, [USER_A, id, 'contribution', 100000, '2026-09-01']);
      await c.query(entry, [USER_A, id, 'contribution', 50000, '2026-10-01']);
      await c.query(entry, [USER_A, id, 'withdrawal', 20000, '2026-10-10']);
      expect((await c.query('select contributed_minor, value_minor from public.investment_positions')).rows).toEqual([{ contributed_minor: '130000', value_minor: null }]);
      await c.query(entry, [USER_A, id, 'valuation', 140000, '2026-10-20']);
      await c.query(entry, [USER_A, id, 'valuation', 120000, '2026-09-20']); // older date: not the latest
      expect((await c.query(`select value_minor, value_on::text from public.investment_positions`)).rows).toEqual([{ value_minor: '140000', value_on: '2026-10-20' }]);
    });
  });

  it('never more withdrawn than contributed; aportes > 0; archived takes nothing; append-only', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const id = (await c.query(inv, [USER_A, 'Plazo fijo'])).rows[0].id;
      await c.query(entry, [USER_A, id, 'contribution', 1000, '2026-10-01']);
      expect(await errorCode(c, entry, [USER_A, id, 'withdrawal', 1001, '2026-10-02'])).toBe('23514');
      expect(await errorCode(c, entry, [USER_A, id, 'contribution', 0, '2026-10-02'])).toBe('23514');
      expect(await errorCode(c, entry, [USER_A, id, 'valuation', 0, '2026-10-02'])).toBeNull(); // lost everything is a real value
      expect(await errorCode(c, 'update public.investment_entries set amount_minor = 1')).toBe('42501');
      expect(await errorCode(c, 'delete from public.investment_entries')).toBe('42501');
      await c.query('update public.investments set active = false where id = $1', [id]);
      expect(await errorCode(c, entry, [USER_A, id, 'contribution', 5, '2026-10-03'])).toBe('23514');
      expect(await errorCode(c, `update public.investments set currency = 'USD' where id = $1`, [id])).toBe('42501');
    });
  });

  it('refuses account-number-like names and unknown kinds', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, inv, [USER_A, 'Cuenta 1912 3456 7890'])).toBe('23514');
      expect(await errorCode(c, `insert into public.investments (user_id, name, kind, currency) values ($1, 'X', 'casino', 'PEN')`, [USER_A])).toBe('23514');
    });
  });

  it('goals: fixed or % of income; a % goal needs its percentage', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const id = (await c.query(inv, [USER_A, 'ETF'])).rows[0].id;
      await c.query(`insert into public.planning_settings (user_id, currency, savings_goal_mode, savings_goal_bp, investment_goal_mode, investment_goal_minor, investment_goal_investment_id)
        values ($1, 'PEN', 'percent', 1000, 'fixed', 50000, $2)`, [USER_A, id]);
      expect(await errorCode(c, `update public.planning_settings set investment_goal_mode = 'percent' where user_id = $1`, [USER_A])).toBe('23514');
      expect(await errorCode(c, `update public.planning_settings set savings_goal_bp = 10001 where user_id = $1`, [USER_A])).toBe('23514');
    });
  });

  it('profile: work type, investments, debts, main goal (null = not said)', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(`insert into public.user_preferences (user_id, work_type, has_investments, main_goal) values ($1, 'independent', true, 'ahorrar')`, [USER_A]);
      expect((await c.query('select work_type, has_investments, has_debts, main_goal from public.user_preferences')).rows)
        .toEqual([{ work_type: 'independent', has_investments: true, has_debts: null, main_goal: 'ahorrar' }]);
      expect(await errorCode(c, `update public.user_preferences set work_type = 'jefe'`)).toBe('23514');
    });
  });

  it('A never sees nor writes B investments; anon nothing', async () => {
    const id = (await pool.query(inv, [USER_B, 'De B'])).rows[0].id;
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query('select count(*)::int n from public.investments')).rows[0].n).toBe(0);
      expect((await c.query('select count(*)::int n from public.investment_positions')).rows[0].n).toBe(0);
      expect(await errorCode(c, entry, [USER_A, id, 'contribution', 5, '2026-10-01'])).toBe('23503');
      expect(await errorCode(c, entry, [USER_B, id, 'contribution', 5, '2026-10-01'])).toBe('42501');
      expect(await errorCode(c, `insert into public.planning_settings (user_id, currency, investment_goal_investment_id) values ($1, 'PEN', $2)`, [USER_A, id])).toBe('23503');
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, 'select * from public.investment_positions')).toBe('42501');
    });
  });
});
