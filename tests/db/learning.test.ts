import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { ingestRawEvent } from '../../src/engine/ingest';
import { monthlySummary } from '../../src/engine/monthly-summary';
import { buildUserContext } from '../../src/engine/user-context';
import { PgTransactionRepository } from '../../src/infrastructure/postgres/pg-transaction-repository';
import * as fx from '../fixtures/bcp';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

const PERMISSION_DENIED = '42501';

/** Loads the ingestion context exactly as the app does (RLS-scoped reads), through the pure builder. */
async function contextFor(pool: pg.Pool, userId: string) {
  return asRole(pool, 'authenticated', userId, async (c) => buildUserContext(userId, {
    cards: (await c.query('select last4, kind, active from public.cards')).rows,
    accounts: (await c.query('select last4, active from public.accounts')).rows,
    rules: (await c.query(`select r.contains, c.name as category_name from public.merchant_rules r
      left join public.categories c on c.id = r.category_id`)).rows,
  }));
}

/** Runs statements as the signed-in user in a committed session (functions that must persist). */
async function asUser<T>(pool: pg.Pool, userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
    await c.query('set role authenticated');
    return await fn(c);
  } finally {
    await c.query('reset role');
    await c.query(`select set_config('request.jwt.claims', '', false)`);
    c.release();
  }
}

const MANUAL = `select public.create_manual_transaction($1, $2, $3, 'PEN', $4, $5, $6) as id`;

