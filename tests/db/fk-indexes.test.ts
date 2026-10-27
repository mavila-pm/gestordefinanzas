import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { DATABASE_URL, makePool } from './helpers';

/**
 * Foreign keys and the indexes that serve their checks (migration 050). When a parent row is deleted, PostgreSQL
 * looks up the child rows by the FK columns; without an index that starts with one of them (other than user_id) it
 * scans the child table of every person. A new FK fails here until it has such an index, or is accepted below with
 * its reason (the Supabase advisor "unindexed_foreign_keys" stays INFO for these). A partial index counts only when
 * the FK lookup can use it: no predicate, or `<fk column> IS NOT NULL` (an index `... WHERE active` is not used for
 * `user_id = $1`).
 */
const ACCEPTED: Record<string, string> = {
  'accounts(institution_code)': 'institutions is a reference table, never deleted or re-keyed',
  'cards(institution_code)': 'institutions is a reference table, never deleted or re-keyed',
  'transactions(institution_code)': 'institutions is a reference table, never deleted or re-keyed',
  'legal_acceptances(kind,version)': 'legal_documents versions are never deleted or re-keyed',
  'plan_applications(base_transaction_id,user_id)': 'check filters on user_id too: plan_applications_user (few rows per person)',
  'plan_applications(supersedes_id,user_id)': 'check filters on user_id too: plan_applications_user (few rows per person)',
  'user_preferences(primary_account_id,user_id)': 'check filters on user_id too: primary key (one row per person)',
};

describe.skipIf(!DATABASE_URL)('foreign keys have a supporting index (guard for future FKs)', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  afterAll(async () => { await pool?.end(); });

  it('every FK in public is served by an index on its own column, or is an accepted exception', async () => {
    const fks = (await pool.query(`select c.conrelid::regclass::text tbl, c.conrelid rel,
        (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) cols
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and n.nspname = 'public'`)).rows as { tbl: string; rel: number; cols: string[] }[];
    const idx = (await pool.query(`select i.indrelid rel, pg_get_expr(i.indpred, i.indrelid) pred,
        (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) cols
      from pg_index i join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and i.indisvalid`)).rows as { rel: number; pred: string | null; cols: string[] | null }[];
    expect(fks.length).toBeGreaterThan(40); // the guard really looked at the schema

    const usablePredicate = (pred: string | null, cols: string[]) => pred === null || cols.some((c) => pred === `(${c} IS NOT NULL)`);
    const served = (fk: { rel: number; cols: string[] }) => idx.some((i) => {
      if (i.rel !== fk.rel || !i.cols?.length || !usablePredicate(i.pred, fk.cols)) return false;
      const lead = i.cols[0]!;
      const prefix = i.cols.slice(0, fk.cols.length);
      const samePrefix = prefix.length === fk.cols.length && prefix.every((c) => fk.cols.includes(c));
      return samePrefix || (lead !== 'user_id' && fk.cols.includes(lead));
    });
    const missing = fks.filter((fk) => !served(fk)).map((fk) => `${fk.tbl.replace(/^public\./, '')}(${fk.cols.join(',')})`).sort();
    expect(missing).toEqual(Object.keys(ACCEPTED).sort());
  });

  it('a partial index serves an FK only without a predicate or with `<fk column> IS NOT NULL` (predicate text checked)', async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('create table public.fk_probe (id int primary key, parent_id int, active boolean)');
      await c.query('create index fk_probe_nn on public.fk_probe (parent_id) where parent_id is not null');
      await c.query('create index fk_probe_active on public.fk_probe (parent_id) where active');
      const { rows } = await c.query(`select c.relname, pg_get_expr(i.indpred, i.indrelid) pred from pg_index i
        join pg_class c on c.oid = i.indexrelid where c.relname in ('fk_probe_nn', 'fk_probe_active') order by 1`);
      expect(rows).toEqual([{ relname: 'fk_probe_active', pred: 'active' }, { relname: 'fk_probe_nn', pred: '(parent_id IS NOT NULL)' }]);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('050: deleting a category is checked through transaction_allocations_category', async () => {
    const { rows } = await pool.query(`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'transaction_allocations_category'`);
    expect(rows[0]?.indexdef).toMatch(/\(category_id\)$/);
  });
});
