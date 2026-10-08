import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

/** Registration steps (migration 029): password step, 18+ by birth date, current Terms/Privacy versions, own rows only. */
describe.skipIf(!DATABASE_URL)('registration', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    // A: new account with a password; B: another new account. LEGACY: created before the cutoff.
    await pool.query(`insert into auth.users (id, email, encrypted_password) values ($1, 'a@test.local', 'hash'), ($2, 'b@test.local', 'hash'),
      ('00000000-0000-4000-8000-0000000000cc', 'legacy@test.local', 'hash')`, [USER_A, USER_B]);
    await pool.query(`update auth.users set created_at = '2026-10-01' where email = 'legacy@test.local'`);
  });

  const lima = async (c: pg.PoolClient, years: number, days = 0) =>
    (await c.query(`select ((now() at time zone 'America/Lima')::date - make_interval(years => $1) + make_interval(days => $2))::date::text d`, [years, days])).rows[0].d as string;
  const status = async (c: pg.PoolClient) => (await c.query('select * from public.my_registration()')).rows[0];
  const complete = (birth: string, terms = '2026-10-08', privacy = '2026-10-08', phone = '+51987654321') =>
    `select public.complete_registration('Ana María', 'Pérez Soto', '${phone}', '${birth}', '${terms}', '${privacy}')`;

  it('new account: required → password step → profile + consents → completed; display name from the first given name', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await status(c)).toMatchObject({ required: true, password_done: false, completed: false });
      expect(await errorCode(c, complete(await lima(c, 30)))).toBe('22023'); // password step first
      await c.query('select public.mark_password_set()');
      expect(await status(c)).toMatchObject({ required: true, password_done: true });
      await c.query(complete(await lima(c, 30)));
      expect(await status(c)).toMatchObject({ required: false, completed: true });
      const p = (await c.query('select given_names, family_names, display_name, phone_e164 from public.profiles')).rows[0];
      expect(p).toMatchObject({ given_names: 'Ana María', family_names: 'Pérez Soto', display_name: 'Ana', phone_e164: '+51987654321' });
      expect((await c.query('select kind, version from public.legal_acceptances order by kind')).rows)
        .toEqual([{ kind: 'privacy', version: '2026-10-08' }, { kind: 'terms', version: '2026-10-08' }]);
    });
  });

  it('18+: exactly 18 today passes; one day short is refused; future or malformed data refused', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query('select public.mark_password_set()');
      expect(await errorCode(c, complete(await lima(c, 18, 1)))).toBe('22023');
      expect(await errorCode(c, complete(await lima(c, 0, 1)))).toBe('22023');
      expect(await errorCode(c, complete(await lima(c, 30), '2020-01-01'))).toBe('22023'); // not the current version
      expect(await errorCode(c, complete(await lima(c, 30), '2026-10-08', '2026-10-08', '987654321'))).toBe('22023'); // not E.164
      expect((await c.query('select count(*)::int n from public.legal_acceptances')).rows[0].n).toBe(0);
      expect(await errorCode(c, complete(await lima(c, 18)))).toBeNull();
    });
  });

  it('the client cannot mark steps itself, write consents, or see another person', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query('select public.mark_password_set()');
      expect(await errorCode(c, `update public.profiles set registration_completed_at = now()`)).toBe('42501');
      expect(await errorCode(c, `update public.profiles set birth_date = '2015-01-01'`)).toBe('42501');
      expect(await errorCode(c, `insert into public.legal_acceptances (user_id, kind, version) values ($1, 'terms', '2026-10-08')`, [USER_A])).toBe('42501');
      expect(await errorCode(c, `update public.profiles set display_name = 'Ana'`)).toBeNull(); // names stay editable (Ajustes)
      // Ajustes saves with an upsert (PostgREST ON CONFLICT DO UPDATE sets user_id too): must keep working.
      expect(await errorCode(c, `insert into public.profiles (user_id, given_names, display_name) values ($1, 'Ana', 'Ana')
        on conflict (user_id) do update set user_id = excluded.user_id, given_names = excluded.given_names, display_name = excluded.display_name`, [USER_A])).toBeNull();
      expect(await errorCode(c, `insert into public.profiles (user_id, birth_date) values ($1, '2015-01-01')
        on conflict (user_id) do update set birth_date = excluded.birth_date`, [USER_A])).toBe('42501');
      // Another person's id is refused by RLS even with the user_id grant.
      expect(await errorCode(c, `update public.profiles set user_id = $1`, [USER_B])).not.toBeNull();
      await c.query(complete(await lima(c, 40)));
    });
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect((await c.query('select count(*)::int n from public.legal_acceptances')).rows[0].n).toBe(0);
      expect((await c.query('select count(*)::int n from public.profiles')).rows[0].n).toBe(0);
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, 'select * from public.my_registration()')).toBe('42501');
      expect(await errorCode(c, 'select 1 from public.legal_documents')).toBe('42501');
    });
  });

  it('password step refuses an account without a password; legacy accounts are not required to register', async () => {
    await pool.query(`update auth.users set encrypted_password = '' where id = $1`, [USER_B]);
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect(await errorCode(c, 'select public.mark_password_set()')).toBe('22023');
    });
    await asRole(pool, 'authenticated', '00000000-0000-4000-8000-0000000000cc', async (c) => {
      expect(await status(c)).toMatchObject({ required: false, completed: false });
    });
  });
});
