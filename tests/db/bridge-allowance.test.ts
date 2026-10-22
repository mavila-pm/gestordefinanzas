import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ingestRawEvent, type UserContext } from '../../src/engine/ingest';
import { PgTransactionRepository } from '../../src/infrastructure/postgres/pg-transaction-repository';
import * as fx from '../fixtures/bcp';
import { DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

/**
 * Migration 048: ONE per-person lock for every automatic write path (import RPC + Email Bridge), counted on a snapshot
 * taken after the lock (VOLATILE), fail-closed on a caller identity that does not name the person. Every race below
 * uses committed, parallel transactions (rule: concurrency-sensitive counters tested with parallel commits).
 */
const INSERT = 'select public.import_insert_transaction($1::jsonb, $2::jsonb, null) as id';
const tx = (i: number, inst: string) => JSON.stringify({
  type: 'expense', direction: 'outflow', amount_minor: 1000 + i, currency: 'PEN', occurred_at: '2026-09-15T20:30:00-05:00',
  institution_code: inst, card_last4: null, merchant_raw: `TIENDA ${i}`, merchant_normalized: `TIENDA ${i}`,
  category: 'Otros', status: 'review_required', confidence: 'medium', fingerprint: `fp-${inst}-${i}`,
});
const src = (i: number, inst: string) => JSON.stringify({
  channel: 'import', external_event_id: `ev-${inst}-${i}`, parser_version: `${inst}_SMS_V1`, template_verification: 'SYNTHETIC_UNVERIFIED',
  received_at: '2026-09-15T20:31:00Z',
});
const ctx = (userId: string): UserContext => ({ userId, ownAccountLast4: [], cards: [], merchantRules: [] });
/** A distinct BCP purchase email (own amount and operation id, so no dedupe merges it into another one). */
const bcpEmail = (i: number) => {
  const raw = fx.purchasePenEmail(`<allowance-${i}@mail.test>`);
  raw.body = raw.body.replace('S/ 100.00', `S/ ${200 + i}.00`).replace('000111', `7${String(i).padStart(5, '0')}`);
  return raw;
};

describe.skipIf(!DATABASE_URL)('assert_auto_allowance: one lock for every automatic write path (migration 048)', () => {
  let pool: pg.Pool;
  const setLimit = (n: number) => pool.query(`update public.plan_config set value = $1 where key = 'free_auto_movements_per_month'`, [n]);
  const countOf = async (user: string) => (await pool.query('select count(*)::int n from public.transactions where user_id = $1', [user])).rows[0].n as number;

  /** One import RPC call as the person (role authenticated + JWT claims), COMMITTED. Error message or null. */
  const importAs = async (user: string, i: number, inst = 'BCP'): Promise<string | null> => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
      await c.query(INSERT, [tx(i, inst), src(i, inst)]);
      await c.query('commit');
      return null;
    } catch (e) {
      await c.query('rollback');
      return (e as Error).message;
    } finally {
      c.release();
    }
  };
  /** The Email Bridge write path (PgTransactionRepository over a privileged connection). Ingest outcome. */
  const bridge = async (i: number, user = USER_A) =>
    (await ingestRawEvent(bcpEmail(i), ctx(user), new PgTransactionRepository(pool), undefined, { requireVerifiedTemplate: true })).outcome;

  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
    await setLimit(3);
  });
  afterAll(async () => { await setLimit(50); await pool?.end(); });

  it('5 parallel imports with one slot left: exactly 1 commits, 4 get plan_auto_limit', async () => {
    expect(await importAs(USER_A, 1)).toBeNull();
    expect(await importAs(USER_A, 2)).toBeNull();
    const results = await Promise.all([3, 4, 5, 6, 7].map((i) => importAs(USER_A, i)));
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === 'plan_auto_limit')).toHaveLength(4);
    expect(await countOf(USER_A)).toBe(3);
  });

  it('deterministic: an import waits for the open import that took the last slot, then sees it and is refused', async () => {
    expect(await importAs(USER_A, 1)).toBeNull();
    expect(await importAs(USER_A, 2)).toBeNull();
    const first = await pool.connect();
    const asPerson = async (c: pg.PoolClient) => {
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER_A, role: 'authenticated' })]);
    };
    try {
      await asPerson(first);
      await first.query(INSERT, [tx(3, 'BCP'), src(3, 'BCP')]); // took the last slot; NOT committed yet
      let settled = false;
      const second = importAs(USER_A, 4).finally(() => { settled = true; });
      // Commit the first only once the second is blocked on the per-person lock (or, without the lock, already done).
      for (let i = 0; i < 100 && !settled; i++) {
        const { rows } = await pool.query(`select count(*)::int n from pg_locks where locktype = 'advisory' and not granted`);
        if (rows[0].n > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await first.query('commit');
      expect(await second).toBe('plan_auto_limit');
    } finally {
      await first.query('rollback').catch(() => undefined);
      first.release();
    }
    expect(await countOf(USER_A)).toBe(3);
  });

  it('bridge deliveries and imports in parallel with one slot left: the total never passes the limit', async () => {
    expect(await importAs(USER_A, 1)).toBeNull();
    expect(await importAs(USER_A, 2)).toBeNull();
    const results = await Promise.all([bridge(10), importAs(USER_A, 11), bridge(12), importAs(USER_A, 13), bridge(14), importAs(USER_A, 15)]);
    expect(results.filter((r) => r === null || r === 'created')).toHaveLength(1);
    expect(results.filter((r) => r === 'plan_limit' || r === 'plan_auto_limit')).toHaveLength(5);
    expect(await countOf(USER_A)).toBe(3);
  });

  it('two banks in parallel with no bank automated yet: only one becomes the Free bank', async () => {
    await setLimit(50);
    const [a, b] = await Promise.all([importAs(USER_A, 1, 'BCP'), importAs(USER_A, 2, 'BBVA')]);
    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    expect([a, b].filter((r) => r === 'plan_institution_limit')).toHaveLength(1);
    // Same race across paths: BBVA import vs BCP bridge delivery for another person.
    const [imp, del] = await Promise.all([importAs(USER_B, 3, 'BBVA'), bridge(20, USER_B)]);
    expect([imp === null, del === 'created'].filter(Boolean)).toHaveLength(1);
    expect((await pool.query('select count(distinct institution_code)::int n from public.transactions where user_id = $1', [USER_B])).rows[0].n).toBe(1);
  });

  it('fails closed when the caller identity does not name the person (no claim, or another person\'s claim)', async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      expect(await errorCode(c, `select public.assert_auto_allowance($1, 'BCP')`, [USER_B])).toBe('42501');
      expect(await errorMessage(c, `select public.assert_auto_allowance($1, 'BCP')`, [USER_B])).toBe('allowance_identity_mismatch');
      await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [USER_A]);
      expect(await errorMessage(c, `select public.assert_auto_allowance($1, 'BCP')`, [USER_B])).toBe('allowance_identity_mismatch');
      expect(await errorMessage(c, `select public.assert_auto_allowance(null, 'BCP')`)).toBe('allowance_identity_mismatch');
      expect(await errorMessage(c, `select public.assert_auto_allowance($1, 'BCP')`, [USER_A])).toBeNull();
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('is VOLATILE, SECURITY DEFINER owned by app_writer, and not executable by clients', async () => {
    const { rows } = await pool.query(`select p.provolatile, p.prosecdef, pg_get_userbyid(p.proowner) as owner,
        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec, has_function_privilege('anon', p.oid, 'execute') as anon_exec
      from pg_proc p where p.oid = 'public.assert_auto_allowance(uuid, text)'::regprocedure`);
    expect(rows).toEqual([{ provolatile: 'v', prosecdef: true, owner: 'app_writer', auth_exec: false, anon_exec: false }]);
  });

  it('the bridge claim never outlives its transaction (pool of 1: success and plan-limit paths)', async () => {
    const one = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      const claim = async () => ((await one.query(`select current_setting('request.jwt.claim.sub', true) as v`)).rows[0].v ?? '') as string;
      await setLimit(1);
      const repo = new PgTransactionRepository(one);
      expect((await ingestRawEvent(bcpEmail(30), ctx(USER_A), repo, undefined, { requireVerifiedTemplate: true })).outcome).toBe('created');
      expect(await claim()).toBe('');
      expect((await ingestRawEvent(bcpEmail(31), ctx(USER_A), repo, undefined, { requireVerifiedTemplate: true })).outcome).toBe('plan_limit');
      expect(await claim()).toBe('');
    } finally {
      await one.end();
    }
  });
});
