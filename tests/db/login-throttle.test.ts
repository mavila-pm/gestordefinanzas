import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A } from './helpers';

/** Login lockout (migrations 033–035): 3 tries per email → 5 / 15 / 30 min, committed state, parallel-safe, reset on success. */
describe.skipIf(!DATABASE_URL)('login throttle', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    await pool.query('truncate public.login_throttle');
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'ana@test.local')`, [USER_A]);
  });

  /** One committed request as the anonymous login form (separate connection, like a real request). */
  const attempt = async (email = 'Ana@Test.local', ip: string | null = '190.0.0.1') => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role anon');
      const r = (await c.query('select * from public.login_attempt($1, $2)', [email, ip])).rows[0] as { allowed: boolean; wait_seconds: number };
      await c.query('commit');
      return r;
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  };
  /** Controlled clock: end the current locks (as if their time had passed). */
  const expireLocks = () => pool.query(`update public.login_throttle set locked_until = now() - interval '1 second' where locked_until is not null`);
  const mins = (s: number) => Math.round(s / 60);

  it('3 tries, then 5 min; next 3, 15 min; then 30 min for every later group', async () => {
    expect(await attempt()).toMatchObject({ allowed: true, wait_seconds: 0 });
    expect(await attempt()).toMatchObject({ allowed: true, wait_seconds: 0 });
    const third = await attempt();
    expect(third.allowed).toBe(true);
    expect(mins(third.wait_seconds)).toBe(5); // the 3rd try runs; if it fails the lock is already in place
    const locked = await attempt();
    expect(locked.allowed).toBe(false);
    expect(mins(locked.wait_seconds)).toBe(5);
    for (const expected of [15, 30, 30]) {
      await expireLocks();
      await attempt(); await attempt();
      expect(mins((await attempt()).wait_seconds)).toBe(expected);
      expect((await attempt()).allowed).toBe(false);
    }
  });

  it('the lock is stored, not per page: another connection, other casing or another IP is still refused', async () => {
    for (let i = 0; i < 3; i++) await attempt();
    expect((await attempt(' ana@test.LOCAL ', '200.1.1.1')).allowed).toBe(false);
    expect((await attempt('otra@test.local', '200.1.1.1')).allowed).toBe(true); // other emails are not affected
    expect((await pool.query('select count(*)::int n from public.login_throttle where key_hash ~ $1', ['@'])).rows[0].n).toBe(0); // hashes only
  });

  it('parallel requests cannot get more than 3 tries per window', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => attempt()));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it('a caller-supplied IP is ignored: nobody can lock a shared IP (security review of 033)', async () => {
    for (let i = 0; i < 30; i++) expect((await attempt(`x${i}@test.local`, '181.0.0.9')).allowed).toBe(true);
    expect((await attempt('ana@test.local', '181.0.0.9')).allowed).toBe(true);
  });

  it('old idle rows are purged; active counters and locks are kept (035)', async () => {
    await attempt('viejo@test.local'); for (let i = 0; i < 3; i++) await attempt('bloqueado@test.local');
    await pool.query(`update public.login_throttle set updated_at = now() - interval '25 hours'`);
    await attempt('nuevo@test.local');
    await pool.query('select public.login_throttle_purge_now()');
    expect((await pool.query('select count(*)::int n from public.login_throttle')).rows[0].n).toBe(2); // locked + new
  });

  it('a successful sign-in resets only the signed-in person, never another email', async () => {
    await attempt(); await attempt(); await attempt('bob@test.local'); await attempt('bob@test.local');
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query('select public.login_succeeded($1)', ['190.0.0.1']);
      await c.query('commit'); await c.query('begin');
    });
    const rows = (await pool.query('select attempts, stage, locked_until from public.login_throttle order by attempts desc')).rows;
    expect(rows[0]).toMatchObject({ attempts: 2 }); // bob's email key keeps its count
    expect(rows.filter((r) => r.attempts === 0 && r.stage === 0 && r.locked_until === null)).toHaveLength(1);
    // After 24 h without attempts a key starts again from the first step.
    for (let i = 0; i < 3; i++) await attempt('carla@test.local', null);
    await expireLocks();
    await pool.query(`update public.login_throttle set updated_at = now() - interval '25 hours'`);
    await attempt('carla@test.local', null); await attempt('carla@test.local', null);
    expect(mins((await attempt('carla@test.local', null)).wait_seconds)).toBe(5);
  });

  it('clients cannot read or change the table, nor reset without signing in', async () => {
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, 'select 1 from public.login_throttle')).toBe('42501');
      expect(await errorCode(c, `select public.login_succeeded('1.1.1.1')`)).toBe('42501');
    });
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, 'update public.login_throttle set locked_until = null')).toBe('42501');
    });
  });
});
