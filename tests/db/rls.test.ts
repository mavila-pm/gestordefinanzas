import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, makePool, USER_A, USER_B } from './helpers';

const PERMISSION_DENIED = '42501';
const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

describe.skipIf(!DATABASE_URL)('RLS: user isolation (User A vs User B)', () => {
  let pool: pg.Pool;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    pool = makePool();
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
    for (const [key, user] of [['A', USER_A], ['B', USER_B]] as const) {
      const card = await pool.query(`insert into public.cards (user_id, institution_code, alias, kind, currency, last4)
        values ($1, 'BCP', 'Visa', 'credit', 'PEN', '4821') returning id`, [user]);
      ids[`card${key}`] = card.rows[0].id;
      const tx = await pool.query(`insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency,
          institution_code, card_id, status, confidence, fingerprint)
        values ($1, now(), 'credit_card_purchase', 'outflow', 10000, 'PEN', 'BCP', $2, 'confirmed', 'high', 'fp') returning id`,
      [user, ids[`card${key}`]]);
      ids[`tx${key}`] = tx.rows[0].id;
      await pool.query(`insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, received_at)
        values ($1, $2, 'email', $3, 'BCP_EMAIL_V1', now())`, [user, ids[`tx${key}`], `m-${key}`]);
      await pool.query(`insert into public.financial_events (user_id, channel, external_event_id, outcome)
        values ($1, 'email', $2, 'created')`, [user, `m-${key}`]);
    }
  });
  afterAll(async () => { await pool?.end(); });

  it('every table in public has RLS enabled (guard for future tables)', async () => {
    const { rows } = await pool.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(rows).toEqual([]);
  });

  it('no client role (nor app_writer) holds privileges that bypass RLS (TRUNCATE) or any privilege for anon', async () => {
    const { rows } = await pool.query(`select c.relname, r.role, p.priv from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated'), ('app_writer')) r(role)
      cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
      where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege(r.role, c.oid, p.priv)
        and (r.role = 'anon' or p.priv in ('TRUNCATE', 'REFERENCES', 'TRIGGER')
          -- app_writer may delete only: manual transactions (delete_manual_transaction) and split allocations
          -- (replace-all inside set_transaction_split), and balance snapshots only through the demo-only
          -- delete_demo_balance_snapshots (allowlisted users, ADR-0006). Any other DELETE grant fails this guard.
          or (r.role = 'app_writer' and p.priv = 'DELETE' and c.relname not in ('transactions', 'transaction_allocations', 'balance_snapshots')))`);
    expect(rows).toEqual([]);
    const writer = await pool.query(`select rolbypassrls, rolcanlogin, rolsuper from pg_roles where rolname = 'app_writer'`);
    expect(writer.rows).toEqual([{ rolbypassrls: false, rolcanlogin: false, rolsuper: false }]);
  });

  it('SELECT: A sees only A\'s transactions; B\'s row by id is invisible', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const all = await c.query('select user_id from public.transactions');
      expect(all.rows.map((r) => r.user_id)).toEqual([USER_A]);
      expect((await c.query('select * from public.transactions where id = $1', [ids.txB])).rowCount).toBe(0);
      expect((await c.query('select * from public.cards where id = $1', [ids.cardB])).rowCount).toBe(0);
      expect((await c.query('select * from public.transaction_sources where user_id = $1', [USER_B])).rowCount).toBe(0);
      expect((await c.query('select * from public.financial_events where user_id = $1', [USER_B])).rowCount).toBe(0);
    });
  });

  it('INSERT: A cannot create rows owned by B', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, `insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, status, confidence, fingerprint)
        values ($1, now(), 'expense', 'outflow', 100, 'PEN', 'confirmed', 'high', 'x')`, [USER_B])).toBe(PERMISSION_DENIED);
      expect(await errorCode(c, `insert into public.cards (user_id, alias, kind, currency, last4) values ($1, 'x', 'debit', 'PEN', '1111')`, [USER_B])).toBe(PERMISSION_DENIED);
    });
  });

  it('composite FK: a transaction cannot reference another user\'s card, even from a privileged connection', async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      expect(await errorCode(c, `insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, card_id, status, confidence, fingerprint)
        values ($1, now(), 'expense', 'outflow', 100, 'PEN', $2, 'confirmed', 'high', 'x')`, [USER_A, ids.cardB])).toBe(FK_VIOLATION);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('UPDATE: transactions are not directly writable (TASK-004); A cannot modify B\'s cards', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, `update public.transactions set amount_minor = 1 where id = $1`, [ids.txB])).toBe(PERMISSION_DENIED);
      expect(await errorCode(c, `update public.transactions set status = 'confirmed' where id = $1`, [ids.txA])).toBe(PERMISSION_DENIED);
      expect(await errorCode(c, `update public.transactions set user_id = $1 where id = $2`, [USER_B, ids.txA])).toBe(PERMISSION_DENIED);
      expect((await c.query(`update public.cards set alias = 'hack' where id = $1`, [ids.cardB])).rowCount).toBe(0);
      expect(await errorCode(c, `update public.cards set user_id = $1 where id = $2`, [USER_B, ids.cardA])).toBe(PERMISSION_DENIED);
    });
    const { rows } = await pool.query('select amount_minor from public.transactions where id = $1', [ids.txB]);
    expect(rows[0].amount_minor).toBe('10000');
    expect((await pool.query('select alias from public.cards where id = $1', [ids.cardB])).rows[0].alias).toBe('Visa');
  });

  it('DELETE: transactions cannot be deleted by clients; A cannot delete B\'s cards', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, 'delete from public.transactions where id = $1', [ids.txB])).toBe(PERMISSION_DENIED);
      expect(await errorCode(c, 'delete from public.transactions where id = $1', [ids.txA])).toBe(PERMISSION_DENIED);
      expect((await c.query('delete from public.cards where id = $1', [ids.cardB])).rowCount).toBe(0);
    });
    expect((await pool.query('select 1 from public.transactions where id = $1', [ids.txB])).rowCount).toBe(1);
    expect((await pool.query('select 1 from public.cards where id = $1', [ids.cardB])).rowCount).toBe(1);
  });

  it('provenance tables are read-only for users (written only server-side)', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, `insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, received_at)
        values ($1, $2, 'sms', 'forged', 'X', now())`, [USER_A, ids.txA])).toBe(PERMISSION_DENIED);
      expect(await errorCode(c, `insert into public.financial_events (user_id, channel, external_event_id, outcome)
        values ($1, 'sms', 'forged', 'created')`, [USER_A])).toBe(PERMISSION_DENIED);
    });
  });

  it('global categories are readable but not modifiable', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query('select * from public.categories where user_id is null')).rowCount).toBe(9);
      expect((await c.query(`update public.categories set name = 'Hack' where user_id is null`)).rowCount).toBe(0);
      expect(await errorCode(c, `insert into public.categories (user_id, name) values (null, 'Global hack')`)).toBe(PERMISSION_DENIED);
    });
  });

  it('anonymous users get nothing', async () => {
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, 'select * from public.transactions')).toBe(PERMISSION_DENIED);
      expect(await errorCode(c, 'select * from public.cards')).toBe(PERMISSION_DENIED);
    });
  });

  it('authenticated without a user id sees nothing', async () => {
    await asRole(pool, 'authenticated', null, async (c) => {
      expect((await c.query('select * from public.transactions')).rowCount).toBe(0);
    });
  });
});

