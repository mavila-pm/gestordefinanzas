import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool } from './helpers';

/** Cap replay store (migration 040): a key is spent once while valid; table closed to every client role. */
describe.skipIf(!DATABASE_URL)('cap_spent', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => { await pool.query('truncate public.cap_spent'); });

  /** One committed call as the anonymous login form (separate connection, like a real request). */
  const spend = async (key: string, ttl = 600) => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role anon');
      const r = (await c.query('select public.cap_spend($1, $2) as ok', [key, ttl])).rows[0] as { ok: boolean };
      await c.query('commit');
      return r.ok;
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  };

  it('first spend wins, the same key again is refused (replay), a different key is independent', async () => {
    expect(await spend('r:AAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
    expect(await spend('r:AAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    expect(await spend('r:BBBBBBBBBBBBBBBBBBBBBB')).toBe(true);
    // Only the hash is stored, never the key itself.
    const rows = (await pool.query('select key_hash from public.cap_spent')).rows as Array<{ key_hash: string }>;
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.key_hash))).toBe(true);
  });

  it('parallel spends of one key: exactly one succeeds', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => spend('c:CCCCCCCCCCCCCCCCCCCCCC')));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('an expired row is reused in place (no delete)', async () => {
    expect(await spend('r:DDDDDDDDDDDDDDDDDDDDDD', 1)).toBe(true);
    await pool.query(`update public.cap_spent set expires_at = now() - interval '1 second'`);
    expect(await spend('r:DDDDDDDDDDDDDDDDDDDDDD')).toBe(true);
    expect((await pool.query('select count(*)::int as n from public.cap_spent')).rows[0].n).toBe(1);
  });

  it('rejects malformed keys and TTLs; the table is closed to anon and authenticated', async () => {
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, `select public.cap_spend('bad', 60)`)).toBe('22023');
      expect(await errorCode(c, `select public.cap_spend('r:AAAAAAAAAAAAAAAAAAAAAA', 0)`)).toBe('22023');
      expect(await errorCode(c, `select public.cap_spend('r:AAAAAAAAAAAAAAAAAAAAAA', 99999)`)).toBe('22023');
      expect(await errorCode(c, 'select * from public.cap_spent')).toBe('42501');
      expect(await errorCode(c, `insert into public.cap_spent values (repeat('a', 64), now())`)).toBe('42501');
    });
    await asRole(pool, 'authenticated', '00000000-0000-4000-8000-00000000000a', async (c) => {
      expect(await errorCode(c, 'select * from public.cap_spent')).toBe('42501');
      expect(await errorCode(c, `delete from public.cap_spent`)).toBe('42501');
    });
  });
});
