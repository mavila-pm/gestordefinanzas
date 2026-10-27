import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { DATABASE_URL, makePool } from './helpers';

/**
 * Foreign keys of the tables migrations 052–053 create or change (plan_settlements, debt_payments, reserves,
 * reserve_entries): each one is served by an index WITHOUT a predicate whose leading columns are exactly the FK
 * columns, so deleting a parent (a payment, a debt, an apartado, a movement, an account) never scans every person's
 * rows. 052 replaced the unique (fixed_expense_id, period) index with a partial one (closing rows only), so the
 * plain plan_settlements_obligation index serves that FK now.
 */
const TABLES = ['plan_settlements', 'debt_payments', 'reserves', 'reserve_entries'];

describe.skipIf(!DATABASE_URL)('planning FKs have a plain supporting index', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  afterAll(async () => { await pool?.end(); });

  it('every FK of plan_settlements, debt_payments, reserves and reserve_entries', async () => {
    const fks = (await pool.query(`select t.relname::text tbl, c.conrelid rel,
        (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) cols
      from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
      where c.contype = 'f' and n.nspname = 'public' and t.relname = any($1)`, [TABLES]))
      .rows as { tbl: string; rel: number; cols: string[] }[];
    const idx = (await pool.query(`select i.indrelid rel,
        (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) cols
      from pg_index i join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
      where i.indisvalid and i.indpred is null and n.nspname = 'public' and t.relname = any($1)`, [TABLES]))
      .rows as { rel: number; cols: string[] | null }[];
    expect(new Set(fks.map((f) => f.tbl))).toEqual(new Set(TABLES));
    const served = (fk: { rel: number; cols: string[] }) => idx.some((i) => i.rel === fk.rel && i.cols !== null
      && i.cols.length >= fk.cols.length && i.cols.slice(0, fk.cols.length).every((c) => fk.cols.includes(c)));
    // plan_settlements' income and movement FKs predate this front (served by `<fk> IS NOT NULL` partial uniques).
    const legacy = new Set(['plan_settlements(expected_income_id,user_id)', 'plan_settlements(transaction_id,user_id)']);
    const missing = fks.map((f) => ({ f, key: `${f.tbl}(${f.cols.join(',')})` })).filter(({ f, key }) => !legacy.has(key) && !served(f)).map(({ key }) => key);
    expect(missing).toEqual([]);
    expect(fks.length).toBeGreaterThanOrEqual(10);
  });
});
