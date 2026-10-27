import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

/**
 * Registration steps (migration 029): password step, 18+ by birth date, current Terms/Privacy versions, own rows only.
 * Migration 049: finish_registration replaces complete_registration (no longer executable). It returns a status
 * ('ok' | 'already_registered' | 'phone_taken' | 'too_many_attempts'), is final once completed, and caps phone_taken
 * answers (5 per account per 24 h).
 */
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
  /** What Supabase Auth does on updateUser({ password }): a new hash on auth.users (done here as the owner, in the same tx). */
  const setPassword = async (user: string, c: pg.PoolClient) => {
    await c.query('reset role');
    await c.query(`update auth.users set encrypted_password = 'hash-' || gen_random_uuid() where id = $1`, [user]);
    await c.query('set local role authenticated');
  };
  const status = async (c: pg.PoolClient) => (await c.query('select * from public.my_registration()')).rows[0];
  const complete = (birth: string, terms = '2026-10-08', privacy = '2026-10-08', phone = '+51987654321') =>
    `select public.finish_registration('Ana María', 'Pérez Soto', '${phone}', '${birth}', '${terms}', '${privacy}') as r`;
  const result = async (c: pg.PoolClient, sql: string) => (await c.query(sql)).rows[0].r as string;

  it('new account: required → password step → profile + consents → completed; display name from the first given name', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await status(c)).toMatchObject({ required: true, password_done: false, completed: false });
      expect(await errorCode(c, complete(await lima(c, 30)))).toBe('22023'); // password step first
      expect(await errorCode(c, 'select public.mark_password_set()')).toBe('42501'); // not executable: cannot be faked
      await setPassword(USER_A, c);
      expect(await status(c)).toMatchObject({ required: true, password_done: true });
      expect(await result(c, complete(await lima(c, 30)))).toBe('ok');
      expect(await status(c)).toMatchObject({ required: false, completed: true });
      const p = (await c.query('select given_names, family_names, display_name, phone_e164 from public.profiles')).rows[0];
      expect(p).toMatchObject({ given_names: 'Ana María', family_names: 'Pérez Soto', display_name: 'Ana', phone_e164: '+51987654321' });
      expect((await c.query('select kind, version from public.legal_acceptances order by kind')).rows)
        .toEqual([{ kind: 'privacy', version: '2026-10-08' }, { kind: 'terms', version: '2026-10-08' }]);
    });
  });

  it('18+: exactly 18 today passes; one day short is refused; future or malformed data refused', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await setPassword(USER_A, c);
      expect(await errorCode(c, complete(await lima(c, 18, 1)))).toBe('22023');
      expect(await errorCode(c, complete(await lima(c, 0, 1)))).toBe('22023');
      expect(await errorCode(c, complete(await lima(c, 30), '2020-01-01'))).toBe('22023'); // not the current version
      expect(await errorCode(c, complete(await lima(c, 30), '2026-10-08', '2026-10-08', '987654321'))).toBe('22023'); // not E.164
      expect(await errorCode(c, complete(await lima(c, 30), '2026-10-08', '2026-10-08', '+34612345678'))).toBe('22023'); // Peru only (036)
      expect(await errorCode(c, complete(await lima(c, 30), '2026-10-08', '2026-10-08', '+51187654321'))).toBe('22023'); // not a mobile
      expect((await c.query('select count(*)::int n from public.legal_acceptances')).rows[0].n).toBe(0);
      expect(await errorCode(c, complete(await lima(c, 18)))).toBeNull();
    });
  });

  /** Like asRole, but COMMITS (the uniqueness rule is about other people's committed rows). */
  const committed = async <T>(user: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
      const r = await fn(c);
      await c.query('commit');
      return r;
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  };

  it('one number per account (037): a number already used by another profile is refused; keeping your own is fine', async () => {
    await committed(USER_A, async (c) => { await setPassword(USER_A, c); await c.query(complete(await lima(c, 30))); });
    await committed(USER_B, async (c) => {
      await setPassword(USER_B, c);
      expect(await result(c, complete(await lima(c, 30)))).toBe('phone_taken'); // same +51987654321 as A (049: a status, not a raise)
      expect((await c.query('select count(*)::int n from public.legal_acceptances')).rows[0].n).toBe(0); // nothing half-saved
      expect(await result(c, complete(await lima(c, 30), '2026-10-08', '2026-10-08', '+51912345678'))).toBe('ok');
    });
    // A submits again after completion (double tap, back button): answered, nothing rewritten (049).
    await committed(USER_A, async (c) => { expect(await result(c, complete(await lima(c, 30)))).toBe('already_registered'); });
    // Any other write path (owner, bypassing the function) is refused too.
    expect(await pool.query(`update public.profiles set phone_e164 = '+51912345678' where user_id = $1`, [USER_A]).then(() => null, (e: { code: string }) => e.code)).toBe('23505');
    expect((await pool.query(`select count(*)::int n from public.profiles where phone_e164 = '+51912345678'`)).rows[0].n).toBe(1);
  });

  it('concurrent registrations with the same number: exactly one wins', async () => {
    const run = (user: string) => committed(user, async (c) => { await setPassword(user, c); return result(c, complete(await lima(c, 30), '2026-10-08', '2026-10-08', '+51955555555')); });
    const codes = await Promise.all([run(USER_A), run(USER_B)]);
    expect(codes.sort()).toEqual(['ok', 'phone_taken']);
    expect((await pool.query(`select count(*)::int n from public.profiles where phone_e164 = '+51955555555'`)).rows[0].n).toBe(1);
  });

  it('the client cannot mark steps itself, write consents, or see another person', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await setPassword(USER_A, c);
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
      expect(await result(c, complete(await lima(c, 40)))).toBe('ok');
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

  it('the password step is recorded only when the auth password really changes; legacy accounts are not required', async () => {
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect(await errorCode(c, `update auth.users set encrypted_password = 'x'`)).toBe('42501'); // the client cannot touch auth
      expect(await status(c)).toMatchObject({ password_done: false });
    });
    await pool.query(`update auth.users set email = 'b2@test.local' where id = $1`, [USER_B]); // other changes do not count
    await asRole(pool, 'authenticated', USER_B, async (c) => { expect(await status(c)).toMatchObject({ password_done: false }); });
    await pool.query(`update auth.users set encrypted_password = 'new-hash' where id = $1`, [USER_B]); // as Supabase Auth does
    await asRole(pool, 'authenticated', USER_B, async (c) => { expect(await status(c)).toMatchObject({ password_done: true }); });
    await asRole(pool, 'authenticated', '00000000-0000-4000-8000-0000000000cc', async (c) => {
      expect(await status(c)).toMatchObject({ required: false, completed: false });
    });
  });
  // ── 049: final once completed; phone_taken is capped (no enumeration of +51 numbers) ───────────────────────
  const USER_C = '00000000-0000-4000-8000-00000000000c';
  const TAKEN = '+51987654321';
  const refusals = async (user: string) =>
    (await pool.query('select refusals from public.registration_phone_refusals where user_id = $1', [user])).rows[0]?.refusals ?? 0;
  const profile = async (user: string) =>
    (await pool.query('select phone_e164, birth_date::text b, registration_completed_at from public.profiles where user_id = $1', [user])).rows[0];
  const owner = async () => committed(USER_A, async (c) => { await setPassword(USER_A, c); expect(await result(c, complete(await lima(c, 30)))).toBe('ok'); });

  it('after completion a re-call is refused and rewrites nothing (phone, birth date, completion time)', async () => {
    await owner();
    const before = await profile(USER_A);
    await committed(USER_A, async (c) => {
      expect(await result(c, complete(await lima(c, 50), '2026-10-08', '2026-10-08', '+51911111111'))).toBe('already_registered');
    });
    expect(await profile(USER_A)).toEqual(before);
    expect(before.phone_e164).toBe(TAKEN);
    // A ready account cannot probe numbers either: the answer never depends on the number.
    await committed(USER_A, async (c) => {
      expect(await result(c, complete(await lima(c, 30), '2026-10-08', '2026-10-08', '+51922222222'))).toBe('already_registered');
    });
    expect(await refusals(USER_A)).toBe(0);
  });

  it('5 phone_taken answers per account in 24 h; the 6th call is refused even with a free number; others unaffected', async () => {
    await owner();
    await pool.query(`insert into auth.users (id, email, encrypted_password) values ($1, 'c@test.local', 'hash')`, [USER_C]);
    await committed(USER_B, async (c) => { await setPassword(USER_B, c); });
    for (let i = 1; i <= 5; i++) {
      await committed(USER_B, async (c) => { expect(await result(c, complete(await lima(c, 30)))).toBe('phone_taken'); });
      expect(await refusals(USER_B)).toBe(i); // kept although the registration itself rolled back
    }
    await committed(USER_B, async (c) => {
      expect(await result(c, complete(await lima(c, 30), '2026-10-08', '2026-10-08', '+51933333333'))).toBe('too_many_attempts');
    });
    expect(await profile(USER_B)).toMatchObject({ phone_e164: null, registration_completed_at: null });
    expect((await pool.query('select count(*)::int n from public.legal_acceptances where user_id = $1', [USER_B])).rows[0].n).toBe(0);
    // Another new account is not affected by B's counter.
    await committed(USER_C, async (c) => {
      await setPassword(USER_C, c);
      expect(await result(c, complete(await lima(c, 30)))).toBe('phone_taken');
      expect(await result(c, complete(await lima(c, 30), '2026-10-08', '2026-10-08', '+51944444444'))).toBe('ok');
    });
    expect(await refusals(USER_C)).toBe(1);
    // After the 24 h window, B can finish with a free number.
    await pool.query(`update public.registration_phone_refusals set window_start = now() - interval '25 hours' where user_id = $1`, [USER_B]);
    await committed(USER_B, async (c) => {
      expect(await result(c, complete(await lima(c, 30), '2026-10-08', '2026-10-08', '+51933333333'))).toBe('ok');
    });
  });

  it('parallel calls of one account cannot outrun the cap (row lock): at most 5 phone_taken answers', async () => {
    await owner();
    await committed(USER_B, async (c) => { await setPassword(USER_B, c); });
    const answers = await Promise.all(Array.from({ length: 8 }, () =>
      committed(USER_B, async (c) => result(c, complete(await lima(c, 30))))));
    expect(answers.filter((a) => a === 'phone_taken')).toHaveLength(5);
    expect(answers.filter((a) => a === 'too_many_attempts')).toHaveLength(3);
    expect(await refusals(USER_B)).toBe(5);
  });

  it('the refusal counter is private: no client role can read or write it; RLS on', async () => {
    expect((await pool.query(`select relrowsecurity from pg_class where oid = 'public.registration_phone_refusals'::regclass`)).rows[0].relrowsecurity).toBe(true);
    for (const role of ['anon', 'authenticated'] as const) {
      await asRole(pool, role, role === 'anon' ? null : USER_A, async (c) => {
        expect(await errorCode(c, 'select * from public.registration_phone_refusals')).toBe('42501');
        expect(await errorCode(c, `insert into public.registration_phone_refusals (user_id, refusals) values ($1, 0)`, [USER_A])).toBe('42501');
        expect(await errorCode(c, `update public.registration_phone_refusals set refusals = 0`)).toBe('42501');
        expect(await errorCode(c, `delete from public.registration_phone_refusals`)).toBe('42501');
      });
    }
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, complete('1990-01-01'))).toBe('42501'); // anon cannot call the function at all
    });
  });

  it('the old complete_registration (void, unlimited) is kept but executable by no client role', async () => {
    const old = `select public.complete_registration('Ana María', 'Pérez Soto', '+51987654321', '1990-01-01', '2026-10-08', '2026-10-08')`;
    for (const role of ['anon', 'authenticated'] as const) {
      expect((await pool.query(`select has_function_privilege($1, 'public.complete_registration(text, text, text, date, text, text)', 'EXECUTE') ok`, [role])).rows[0].ok).toBe(false);
      await asRole(pool, role, role === 'anon' ? null : USER_A, async (c) => { expect(await errorCode(c, old)).toBe('42501'); });
    }
  });

  it('documented rollback without a deploy (docs/security/rls.md) brings back the old path; rolled back here', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query('reset role');
      await c.query(`grant execute on function public.complete_registration(text, text, text, date, text, text) to authenticated;
        drop function public.finish_registration(text, text, text, date, text, text); notify pgrst, 'reload schema';`);
      await setPassword(USER_A, c);
      expect(await errorCode(c, complete(await lima(c, 30)))).toBe('42883'); // gone: PostgREST answers PGRST202 → app fallback
      await c.query(`select public.complete_registration('Ana María', 'Pérez Soto', '+51987654321', $1, '2026-10-08', '2026-10-08')`, [await lima(c, 30)]);
      expect(await status(c)).toMatchObject({ required: false, completed: true });
    });
    expect((await pool.query(`select to_regprocedure('public.finish_registration(text, text, text, date, text, text)') is not null ok`)).rows[0].ok).toBe(true);
  });
});