/**
 * Function EXECUTE grants (migration 049). Extension functions (pgcrypto lives in public locally, in `extensions` on
 * Supabase) are left out. A new function that anon can call, or a new SECURITY DEFINER function that authenticated can
 * call, fails here until it is reviewed and added below with its reason (docs/security/rls.md, "Function grants").
 */
const ANON_EXECUTE: Record<string, string> = {
  cap_spend: 'Cap replay store; /api/cap redeems before anyone is signed in (ADR-0016). Growth only, no token without the secret.',
  login_attempt: 'login lockout counter, reserved before the password is checked. Callable outside Cap: the owner decides the server-only gate (ADR-0016).',
};
const AUTHENTICATED_DEFINER = [
  'ai_record', 'ai_reserve', 'billing_create_order', 'billing_simulate_payment', 'cap_spend',
  'correct_transaction', 'create_manual_transaction', 'delete_demo_balance_snapshots', 'delete_manual_transaction', 'finish_registration',
  'import_add_source', 'import_insert_transaction', 'import_record_event', 'link_card_history', 'login_attempt',
  'login_succeeded', 'my_registration', 'reset_demo_ai_onboarding', 'review_transaction', 'rotate_email_connection',
  'set_demo_plan', 'set_transaction_split', 'start_plus_trial',
  // record_debt_payment (front C, 052): debt payment ledger write; owner from request_uid(), debt must be the caller's (ADR-0017).
  'record_debt_payment',
].sort();

