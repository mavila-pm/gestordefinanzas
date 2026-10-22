import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

/**
 * Apartados (named reserves, ADR-0017, migration 053): own rows only, entries append-only, never more out than saved,
 * archived ⇒ empty, a linked movement is confirmed/outgoing/same currency and links one entry, PEN ≠ USD.
 * Concurrency is tested with committed transactions on separate connections (like simultaneous requests).
 */
describe.skipIf(!DATABASE_URL)('reserves (Apartados)', () => {
  let pool: pg.Pool;
  const reserve = async (user: string, name = 'Viaje', currency = 'PEN') => (await pool.query(`insert into public.reserves (user_id, name, currency, target_minor, target_date)
    values ($1, $2, $3, 120000, '2026-12-20') returning id`, [user, name, currency])).rows[0].id as string;
  const entry = (user: string, r: string, direction: 'in' | 'out', amount: number) =>
    pool.query(`insert into public.reserve_entries (user_id, reserve_id, direction, amount_minor) values ($1, $2, $3, $4)`, [user, r, direction, amount]);
  const tx = async (user: string, o: { currency?: string; status?: string; type?: string; direction?: string } = {}) => (await pool.query(`insert into public.transactions
    (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, status, confidence, fingerprint)
    values ($1, now(), $2, $3, 40000, $4, 'LATAM', $5, 'high', 'fp') returning id`,
  [user, o.type ?? 'expense', o.direction ?? 'outflow', o.currency ?? 'PEN', o.status ?? 'confirmed'])).rows[0].id as string;
  const ins = `insert into public.reserve_entries (user_id, reserve_id, direction, amount_minor, transaction_id) values ($1, $2, $3, $4, $5)`;
  const saved = async (r: string) => Number((await pool.query('select saved_minor from public.reserve_balances where reserve_id = $1', [r])).rows[0].saved_minor);

  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('the person creates an apartado and moves money in and out; saved = Σ in − Σ out (never typed)', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const r = (await c.query(`insert into public.reserves (user_id, name, currency, target_minor, target_date) values ($1, 'Viaje', 'PEN', 120000, '2026-12-20') returning id`, [USER_A])).rows[0].id;
      await c.query(ins, [USER_A, r, 'in', 30000, null]);
      await c.query(ins, [USER_A, r, 'in', 20000, null]);
      await c.query(ins, [USER_A, r, 'out', 10000, null]);
      expect((await c.query('select saved_minor, currency from public.reserve_balances where reserve_id = $1', [r])).rows).toEqual([{ saved_minor: '40000', currency: 'PEN' }]);
      // A reserve without entries reads 0 (nothing saved yet), never null.
      const empty = (await c.query(`insert into public.reserves (user_id, name, currency) values ($1, 'Fondo', 'PEN') returning id`, [USER_A])).rows[0].id;
      expect((await c.query('select saved_minor from public.reserve_balances where reserve_id = $1', [empty])).rows).toEqual([{ saved_minor: '0' }]);
    });
  });

  it('never more out than saved; an exact withdrawal empties it', async () => {
    const r = await reserve(USER_A);
    await entry(USER_A, r, 'in', 10000);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, ins, [USER_A, r, 'out', 10001, null])).toBe('23514');
      expect(await errorCode(c, ins, [USER_A, r, 'out', 10000, null])).toBeNull();
      expect(await errorCode(c, ins, [USER_A, r, 'out', 1, null])).toBe('23514');
    });
  });

  it('5 simultaneous "Usar S/ 60" on S/ 100 saved: exactly one goes through', async () => {
    const r = await reserve(USER_A);
    await entry(USER_A, r, 'in', 10000);
    const attempt = async () => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role authenticated');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER_A, role: 'authenticated' })]);
        await c.query(ins, [USER_A, r, 'out', 6000, null]);
        await new Promise((res) => setTimeout(res, 20));
        await c.query('commit');
        return 'ok';
      } catch (e) {
        await c.query('rollback').catch(() => undefined);
        return (e as { code?: string }).code ?? 'unknown';
      } finally { c.release(); }
    };
    const out = await Promise.all(Array.from({ length: 5 }, attempt));
    expect(out.filter((x) => x === 'ok')).toHaveLength(1);
    expect(out.filter((x) => x !== 'ok').every((x) => x === '23514')).toBe(true);
    expect(await saved(r)).toBe(4000);
  });

  it('a linked movement is confirmed, outgoing, not an income, same currency, and links one entry only', async () => {
    const r = await reserve(USER_A);
    await entry(USER_A, r, 'in', 100000);
    const [usd, pending, income, ok] = [await tx(USER_A, { currency: 'USD' }), await tx(USER_A, { status: 'review_required' }),
      await tx(USER_A, { type: 'income', direction: 'inflow' }), await tx(USER_A)];
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, ins, [USER_A, r, 'out', 40000, usd])).toBe('23514');
      expect(await errorCode(c, ins, [USER_A, r, 'out', 40000, pending])).toBe('23514');
      expect(await errorCode(c, ins, [USER_A, r, 'out', 40000, income])).toBe('23514');
      expect(await errorCode(c, ins, [USER_A, r, 'in', 40000, ok])).toBe('23514'); // putting money in is never a movement
      expect(await errorCode(c, ins, [USER_A, r, 'out', 40000, ok])).toBeNull();
      expect(await errorCode(c, ins, [USER_A, r, 'out', 10000, ok])).toBe('23505');
    });
    // Deleting the movement keeps the entry (the money was used), only the link goes. (asRole rolls back: commit one here.)
    await pool.query(ins, [USER_A, r, 'out', 40000, ok]);
    await pool.query('delete from public.transactions where id = $1', [ok]);
    expect((await pool.query('select transaction_id, amount_minor from public.reserve_entries where direction = $1', ['out'])).rows).toEqual([{ transaction_id: null, amount_minor: '40000' }]);
  });

  it('entries are append-only; currency and owner of an apartado never change; nothing is deleted by the client', async () => {
    const r = await reserve(USER_A);
    await entry(USER_A, r, 'in', 10000);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, 'update public.reserve_entries set amount_minor = 99999')).toBe('42501');
      expect(await errorCode(c, 'delete from public.reserve_entries')).toBe('42501');
      expect(await errorCode(c, `update public.reserves set currency = 'USD' where id = $1`, [r])).toBe('42501');
      expect(await errorCode(c, 'update public.reserves set user_id = $1 where id = $2', [USER_B, r])).toBe('42501');
      expect(await errorCode(c, 'delete from public.reserves')).toBe('42501');
      expect(await errorCode(c, `update public.reserves set name = 'Viaje a Cusco', target_minor = 150000 where id = $1`, [r])).toBeNull();
    });
  });

  it('an apartado with money is not archived; an archived one takes no entries', async () => {
    const r = await reserve(USER_A);
    await entry(USER_A, r, 'in', 10000);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, 'update public.reserves set active = false where id = $1', [r])).toBe('23514');
      await c.query(ins, [USER_A, r, 'out', 10000, null]);
      expect(await errorCode(c, 'update public.reserves set active = false where id = $1', [r])).toBeNull();
      expect(await errorCode(c, ins, [USER_A, r, 'in', 100, null])).toBe('23514');
      // The name is free again once archived.
      expect(await errorCode(c, `insert into public.reserves (user_id, name, currency) values ($1, 'Viaje', 'PEN')`, [USER_A])).toBeNull();
    });
  });

  it('constraints: name 1-40, date needs a target, amounts 1..1e11, direction in/out, one active name per currency', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const mk = `insert into public.reserves (user_id, name, currency, target_minor, target_date) values ($1, $2, $3, $4, $5)`;
      expect(await errorCode(c, mk, [USER_A, '   ', 'PEN', null, null])).toBe('23514');
      expect(await errorCode(c, mk, [USER_A, 'x'.repeat(41), 'PEN', null, null])).toBe('23514');
      expect(await errorCode(c, mk, [USER_A, 'Viaje', 'PEN', null, '2026-12-20'])).toBe('23514');
      expect(await errorCode(c, mk, [USER_A, 'Viaje', 'PEN', 0, null])).toBe('23514');
      expect(await errorCode(c, mk, [USER_A, 'Viaje', 'EUR', null, null])).toBe('22P02');
      expect(await errorCode(c, mk, [USER_A, 'Viaje', 'PEN', 120000, '2026-12-20'])).toBeNull();
      expect(await errorCode(c, mk, [USER_A, ' viaje ', 'PEN', null, null])).toBe('23505');
      expect(await errorCode(c, mk, [USER_A, 'Viaje', 'USD', null, null])).toBeNull(); // PEN and USD apartados stay apart
      const r = (await c.query(`select id from public.reserves where currency = 'PEN'`)).rows[0].id;
      expect(await errorCode(c, ins, [USER_A, r, 'in', 0, null])).toBe('23514');
      expect(await errorCode(c, ins, [USER_A, r, 'in', 100000000001, null])).toBe('23514');
      expect(await errorCode(c, ins, [USER_A, r, 'sideways', 100, null])).toBe('23514');
      expect(await errorCode(c, `insert into public.reserve_entries (user_id, reserve_id, direction, amount_minor, note) values ($1, $2, 'in', 100, $3)`, [USER_A, r, 'n'.repeat(81)])).toBe('23514');
    });
  });

  it('a replayed submission (same client_ref) is stored once', async () => {
    const r = await reserve(USER_A);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const q = `insert into public.reserve_entries (user_id, reserve_id, direction, amount_minor, client_ref) values ($1, $2, 'in', 30000, 'ref-apartar-0001')`;
      expect(await errorCode(c, q, [USER_A, r])).toBeNull();
      expect(await errorCode(c, q, [USER_A, r])).toBe('23505');
      const mk = `insert into public.reserves (user_id, name, currency, client_ref) values ($1, $2, 'PEN', 'ref-reserve-0001')`;
      expect(await errorCode(c, mk, [USER_A, 'Casa'])).toBeNull();
      expect(await errorCode(c, mk, [USER_A, 'Casa 2'])).toBe('23505');
      expect((await c.query('select count(*)::int as n from public.reserve_entries')).rows[0].n).toBe(1);
    });
  });

  it('A/B: B reads nothing of A, cannot add to A\'s apartado nor link A\'s movement; anon has nothing', async () => {
    const aR = await reserve(USER_A);
    await entry(USER_A, aR, 'in', 50000);
    const aTx = await tx(USER_A);
    const bR = await reserve(USER_B);
    await entry(USER_B, bR, 'in', 50000);
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect((await c.query('select count(*)::int as n from public.reserves')).rows[0].n).toBe(1);
      expect((await c.query('select count(*)::int as n from public.reserve_entries')).rows[0].n).toBe(1);
      expect((await c.query('select reserve_id from public.reserve_balances')).rows).toEqual([{ reserve_id: bR }]);
      expect(await errorCode(c, ins, [USER_B, aR, 'in', 100, null])).toBe('23503');
      expect(await errorCode(c, ins, [USER_A, aR, 'in', 100, null])).toBe('42501');
      expect(await errorCode(c, ins, [USER_B, bR, 'out', 100, aTx])).toBe('23503');
      expect((await c.query(`update public.reserves set active = false where id = $1 returning id`, [aR])).rowCount).toBe(0);
    });
    await asRole(pool, 'anon', null, async (c) => {
      for (const t of ['reserves', 'reserve_entries', 'reserve_balances']) expect(await errorCode(c, `select * from public.${t}`)).toBe('42501');
      expect(await errorCode(c, ins, [USER_A, aR, 'in', 100, null])).toBe('42501');
    });
    expect(await saved(aR)).toBe(50000);
  });
});
