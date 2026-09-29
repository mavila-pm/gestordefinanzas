import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

/** ADR-0013 "Aplicar plan": saved reservations, one active per currency, append-only history, own rows only. */
describe.skipIf(!DATABASE_URL)('plan applications', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  const APPLY = `select public.apply_plan($1::public.currency_code, 'balance', 500000, null, '2026-09-29', '2026-10-14', 300000, 200000, 'partial', '[{"kind":"payment","label":"Alquiler","amountMinor":150000}]'::jsonb, $2) id`;

  /** One committed request (like a separate tab). Returns the new id or the error code. */
  async function commit(user: string, sql: string, params: unknown[]): Promise<{ id?: string; code?: string }> {
    const c = await pool.connect();
    try {
      await c.query('begin'); await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
      const r = await c.query(sql, params); await c.query('commit'); return { id: r.rows[0]?.id };
    } catch (e) { await c.query('rollback').catch(() => undefined); return { code: (e as { code?: string }).code ?? 'err' }; } finally { c.release(); }
  }
  const rows = async (user: string) => (await pool.query(`select id, currency, status, supersedes_id, closed_at from public.plan_applications where user_id = $1 order by created_at, id`, [user])).rows;

  it('apply twice → the first is superseded (kept as history), the second points to it; currencies stay apart', async () => {
    const a = await commit(USER_A, APPLY, ['PEN', 'ref-a-00000001']);
    const b = await commit(USER_A, APPLY, ['PEN', 'ref-a-00000002']);
    const u = await commit(USER_A, APPLY, ['USD', 'ref-a-00000003']);
    const r = await rows(USER_A);
    expect(r.find((x) => x.id === a.id)).toMatchObject({ status: 'superseded' });
    expect(r.find((x) => x.id === b.id)).toMatchObject({ status: 'active', supersedes_id: a.id });
    expect(r.find((x) => x.id === u.id)).toMatchObject({ status: 'active', currency: 'USD', supersedes_id: null });
  });

  it('5 parallel applies (two tabs) → all serialized, exactly one active; the same reference 5× → one row', async () => {
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => commit(USER_A, APPLY, ['PEN', `ref-par-0000000${i}`])));
    expect(res.every((x) => x.id)).toBe(true);
    let r = await rows(USER_A);
    expect(r.filter((x) => x.status === 'active')).toHaveLength(1);
    expect(r).toHaveLength(5);
    await pool.query('delete from public.plan_applications');
    const same = await Promise.all(Array.from({ length: 5 }, () => commit(USER_A, APPLY, ['PEN', 'ref-same-000001'])));
    expect(new Set(same.map((x) => x.id)).size).toBe(1);
    r = await rows(USER_A);
    expect(r).toHaveLength(1);
  });

  it('closed plans are immutable; amounts cannot be edited; no delete; cancel works once', async () => {
    const a = await commit(USER_A, APPLY, ['PEN', 'ref-imm-000001']);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, `update public.plan_applications set free_minor = 999 where id = $1`, [a.id])).toBe('42501');
      expect(await errorCode(c, `delete from public.plan_applications where id = $1`, [a.id])).toBe('42501');
      expect(await errorCode(c, `update public.plan_applications set status = 'cancelled', closed_at = now() where id = $1`, [a.id])).toBeNull();
      expect(await errorCode(c, `update public.plan_applications set status = 'active', closed_at = null where id = $1`, [a.id])).toBe('22023');
      // Arithmetic is checked by the database too: free = base − reserved.
      expect(await errorCode(c, `select public.apply_plan('PEN', 'balance', 500000, null, '2026-09-29', '2026-10-14', 300000, 999999, 'partial', '[]', null)`)).toBe('23514');
      // An income base must name the income movement.
      expect(await errorCode(c, `select public.apply_plan('PEN', 'income', 500000, null, '2026-09-29', '2026-10-14', 300000, 200000, 'partial', '[]', null)`)).toBe('23514');
    });
  });

  it('A/B: B never sees, cancels or writes A\'s plans; anon cannot apply', async () => {
    const a = await commit(USER_A, APPLY, ['PEN', 'ref-ab-0000001']);
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect((await c.query(`select count(*)::int n from public.plan_applications`)).rows[0].n).toBe(0);
      expect((await c.query(`update public.plan_applications set status = 'cancelled', closed_at = now() where id = $1`, [a.id])).rowCount).toBe(0);
      expect(await errorCode(c, `insert into public.plan_applications (user_id, currency, base_kind, base_minor, from_date, until_date, reserved_minor, free_minor, plan_status, lines)
        values ($1, 'PEN', 'balance', 100, '2026-09-29', '2026-10-01', 0, 100, 'confirmed', '[]')`, [USER_A])).toBe('42501');
      // B's own apply writes only B's row and does not touch A's active plan.
      await c.query(APPLY, ['PEN', 'ref-ab-0000002']);
    });
    expect((await rows(USER_A)).find((x) => x.id === a.id)).toMatchObject({ status: 'active' });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, APPLY, ['PEN', 'ref-ab-0000003'])).toBe('42501');
      expect(await errorCode(c, `select 1 from public.plan_applications`)).toBe('42501');
    });
  });
});
