import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

const SPLIT = 'select public.set_transaction_split($1, $2::jsonb, $3) as n';

describe.skipIf(!DATABASE_URL)('TASK-020: split a movement across categories (allocations)', () => {
  let pool: pg.Pool;
  let cat: Record<string, string> = {};
  const tx = async (user: string, o: { type?: string; status?: string; amount?: number; currency?: string } = {}) =>
    (await pool.query(`insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw,
      category_id, status, confidence, fingerprint) values ($1, '2026-09-10 12:00-05', $2, public.direction_for($2), $3, $4, 'RESTAURANTE', $5, $6, 'high', 'fp')
      returning id, updated_at::text`, [user, o.type ?? 'expense',
      o.amount ?? 18000, o.currency ?? 'PEN', cat['Alimentación'], o.status ?? 'confirmed'])).rows[0] as { id: string; updated_at: string };
  const parts = (...p: Array<[string, number, string?]>) => JSON.stringify(p.map(([c, a, note]) => ({ category_id: cat[c], amount_minor: a, ...(note ? { note } : {}) })));
  const alloc = async (c: pg.PoolClient, id: string) => (await c.query(
    `select c.name, a.amount_minor::int as amount, a.note from public.transaction_allocations a join public.categories c on c.id = a.category_id
     where a.transaction_id = $1 order by a.position`, [id])).rows;

  beforeAll(async () => {
    pool = makePool();
    cat = Object.fromEntries((await pool.query('select name, id from public.categories where user_id is null')).rows.map((r) => [r.name, r.id]));
  });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('80 + 60 + 40 = 180: stored as allocations, movement amount untouched, audited', async () => {
    const t = await tx(USER_A);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query(SPLIT, [t.id, parts(['Alimentación', 8000], ['Ocio', 6000, 'Amigos'], ['Personal', 4000, 'Trabajo']), t.updated_at])).rows[0].n).toBe(3);
      expect(await alloc(c, t.id)).toEqual([
        { name: 'Alimentación', amount: 8000, note: null }, { name: 'Ocio', amount: 6000, note: 'Amigos' }, { name: 'Personal', amount: 4000, note: 'Trabajo' }]);
      const row = (await c.query('select amount_minor::int as a, currency, type, status from public.transactions where id = $1', [t.id])).rows[0];
      expect(row).toEqual({ a: 18000, currency: 'PEN', type: 'expense', status: 'confirmed' });
      const audit = (await c.query(`select changes from public.audit_events where transaction_id = $1 and action = 'split'`, [t.id])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].changes.allocations.from).toEqual([]);
      expect(audit[0].changes.allocations.to).toHaveLength(3);
    });
  });

  it('partial split keeps the remainder in the movement category; over-allocation and bad input are refused', async () => {
    const t = await tx(USER_A);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query(SPLIT, [t.id, parts(['Ocio', 6000]), null])).rows[0].n).toBe(1);
      expect(await errorMessage(c, SPLIT, [t.id, parts(['Ocio', 10000], ['Personal', 9000]), null])).toBe('over_allocated');
      expect(await alloc(c, t.id)).toEqual([{ name: 'Ocio', amount: 6000, note: null }]); // failed call changed nothing
      expect(await errorMessage(c, SPLIT, [t.id, parts(['Ocio', 0]), null])).toBe('invalid_amount');
      expect(await errorMessage(c, SPLIT, [t.id, JSON.stringify([{ category_id: cat['Ocio'], amount_minor: 12.5 }]), null])).toBe('invalid_amount');
      expect(await errorMessage(c, SPLIT, [t.id, JSON.stringify([{ category_id: cat['Ocio'], amount_minor: '100' }]), null])).toBe('invalid_amount');
      expect(await errorMessage(c, SPLIT, [t.id, JSON.stringify([{ category_id: cat['Ocio'], amount_minor: 100, currency: 'USD' }]), null])).toBe('currency_mismatch');
      expect(await errorMessage(c, SPLIT, [t.id, JSON.stringify([{ category_id: '00000000-0000-4000-8000-000000000999', amount_minor: 100 }]), null])).toBe('invalid_category');
      expect(await errorMessage(c, SPLIT, [t.id, JSON.stringify([{ category_id: cat['Ocio'], amount_minor: 100, user_id: USER_B }]), null])).toBe('invalid_request');
      expect(await errorMessage(c, SPLIT, [t.id, parts(['Ocio', 100, 'x'.repeat(41)]), null])).toBe('note_too_long');
    });
  });

  it('only confirmed spending can be divided (refund, withdrawal, card payment, transfer, income, pending are excluded)', async () => {
    for (const type of ['refund', 'withdrawal', 'credit_card_payment', 'internal_transfer', 'income']) {
      const t = await tx(USER_A, { type });
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        expect(await errorMessage(c, SPLIT, [t.id, parts(['Ocio', 100]), null])).toBe('not_splittable');
      });
    }
    const pending = await tx(USER_A, { status: 'review_required' });
    const card = await tx(USER_A, { type: 'credit_card_purchase' });
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, SPLIT, [pending.id, parts(['Ocio', 100]), null])).toBe('not_splittable');
      expect((await c.query(SPLIT, [card.id, parts(['Ocio', 100]), null])).rows[0].n).toBe(1);
    });
  });

  it('edit replaces atomically; empty list removes the division; concurrent edit with an old version is refused', async () => {
    const t = await tx(USER_A);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(SPLIT, [t.id, parts(['Ocio', 6000], ['Personal', 4000]), t.updated_at]);
      // The first save bumped the version: an editor still holding the old one must reload.
      expect(await errorMessage(c, SPLIT, [t.id, parts(['Ocio', 1000]), t.updated_at])).toBe('stale');
      const v = (await c.query('select updated_at::text as v from public.transactions where id = $1', [t.id])).rows[0].v;
      await c.query(SPLIT, [t.id, parts(['Salud', 5000]), v]);
      expect(await alloc(c, t.id)).toEqual([{ name: 'Salud', amount: 5000, note: null }]);
      expect((await c.query(SPLIT, [t.id, '[]', null])).rows[0].n).toBe(0);
      expect(await alloc(c, t.id)).toEqual([]);
    });
  });

  it('no path can break the invariant: amount below allocated, currency/type/status changes are refused while split', async () => {
    const t = await tx(USER_A);
    await commitAs(pool, USER_A, SPLIT, [t.id, parts(['Ocio', 6000], ['Personal', 4000]), null]);
    expect(await errorMessageOnPool(pool, 'update public.transactions set amount_minor = 9000 where id = $1', [t.id])).toBe('split_exceeds_amount');
    expect(await errorMessageOnPool(pool, "update public.transactions set currency = 'USD' where id = $1", [t.id])).toBe('split_exists');
    expect(await errorMessageOnPool(pool, "update public.transactions set status = 'ignored' where id = $1", [t.id])).toBe('split_exists');
    expect(await errorMessageOnPool(pool, "update public.transactions set type = 'withdrawal', direction = 'outflow' where id = $1", [t.id])).toBe('split_exists');
    await pool.query('update public.transactions set amount_minor = 10000 where id = $1', [t.id]); // still >= allocated: allowed
    // The secure correction path hits the same guard.
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, 'select public.correct_transaction($1, $2::jsonb, false, false)', [t.id, JSON.stringify({ amount_minor: 5000 })])).toBe('split_exceeds_amount');
    });
    // Deleting the movement removes its allocations (no orphan money).
    await pool.query('delete from public.transactions where id = $1', [t.id]);
    expect((await pool.query('select count(*)::int as n from public.transaction_allocations where transaction_id = $1', [t.id])).rows[0].n).toBe(0);
  });

  it('A/B: B cannot read, split or change A\'s division; A cannot use B\'s categories; clients cannot write directly', async () => {
    const a = await tx(USER_A);
    const bCat = (await pool.query(`insert into public.categories (user_id, name) values ($1, 'Secreta B') returning id`, [USER_B])).rows[0].id;
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(SPLIT, [a.id, parts(['Ocio', 6000]), null]);
      expect(await errorMessage(c, SPLIT, [a.id, JSON.stringify([{ category_id: bCat, amount_minor: 100 }]), null])).toBe('invalid_category');
      expect(await errorCode(c, `insert into public.transaction_allocations (user_id, transaction_id, category_id, amount_minor, position) values ($1, $2, $3, 1, 5)`, [USER_A, a.id, cat['Ocio']])).toBe('42501');
      expect(await errorCode(c, 'delete from public.transaction_allocations where transaction_id = $1', [a.id])).toBe('42501');
    });
    await commitAs(pool, USER_A, SPLIT, [a.id, parts(['Ocio', 6000]), null]);
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect((await c.query('select count(*)::int as n from public.transaction_allocations')).rows[0].n).toBe(0);
      expect(await errorMessage(c, SPLIT, [a.id, parts(['Ocio', 100]), null])).toBe('not_found');
      expect(await errorMessage(c, SPLIT, [a.id, '[]', null])).toBe('not_found');
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, SPLIT, [a.id, '[]', null])).toBe('42501');
      expect(await errorCode(c, 'select * from public.transaction_allocations', [])).toBe('42501');
    });
  });
});

async function errorMessageOnPool(pool: pg.Pool, sql: string, params: unknown[]): Promise<string | null> {
  try { await pool.query(sql, params); return null; } catch (e) { return (e as Error).message; }
}

/** Runs one statement as an authenticated user and COMMITS it (asRole always rolls back). */
async function commitAs(pool: pg.Pool, user: string, sql: string, params: unknown[]): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    await c.query(sql, params);
    await c.query('commit');
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}

describe.skipIf(!DATABASE_URL)('TASK-020: stale edits fail fast', () => {
  it('stale is not a serialization failure (40001 would be retried forever by PostgREST)', async () => {
    const pool = makePool();
    try {
      const src = (await pool.query(`select prosrc from pg_proc where proname = 'set_transaction_split'`)).rows[0].prosrc as string;
      expect(src).toContain(`'stale' using errcode = '55000'`);
      expect(src).not.toContain('40001');
    } finally { await pool.end(); }
  });
});
