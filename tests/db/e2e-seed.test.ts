import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { DATABASE_URL, makePool } from './helpers';

/**
 * The E2E harness against a throwaway Postgres: tests/e2e/seed.sql is insert-only under a run id, so it can run again,
 * and after an incomplete cleanup; tests/e2e/cleanup.sql removes only the synthetic namespace and refuses otherwise.
 */
describe.skipIf(!DATABASE_URL)('E2E seed / cleanup harness', () => {
  let pool: pg.Pool;
  const seed = (run: string) => readFileSync('tests/e2e/seed.sql', 'utf8').replaceAll('__E2E_PASSWORD__', 'pw-test-only').replaceAll('__E2E_RUN__', run);
  const cleanup = readFileSync('tests/e2e/cleanup.sql', 'utf8');
  const probes = async () => (await pool.query(`select count(*)::int n from auth.users where email like 'e2e-%@gestordefinanzas.invalid'`)).rows[0].n as number;
  const code = async (sql: string) => { try { await pool.query(sql); return null; } catch (e) { return (e as Error).message; } };

  beforeAll(async () => {
    pool = makePool();
    // The local shim has a minimal auth schema: add what the seed writes (as on the real project).
    await pool.query(`
      create schema if not exists extensions;
      -- pgcrypto lives in public here (migration 000001); Supabase exposes it under extensions.
      create or replace function extensions.gen_salt(text) returns text language sql as 'select public.gen_salt($1)';
      create or replace function extensions.crypt(text, text) returns text language sql as 'select public.crypt($1, $2)';
      alter table auth.users add column if not exists instance_id uuid, add column if not exists aud text, add column if not exists role text,
        add column if not exists encrypted_password text, add column if not exists email_confirmed_at timestamptz,
        add column if not exists raw_app_meta_data jsonb, add column if not exists raw_user_meta_data jsonb,
        add column if not exists created_at timestamptz, add column if not exists updated_at timestamptz,
        add column if not exists confirmation_token text, add column if not exists recovery_token text, add column if not exists email_change_token_new text,
        add column if not exists email_change text, add column if not exists email_change_token_current text, add column if not exists phone_change text,
        add column if not exists phone_change_token text, add column if not exists reauthentication_token text;
      create table if not exists auth.identities (provider_id text, user_id uuid references auth.users (id) on delete cascade, identity_data jsonb,
        provider text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz);`);
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000aa', 'real.person@gmail.com')`);
  });
  afterAll(async () => { await pool?.end(); });

  it('seed → seed again (new run) → passes, never colliding; leftovers of an incomplete cleanup do not block it', async () => {
    expect(await code(seed('run0000aaaa'))).toBeNull();
    expect(await code(seed('run0000bbbb'))).toBeNull();
    expect(await probes()).toBe(48);
    // Incomplete cleanup: only some users of the first run went away.
    await pool.query(`delete from auth.users where email like 'e2e-s4%-run0000aaaa@gestordefinanzas.invalid'`);
    expect(await code(seed('run0000cccc'))).toBeNull();
    expect(await probes()).toBe(70); // 48 − s4a/s4b of run aaaa + 24 new
    // Fixed ids are per run: two runs of the same B row coexist.
    expect((await pool.query(`select count(*)::int n from public.transactions where id in (md5('run0000bbbb:e4b1')::uuid, md5('run0000cccc:e4b1')::uuid)`)).rows[0].n).toBe(2);
  });

  it('the seed refuses a run id outside the synthetic format (nothing written)', async () => {
    const before = await probes();
    expect(await code(seed("x'; drop table auth.users; --"))).not.toBeNull();
    expect(await code(seed('UPPER-run'))).toMatch(/invalid run id/);
    expect(await probes()).toBe(before);
  });

  it('cleanup refuses when the prefix matches something outside the exact pattern, and deletes nothing', async () => {
    await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'e2e-someone@gestordefinanzas.invalid')`);
    const before = await probes();
    expect(await code(cleanup)).toMatch(/not the synthetic pattern; nothing deleted/);
    expect(await probes()).toBe(before);
    await pool.query(`delete from auth.users where email = 'e2e-someone@gestordefinanzas.invalid'`);
  });

  it('cleanup removes every synthetic user (all runs) and their rows; real users untouched; cleanup twice is fine', async () => {
    const res = (await pool.query(cleanup)) as unknown as pg.QueryResult[];
    expect(res.at(-1)!.rows[0]).toMatchObject({ probe_users: '0', orphan_rows: '0' });
    expect((await pool.query(`select count(*)::int n from auth.users where email = 'real.person@gmail.com'`)).rows[0].n).toBe(1);
    expect((await pool.query(`select count(*)::int n from public.transactions`)).rows[0].n).toBe(0);
    const again = (await pool.query(cleanup)) as unknown as pg.QueryResult[];
    expect(again.at(-1)!.rows[0]).toMatchObject({ probe_users: '0' });
    expect(await code(seed('run0000dddd'))).toBeNull();
  });
});
