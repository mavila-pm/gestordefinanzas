import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

describe.skipIf(!DATABASE_URL)('suggestion decisions + learning trail (ADR-0008)', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('one decision per suggestion; "later" needs a date, "dismissed" none; unknown kinds rejected', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(`insert into public.suggestion_decisions (user_id, kind, subject, value_minor, decision) values ($1, 'essentials', 'PEN', 45000, 'dismissed')`, [USER_A]);
      expect(await errorCode(c, `insert into public.suggestion_decisions (user_id, kind, subject, decision) values ($1, 'essentials', 'PEN', 'dismissed')`, [USER_A])).toBe('23505');
      expect(await errorCode(c, `insert into public.suggestion_decisions (user_id, kind, subject, decision) values ($1, 'observed_amount', 'x', 'later')`, [USER_A])).toBe('23514');
      expect(await errorCode(c, `insert into public.suggestion_decisions (user_id, kind, subject, decision) values ($1, 'hack', 'x', 'dismissed')`, [USER_A])).toBe('23514');
      // upsert = change of mind
      await c.query(`insert into public.suggestion_decisions (user_id, kind, subject, decision, until) values ($1, 'essentials', 'PEN', 'later', current_date + 14)
        on conflict (user_id, kind, subject) do update set decision = excluded.decision, until = excluded.until, value_minor = excluded.value_minor`, [USER_A]);
      expect((await c.query(`select decision from public.suggestion_decisions`)).rows[0].decision).toBe('later');
    });
  });

  it('A/B: B cannot read, write or delete A\'s decisions or trail; the trail is append-only', async () => {
    await pool.query(`insert into public.suggestion_decisions (user_id, kind, subject, decision) values ($1, 'essentials', 'PEN', 'dismissed')`, [USER_A]);
    await pool.query(`insert into public.learning_events (user_id, entity, action, detail) values ($1, 'onboarding', 'deleted', '{"messages": 4}')`, [USER_A]);
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      for (const t of ['suggestion_decisions', 'learning_events']) expect((await c.query(`select count(*)::int as n from public.${t}`)).rows[0].n).toBe(0);
      expect(await errorCode(c, `insert into public.learning_events (user_id, entity, action) values ($1, 'rule', 'deleted')`, [USER_A])).toBe('42501');
      expect((await c.query(`delete from public.suggestion_decisions returning id`)).rowCount).toBe(0);
    });
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, `update public.learning_events set action = 'restored'`, [])).toBe('42501');
      expect(await errorCode(c, `delete from public.learning_events`, [])).toBe('42501');
      expect(await errorCode(c, `insert into public.learning_events (user_id, entity, action) values ($1, 'transaction', 'deleted')`, [USER_A])).toBe('23514');
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, 'select * from public.learning_events', [])).toBe('42501');
    });
  });
});
