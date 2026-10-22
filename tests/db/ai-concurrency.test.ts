import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { DATABASE_URL, makePool, USER_A } from './helpers';

/**
 * Real concurrency (committed transactions on separate connections, like simultaneous requests): quota rows are
 * locked, so parallel camera reads can never exceed the limit, and a call settles exactly once.
 */
describe.skipIf(!DATABASE_URL)('AI usage under concurrency', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local')`, [USER_A]);
    await pool.query(`insert into public.onboarding_states (user_id, status) values ($1, 'completed')`, [USER_A]);
  });
  afterAll(async () => { await pool?.end(); });

  async function asA<T>(sql: string, params: unknown[]): Promise<{ ok: true; v: T } | { ok: false; msg: string }> {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER_A, role: 'authenticated' })]);
      const r = await c.query(sql, params);
      await c.query('commit');
      return { ok: true, v: r.rows[0]?.r as T };
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      return { ok: false, msg: (e as Error).message };
    } finally { c.release(); }
  }

  it('6 simultaneous camera reads on Free (2 / month): exactly 2 reserved, the rest get camera_quota', async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => asA<{ call_id: number }>(`select public.ai_reserve('vision_extract', true, 1) as r`, [])));
    expect(rs.filter((r) => r.ok)).toHaveLength(2);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && /camera_quota/.test(r.msg))).toBe(true);
    const { rows } = await pool.query(`select camera_reads from public.ai_usage where user_id = $1 and bucket like 'm:%'`, [USER_A]);
    expect(rows[0].camera_reads).toBe(2);
  });

  it('the same call recorded twice in parallel is charged once (no double charge)', async () => {
    const r = await asA<{ call_id: number }>(`select public.ai_reserve('onboarding_extract', false, 0) as r`, []);
    expect(r.ok).toBe(true);
    const id = r.ok ? r.v.call_id : 0;
    const rec = () => asA<number>(`select public.ai_record($1, 'fixture', 'fixture-text', 1000, 100, 0, 0, 100, 900, 1, 'ok') as r`, [id]);
    const both = await Promise.all([rec(), rec()]);
    expect(both.filter((x) => x.ok)).toHaveLength(1);
    const { rows } = await pool.query(`select weighted_tokens, requests from public.ai_usage where user_id = $1 and bucket like 'm:%'`, [USER_A]);
    expect(rows[0]).toEqual({ weighted_tokens: '1400', requests: 1 });
  });
});