describe.skipIf(!DATABASE_URL)('TASK-005: accounts, learning from corrections, manual deletion', () => {
  let pool: pg.Pool;
  let repo: PgTransactionRepository;
  let food: string;

  beforeAll(async () => {
    pool = makePool();
    repo = new PgTransactionRepository(pool);
    food = (await pool.query(`select id from public.categories where user_id is null and name = 'Alimentación'`)).rows[0].id;
  });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('a category correction with "remember" creates a rule, and the next event of that merchant is auto-categorized', async () => {
    // First purchase at a merchant no global rule knows: categorized "Otros".
    const unknownShop = (id: string, day: string, op: string) => {
      const e = fx.purchasePenEmail(id);
      e.body = e.body.replace('RESTAURANTE EL EJEMPLO S.A.C.', 'BODEGA DON PEPE S.A.C.').replace('15 de septiembre', day).replace('000111', op);
      return e;
    };
    await ingestRawEvent(unknownShop('<m1@mail.test>', '15 de septiembre', '000111'), await contextFor(pool, USER_A), repo);
    expect((await repo.listTransactions(USER_A))[0]!.category).toBe('Otros');
    const first = (await pool.query('select id, merchant_normalized from public.transactions where user_id = $1', [USER_A])).rows[0];
    await asUser(pool, USER_A, (c) => c.query('select public.correct_transaction($1, $2::jsonb, true, true)',
      [first.id, JSON.stringify({ category_id: food })]));

    const rule = (await pool.query('select user_id, contains, category_id, source_transaction_id from public.merchant_rules')).rows;
    expect(rule).toEqual([{ user_id: USER_A, contains: first.merchant_normalized, category_id: food, source_transaction_id: first.id }]);
    const audit = (await pool.query(`select action from public.audit_events where transaction_id = $1 order by created_at`, [first.id])).rows.map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['correct', 'rule_create']));

    // Same merchant, a different operation next day (not a duplicate): the learned rule applies.
    const ctx = await contextFor(pool, USER_A);
    expect(ctx.merchantRules).toEqual([{ contains: first.merchant_normalized, category: 'Alimentación' }]);
    await ingestRawEvent(unknownShop('<m2@mail.test>', '16 de septiembre', '000112'), ctx, repo);
    const txs = await repo.listTransactions(USER_A);
    expect(txs).toHaveLength(2);
    expect(txs.every((t) => t.category === 'Alimentación')).toBe(true);
  });

  it('rules are per user: B neither sees A\'s rules nor benefits from them; rules only for categorizable types', async () => {
    const id = await asUser(pool, USER_A, async (c) => (await c.query(MANUAL, [randomUUID(), 'expense', 4500, '2026-09-20T13:00:00-05:00', 'Pollería Rico', 'POLLERIA RICO'])).rows[0].id);
    await asUser(pool, USER_A, (c) => c.query('select public.correct_transaction($1, $2::jsonb, false, true)', [id, JSON.stringify({ category_id: food })]));
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect((await c.query('select * from public.merchant_rules')).rowCount).toBe(0);
    });
    expect((await contextFor(pool, USER_B)).merchantRules).toEqual([]);
    const w = await asUser(pool, USER_A, async (c) => (await c.query(MANUAL, [randomUUID(), 'withdrawal', 20000, '2026-09-20T13:00:00-05:00', 'Cajero', 'CAJERO'])).rows[0].id);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, 'select public.correct_transaction($1, $2::jsonb, false, true)', [w, '{}'])).toBe('rule_not_applicable');
      // A user-owned category cannot back a rule (rules map to the global catalog for now).
      const own = (await c.query(`insert into public.categories (user_id, name) values ($1, 'Mía') returning id`, [USER_A])).rows[0].id;
      expect(await errorMessage(c, 'select public.correct_transaction($1, $2::jsonb, false, true)', [id, JSON.stringify({ category_id: own })])).toBe('rule_not_applicable');
    });
  });

  it('own accounts prove internal transfers: transfer to own account -> internal_transfer, not expense, no review', async () => {
    await pool.query(`insert into public.accounts (user_id, institution_code, alias, currency, last4) values ($1, 'BBVA', 'BBVA ahorros', 'PEN', '9001')`, [USER_A]);
    await ingestRawEvent(fx.transferEmail('9001'), await contextFor(pool, USER_A), repo);
    await ingestRawEvent(fx.transferEmail('7777'), await contextFor(pool, USER_B), repo);
    const [a] = await repo.listTransactions(USER_A);
    const [b] = await repo.listTransactions(USER_B);
    expect(a).toMatchObject({ type: 'internal_transfer', direction: 'neutral', status: 'confirmed' });
    expect(b).toMatchObject({ type: 'unknown', status: 'review_required' });
    const s = monthlySummary([a!], a!.occurredAt.slice(0, 7), 'PEN');
    expect(s.expensesMinor).toBe(0);
    expect(s.incomeMinor).toBe(0);
  });

  it('inactive accounts/cards do not count; duplicate account digits are rejected', async () => {
    await pool.query(`insert into public.accounts (user_id, institution_code, alias, currency, last4, active) values ($1, 'BBVA', 'Cerrada', 'PEN', '9001', false)`, [USER_A]);
    expect((await contextFor(pool, USER_A)).ownAccountLast4).toEqual([]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorCode(c, `insert into public.accounts (user_id, institution_code, alias, currency, last4) values ($1, 'BBVA', 'Otra', 'PEN', '9001')`, [USER_A])).toBe('23505');
      // A cannot create an account for B, nor read B's.
      expect(await errorCode(c, `insert into public.accounts (user_id, alias, currency) values ($1, 'x', 'PEN')`, [USER_B])).toBe(PERMISSION_DENIED);
    });
  });

  it('manual movements can be deleted (audited, snapshot kept); automatic ones cannot; B\'s answer not_found', async () => {
    const manual = await asUser(pool, USER_A, async (c) => (await c.query(MANUAL, [randomUUID(), 'expense', 3000, '2026-09-20T13:00:00-05:00', 'Taxi', 'TAXI'])).rows[0].id);
    await ingestRawEvent(fx.purchasePenEmail(), await contextFor(pool, USER_A), repo);
    const auto = (await pool.query(`select id from public.transactions where user_id = $1 and fingerprint not like 'manual:%'`, [USER_A])).rows[0].id;
    const bManual = await asUser(pool, USER_B, async (c) => (await c.query(MANUAL, [randomUUID(), 'expense', 1000, '2026-09-20T13:00:00-05:00', 'B', 'B'])).rows[0].id);

    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, 'select public.delete_manual_transaction($1)', [auto])).toBe('not_deletable');
      expect(await errorMessage(c, 'select public.delete_manual_transaction($1)', [bManual])).toBe('not_found');
    });
    await asUser(pool, USER_A, (c) => c.query('select public.delete_manual_transaction($1)', [manual]));

    expect((await pool.query('select 1 from public.transactions where id = $1', [manual])).rowCount).toBe(0);
    expect((await pool.query('select 1 from public.transactions where id = $1', [bManual])).rowCount).toBe(1);
    const trail = (await pool.query(`select transaction_id, changes from public.audit_events where user_id = $1 and action = 'delete'`, [USER_A])).rows;
    expect(trail).toHaveLength(1);
    expect(trail[0].transaction_id).toBeNull(); // the row is gone, the record of it is not
    expect(trail[0].changes.deleted.from).toMatchObject({ type: 'expense', amount_minor: 3000, merchant_raw: 'Taxi' });
    // The earlier manual_create audit row also survives.
    expect((await pool.query(`select count(*)::int as n from public.audit_events where user_id = $1 and action = 'manual_create'`, [USER_A])).rows[0].n).toBe(1);
  });

  it('a movement referenced by another (possible duplicate) is not deletable', async () => {
    await asUser(pool, USER_A, async (c) => {
      await c.query('begin');
      const a = (await c.query(MANUAL, [randomUUID(), 'expense', 3000, '2026-09-20T13:00:00-05:00', 'X', 'X'])).rows[0].id;
      await c.query('reset role');
      await c.query(`insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, status, confidence, fingerprint, duplicate_of_id)
        values ($1, now(), 'expense', 'outflow', 3000, 'PEN', 'possible_duplicate', 'high', 'fp', $2)`, [USER_A, a]);
      await c.query('set role authenticated');
      expect(await errorMessage(c, 'select public.delete_manual_transaction($1)', [a])).toBe('not_deletable');
      await c.query('rollback');
    });
  });

  it('TASK-013: after the user corrects the amount, the late SMS of the same purchase merges (no double count)', async () => {
    const ctx = await contextFor(pool, USER_A);
    await ingestRawEvent(fx.purchasePenEmail(), ctx, repo);
    const [t] = await repo.listTransactions(USER_A);
    await asUser(pool, USER_A, (c) => c.query('select public.correct_transaction($1, $2::jsonb, true)', [t!.id, JSON.stringify({ amount_minor: 9550 })]));
    const r = await ingestRawEvent(fx.purchasePenSms(), ctx, repo);
    expect(r.outcome).toBe('merged_cross_source');
    const txs = await repo.listTransactions(USER_A);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ amountMinor: 9550 }); // the user's correction wins
    expect(txs[0]!.sources.map((s) => s.channel).sort()).toEqual(['email', 'sms']);
    expect(monthlySummary(txs, '2026-09', 'PEN').expensesMinor).toBe(9550);
  });

  it('TASK-013: bank-reported values are immutable for everyone', async () => {
    await ingestRawEvent(fx.purchasePenEmail(), await contextFor(pool, USER_A), repo);
    await pool.query(`update public.transactions set reported_amount_minor = 1, reported_occurred_at = now(), amount_minor = 5000 where user_id = $1`, [USER_A]);
    expect((await pool.query('select reported_amount_minor, amount_minor from public.transactions where user_id = $1', [USER_A])).rows[0])
      .toEqual({ reported_amount_minor: '10000', amount_minor: '5000' });
  });
});