describe.skipIf(!DATABASE_URL)('function EXECUTE grants (guard for future functions)', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  afterAll(async () => { await pool?.end(); });
  const fns = `from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`;

  it('anon may execute only the documented allowlist', async () => {
    const { rows } = await pool.query(`select distinct p.proname ${fns} and has_function_privilege('anon', p.oid, 'EXECUTE') order by 1`);
    expect(rows.map((r) => r.proname)).toEqual(Object.keys(ANON_EXECUTE).sort());
  });

  it('trigger functions are executable by no client role (triggers fire without EXECUTE)', async () => {
    const { rows } = await pool.query(`select p.oid::regprocedure::text f, r.role from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace cross join (values ('anon'), ('authenticated')) r(role)
      where n.nspname = 'public' and p.prorettype = 'trigger'::regtype and has_function_privilege(r.role, p.oid, 'EXECUTE')`);
    expect(rows).toEqual([]);
    const triggers = await pool.query(`select count(*)::int n ${fns} and p.prorettype = 'trigger'::regtype`);
    expect(triggers.rows[0].n).toBeGreaterThanOrEqual(8); // the guard really looked at them
  });

  it('SECURITY DEFINER functions callable by authenticated equal the reviewed list (each guards auth.uid() itself)', async () => {
    const { rows } = await pool.query(`select distinct p.proname ${fns} and p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1`);
    expect(rows.map((r) => r.proname)).toEqual(AUTHENTICATED_DEFINER);
  });

  it('every SECURITY DEFINER function pins its search_path', async () => {
    const { rows } = await pool.query(`select p.proname ${fns} and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(rows).toEqual([]);
  });

  it('a trigger still fires for a client after the revoke (card_statements_currency on insert)', async () => {
    await pool.query(`insert into auth.users (id, email) values ($1, 'fn-guard@test.local') on conflict do nothing`, [USER_A]);
    const card = await pool.query(`insert into public.cards (user_id, alias, kind, currency, last4) values ($1, 'Visa', 'credit', 'PEN', '1234') returning id`, [USER_A]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, 'select public.card_statements_currency()')).toBe(PERMISSION_DENIED);
      const sql = `insert into public.card_statements (user_id, card_id, cut_date, due_date, currency, billed_minor, minimum_minor)
        values ($1, $2, current_date, current_date + 20, $3, 1000, 100)`;
      expect(await errorCode(c, sql, [USER_A, card.rows[0].id, 'USD'])).toBe('23514'); // fired: currency must match the card
      expect(await errorCode(c, sql, [USER_A, card.rows[0].id, 'PEN'])).toBeNull(); // and lets a valid row through
    });
    await pool.query('delete from public.cards where id = $1', [card.rows[0].id]);
  });
});

describe.skipIf(!DATABASE_URL)('schema invariants', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  afterAll(async () => { await pool?.end(); });

  it('rejects non-positive amounts and type/direction mismatches', async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      const base = `insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, status, confidence, fingerprint)
        values ($1, now(), $2, $3, $4, 'PEN', 'confirmed', 'high', 'x')`;
      expect(await errorCode(c, base, [USER_A, 'expense', 'outflow', 0])).toBe(CHECK_VIOLATION);
      expect(await errorCode(c, base, [USER_A, 'expense', 'outflow', -100])).toBe(CHECK_VIOLATION);
      expect(await errorCode(c, base, [USER_A, 'credit_card_payment', 'inflow', 100])).toBe(CHECK_VIOLATION);
      expect(await errorCode(c, base, [USER_A, 'refund', 'outflow', 100])).toBe(CHECK_VIOLATION);
      expect(await errorCode(c, base, [USER_A, 'internal_transfer', 'outflow', 100])).toBe(CHECK_VIOLATION);
      expect(await errorCode(c, `insert into public.cards (user_id, alias, kind, currency, last4) values ($1, 'x', 'credit', 'PEN', '4557881234563456')`, [USER_A])).toBe(CHECK_VIOLATION);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
