import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

/** ADR-0006: AI entitlements and usage accounting (adenda §33-§54, §73). */
describe.skipIf(!DATABASE_URL)('AI usage, quotas and demo controls', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query('delete from public.ai_global_daily');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => {
    await pool.query(`update public.plan_config set value = 5000000 where key = 'ai_global_daily_budget_micro_usd'`);
    await pool?.end();
  });

  const reserve = (c: pg.PoolClient, camera = false, images = 0) =>
    c.query('select public.ai_reserve($1, $2, $3) as r', [camera ? 'vision_extract' : 'onboarding_extract', camera, images]).then((r) => r.rows[0].r);
  const record = (c: pg.PoolClient, id: number, input: number, output: number, outcome = 'ok', cost = 100) =>
    c.query('select public.ai_record($1, $2, $3, $4, $5, 0, 0, $6, 900, 1, $7) as w', [id, 'fixture', 'fixture-text', input, output, cost, outcome]).then((r) => Number(r.rows[0].w));

  it('onboarding allowance is separate and used first; weighted tokens use the configured weights', async () => {
    await pool.query(`insert into public.onboarding_states (user_id) values ($1)`, [USER_A]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const r = await reserve(c);
      expect(r.bucket).toBe('onboarding');
      expect(r.plan).toBe('free');
      expect(await record(c, r.call_id, 1000, 100)).toBe(1400); // 1000 + 100*4
      expect((await c.query(`select weighted_tokens, requests from public.ai_usage where bucket = 'onboarding'`)).rows)
        .toEqual([{ weighted_tokens: '1400', requests: 1 }]);
      expect((await c.query(`select weighted_tokens, requests from public.ai_usage where bucket like 'm:%'`)).rows)
        .toEqual([{ weighted_tokens: '0', requests: 0 }]);
      // Settles exactly once.
      expect(await errorMessage(c, 'select public.ai_record($1, $2, $3, 1, 1, 0, 0, 0, 1, 1, $4)', [r.call_id, 'x', 'y', 'ok'])).toBe('bad_call');
    });
  });

  it('exhausted onboarding allowance falls back to the plan bucket; exhausted Free month raises ai_quota', async () => {
    await pool.query(`insert into public.onboarding_states (user_id) values ($1)`, [USER_A]);
    await pool.query(`insert into public.ai_usage (user_id, bucket, weighted_tokens) values ($1, 'onboarding', 80000)`, [USER_A]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const r = await reserve(c);
      expect(r.bucket).toMatch(/^m:\d{4}-\d{2}$/);
      await record(c, r.call_id, 25000, 0);
      expect(await errorMessage(c, `select public.ai_reserve('assistant_answer', false, 0)`)).toBe('ai_quota');
    });
  });

  it('Plus and trial get their own limits; a demo simulation overrides the plan without touching the subscription', async () => {
    await pool.query(`insert into public.subscriptions (user_id, plan, status) values ($1, 'plus', 'active')`, [USER_B]);
    await pool.query(`insert into public.ai_usage (user_id, bucket, weighted_tokens) values ($1, 'm:' || to_char(now() at time zone 'America/Lima', 'YYYY-MM'), 1000000)`, [USER_B]);
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect((await reserve(c)).plan).toBe('plus'); // 1.0M used < 1.5M
      expect(await errorMessage(c, `select public.set_demo_plan('free')`)).toBe('not_demo');
    });
    await pool.query(`insert into public.demo_access (user_id) values ($1)`, [USER_B]);
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      await c.query(`select public.set_demo_plan('free')`);
      expect(await errorMessage(c, `select public.ai_reserve('assistant_answer', false, 0)`)).toBe('ai_quota'); // 1.0M > 25k
      await c.query(`select public.set_demo_plan('trial')`);
      expect((await reserve(c)).bucket).toBe('trial');
      expect((await c.query('select plan, status from public.subscriptions')).rows).toEqual([{ plan: 'plus', status: 'active' }]);
      expect(await errorCode(c, `update public.demo_access set simulated_plan = 'plus'`)).toBe('42501');
    });
  });

  it('camera reads: separate quota, image batch limit, and a failed call gives the read back', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, `select public.ai_reserve('vision_extract', true, 4)`)).toBe('too_many_images');
      const r1 = await reserve(c, true, 1);
      await record(c, r1.call_id, 0, 50, 'error');
      const r2 = await reserve(c, true, 1);
      await record(c, r2.call_id, 0, 50);
      const r3 = await reserve(c, true, 1);
      await record(c, r3.call_id, 0, 50);
      expect(await errorMessage(c, `select public.ai_reserve('vision_extract', true, 1)`)).toBe('camera_quota'); // Free: 2 / month
      const u = (await c.query(`select camera_reads, errors from public.ai_usage where bucket like 'm:%'`)).rows[0];
      expect(u).toEqual({ camera_reads: 2, errors: 1 });
    });
  });

  it('per-day rate limit and the global budget guard fail safe', async () => {
    await pool.query(`update public.plan_config set value = 1 where key = 'ai_global_daily_budget_micro_usd'`);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const r = await reserve(c);
      await record(c, r.call_id, 10, 10, 'ok', 5);
      expect(await errorMessage(c, `select public.ai_reserve('assistant_answer', false, 0)`)).toBe('ai_budget');
    });
    await pool.query(`update public.plan_config set value = 5000000 where key = 'ai_global_daily_budget_micro_usd'`);
    await pool.query(`insert into public.ai_usage_daily (user_id, day, requests) values ($1, (now() at time zone 'America/Lima')::date, 40)`, [USER_A]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, `select public.ai_reserve('assistant_answer', false, 0)`)).toBe('ai_rate');
    });
  });

  it('isolation: A never sees nor consumes B\'s usage; clients cannot write usage or the global guard', async () => {
    await pool.query(`insert into public.ai_usage (user_id, bucket, weighted_tokens) values ($1, 'onboarding', 7)`, [USER_B]);
    await pool.query(`insert into public.onboarding_states (user_id, facts) values ($1, '{"secret":1}')`, [USER_B]);
    await pool.query(`insert into public.conversation_messages (user_id, thread, role, body) values ($1, 'assistant', 'user', 'B secreto')`, [USER_B]);
    let bCall = 0;
    await asRole(pool, 'authenticated', USER_B, async (c) => { bCall = (await reserve(c)).call_id; await c.query('commit'); await c.query('begin'); });
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query('select * from public.ai_usage')).rowCount).toBe(0);
      expect((await c.query('select * from public.onboarding_states')).rowCount).toBe(0);
      expect((await c.query('select * from public.conversation_messages')).rowCount).toBe(0);
      expect(await errorMessage(c, 'select public.ai_record($1, $2, $3, 1, 1, 0, 0, 0, 1, 1, $4)', [bCall, 'x', 'y', 'error'])).toBe('bad_call');
      expect(await errorCode(c, `update public.ai_usage set weighted_tokens = 0`)).toBe('42501');
      expect(await errorCode(c, `insert into public.ai_usage (user_id, bucket) values ($1, 'trial')`, [USER_A])).toBe('42501');
      expect(await errorCode(c, `select * from public.ai_calls`)).toBe('42501');
      expect(await errorCode(c, `select * from public.ai_global_daily`)).toBe('42501');
      expect(await errorCode(c, `insert into public.conversation_messages (user_id, thread, role, body) values ($1, 'assistant', 'user', 'x')`, [USER_B])).toBe('42501');
      expect(await errorCode(c, `select public.ai_effective_plan($1)`, [USER_A])).toBe('42501');
    });
    // B's reservation counted on B's own onboarding allowance; A's attempts created nothing anywhere.
    expect((await pool.query(`select requests from public.ai_usage where user_id = $1 and bucket = 'onboarding'`, [USER_B])).rows).toEqual([{ requests: 1 }]);
    expect((await pool.query(`select count(*)::int n from public.ai_usage where user_id = $1`, [USER_A])).rows).toEqual([{ n: 0 }]);
    expect((await pool.query(`select outcome from public.ai_calls where id = $1`, [bCall])).rows).toEqual([{ outcome: 'pending' }]);
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, `select public.ai_reserve('assistant_answer', false, 0)`)).toBe('42501');
    });
  });

  it('demo reset gives back only the onboarding allowance, and only to allowlisted users', async () => {
    await pool.query(`insert into public.ai_usage (user_id, bucket, weighted_tokens, camera_reads) values ($1, 'onboarding', 50000, 3), ($1, 'm:2026-01', 9, 0)`, [USER_A]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, 'select public.reset_demo_ai_onboarding()')).toBe('not_demo');
    });
    await pool.query(`insert into public.demo_access (user_id) values ($1)`, [USER_A]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query('select public.reset_demo_ai_onboarding()');
      expect((await c.query(`select bucket, weighted_tokens, camera_reads from public.ai_usage order by bucket`)).rows)
        .toEqual([{ bucket: 'm:2026-01', weighted_tokens: '9', camera_reads: 0 }, { bucket: 'onboarding', weighted_tokens: '0', camera_reads: 0 }]);
    });
  });
  it('demo-only snapshot delete: allowlisted, own rows only, capped', async () => {
    const a = (await pool.query(`insert into public.balance_snapshots (user_id, currency, amount_minor) values ($1, 'PEN', 100) returning id`, [USER_A])).rows[0].id;
    const b = (await pool.query(`insert into public.balance_snapshots (user_id, currency, amount_minor) values ($1, 'PEN', 200) returning id`, [USER_B])).rows[0].id;
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, 'select public.delete_demo_balance_snapshots($1)', [[a]])).toBe('not_demo');
      expect(await errorCode(c, 'delete from public.balance_snapshots where id = $1', [a])).toBe('42501');
    });
    await pool.query(`insert into public.demo_access (user_id) values ($1)`, [USER_A]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query('select public.delete_demo_balance_snapshots($1) as n', [[a, b]])).rows[0].n).toBe(1);
      await c.query('commit'); await c.query('begin');
    });
    expect((await pool.query('select id from public.balance_snapshots order by amount_minor')).rows.map((r) => r.id)).toEqual([b]);
  });
});
