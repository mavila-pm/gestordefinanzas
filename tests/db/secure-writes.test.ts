import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { ingestRawEvent, type UserContext } from '../../src/engine/ingest';
import { monthlySummary } from '../../src/engine/monthly-summary';
import { PgTransactionRepository } from '../../src/infrastructure/postgres/pg-transaction-repository';
import * as fx from '../fixtures/bcp';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

const PERMISSION_DENIED = '42501';
const ctx = (userId: string): UserContext => ({ userId, ownAccountLast4: [], cards: [], merchantRules: [] });

const MANUAL = `select public.create_manual_transaction($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as id`;
const manualArgs = (o: Partial<{ ref: string; type: string; amount: number; currency: string; at: string; desc: string | null;
  norm: string | null; category: string | null; card: string | null; account: string | null }> = {}) => [
  o.ref ?? randomUUID(), o.type ?? 'expense', o.amount ?? 3550, o.currency ?? 'PEN', o.at ?? '2026-09-20T13:00:00-05:00',
  o.desc ?? 'Almuerzo', o.norm ?? 'ALMUERZO', o.category ?? null, o.card ?? null, o.account ?? null,
];

describe.skipIf(!DATABASE_URL)('TASK-004: secure transaction writes (review queue, manual entry, corrections)', () => {
  let pool: pg.Pool;
  let repo: PgTransactionRepository;
  const ids: Record<string, string> = {};

  const txRow = async (id: string) => (await pool.query('select * from public.transactions where id = $1', [id])).rows[0];
  const sourcesOf = async (id: string) => (await pool.query(
    'select channel, external_event_id, parser_version, template_verification from public.transaction_sources where transaction_id = $1 order by received_at', [id])).rows;
  const auditOf = async (id: string) => (await pool.query(
    'select user_id, action, changes from public.audit_events where transaction_id = $1 order by created_at', [id])).rows;

  beforeAll(async () => {
    pool = makePool();
    repo = new PgTransactionRepository(pool);
  });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
    // Review items produced by the real ingestion pipeline: transfer to an unknown account (type unknown)
    // and a deposit of unknown origin, both review_required.
    for (const [key, user] of [['A', USER_A], ['B', USER_B]] as const) {
      await ingestRawEvent(fx.transferEmail('7777'), ctx(user), repo);
      await ingestRawEvent(fx.depositEmail(), ctx(user), repo);
      const rows = (await pool.query('select id, type from public.transactions where user_id = $1', [user])).rows;
      ids[`unknown${key}`] = rows.find((r) => r.type === 'unknown').id;
      ids[`deposit${key}`] = rows.find((r) => r.type === 'deposit').id;
      ids[`card${key}`] = (await pool.query(`insert into public.cards (user_id, institution_code, alias, kind, currency, last4)
        values ($1, 'BCP', 'Visa', 'credit', 'PEN', '4821') returning id`, [user])).rows[0].id;
      ids[`account${key}`] = (await pool.query(`insert into public.accounts (user_id, institution_code, alias, currency, last4)
        values ($1, 'BCP', 'Ahorros', 'PEN', '9001') returning id`, [user])).rows[0].id;
      ids[`category${key}`] = (await pool.query(`insert into public.categories (user_id, name) values ($1, $2) returning id`,
        [user, `Privada ${key}`])).rows[0].id;
      // Card purchase with a card that was not identified (card_id null), as ingestion stores it.
      ids[`purchase${key}`] = (await pool.query(`insert into public.transactions (user_id, occurred_at, type, direction, amount_minor,
          currency, institution_code, card_last4, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint)
        values ($1, '2026-09-15T20:30:00-05:00', 'expense', 'outflow', 10000, 'PEN', 'BCP', '4821', 'RESTAURANTE X', 'RESTAURANTE X',
          (select id from public.categories where user_id is null and name = 'Otros'), 'review_required', 'medium', 'fp-p') returning id`,
      [user])).rows[0].id;
      await pool.query(`insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, template_verification, received_at)
        values ($1, $2, 'sms', $3, 'BCP_SMS_V1', 'SYNTHETIC_UNVERIFIED', now())`, [user, ids[`purchase${key}`], `sms-${key}`]);
      ids[`other4${key}`] = (await pool.query(`insert into public.cards (user_id, institution_code, alias, kind, currency, last4)
        values ($1, 'BCP', 'Débito', 'debit', 'PEN', '1111') returning id`, [user])).rows[0].id;
    }
  });
  afterAll(async () => { await pool?.end(); });

  describe('manual entry', () => {
    it('creates a confirmed transaction with derived direction, manual provenance and an audit event', async () => {
      const ref = randomUUID();
      const id = await asRole(pool, 'authenticated', USER_A, async (c) => (await c.query(MANUAL, manualArgs({ ref }))).rows[0].id);
      // asRole rolls back: re-run for real through a committed session to inspect the rows.
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const c = await pool.connect();
      try {
        await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: USER_A, role: 'authenticated' })]);
        await c.query('set role authenticated');
        const created = (await c.query(MANUAL, manualArgs({ ref }))).rows[0].id as string;
        const again = (await c.query(MANUAL, manualArgs({ ref, amount: 999 }))).rows[0].id as string;
        expect(again).toBe(created); // idempotent on the client reference (double submit)
        await c.query('reset role');
        const t = await txRow(created);
        expect(t).toMatchObject({ user_id: USER_A, type: 'expense', direction: 'outflow', amount_minor: '3550', status: 'confirmed',
          confidence: 'high', merchant_raw: 'Almuerzo', merchant_normalized: 'ALMUERZO', fingerprint: `manual:${ref}` });
        expect((await pool.query('select name from public.categories where id = $1', [t.category_id])).rows[0].name).toBe('Otros');
        expect(await sourcesOf(created)).toEqual([{ channel: 'manual', external_event_id: ref, parser_version: 'MANUAL', template_verification: null }]);
        const audit = await auditOf(created);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ user_id: USER_A, action: 'manual_create' });
        expect(audit[0].changes.amount_minor).toEqual({ from: null, to: 3550 });
      } finally {
        await c.query('reset role');
        c.release();
      }
    });

    it('withdrawal / card payment / refund get the right direction and category rules', async () => {
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        const w = (await c.query(MANUAL, manualArgs({ type: 'withdrawal', amount: 20000 }))).rows[0].id;
        const p = (await c.query(MANUAL, manualArgs({ type: 'credit_card_payment', amount: 10000 }))).rows[0].id;
        const r = (await c.query(MANUAL, manualArgs({ type: 'refund', amount: 3000 }))).rows[0].id;
        const t = (await c.query('select id, direction, category_id from public.transactions where id = any($1)', [[w, p, r]])).rows;
        const by = (id: string) => t.find((x) => x.id === id);
        expect(by(w)).toMatchObject({ direction: 'outflow', category_id: null });
        expect(by(p)).toMatchObject({ direction: 'outflow', category_id: null });
        expect(by(r).direction).toBe('inflow');
        expect(by(r).category_id).not.toBeNull();
        expect(await errorMessage(c, MANUAL, manualArgs({ type: 'withdrawal', category: ids.categoryA! }))).toBe('category_not_applicable');
      });
    });

    it('with an own card it records the card digits and institution', async () => {
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        const id = (await c.query(MANUAL, manualArgs({ card: ids.cardA! }))).rows[0].id;
        expect((await c.query('select card_id, card_last4, institution_code from public.transactions where id = $1', [id])).rows[0])
          .toEqual({ card_id: ids.cardA, card_last4: '4821', institution_code: 'BCP' });
      });
    });

    it('rejects invalid payloads server-side', async () => {
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        for (const type of ['credit_card_purchase', 'deposit', 'reversal', 'unknown']) {
          expect(await errorMessage(c, MANUAL, manualArgs({ type }))).toBe('invalid_type');
        }
        expect(await errorCode(c, MANUAL, manualArgs({ type: 'hack' }))).toBe('22P02'); // not even an enum value
        expect(await errorCode(c, MANUAL, manualArgs({ currency: 'EUR' }))).toBe('22P02');
        expect(await errorMessage(c, MANUAL, manualArgs({ amount: 0 }))).toBe('invalid_amount');
        expect(await errorMessage(c, MANUAL, manualArgs({ amount: -100 }))).toBe('invalid_amount');
        expect(await errorMessage(c, MANUAL, manualArgs({ amount: 100000000001 }))).toBe('invalid_amount');
        expect(await errorMessage(c, MANUAL, manualArgs({ at: '2099-01-01T00:00:00-05:00' }))).toBe('invalid_date');
        expect(await errorMessage(c, MANUAL, manualArgs({ at: '1999-12-31T00:00:00-05:00' }))).toBe('invalid_date');
        expect(await errorMessage(c, MANUAL, manualArgs({ desc: 'x'.repeat(121) }))).toBe('invalid_description');
        expect(await errorMessage(c, MANUAL, manualArgs({ desc: 'bad\u0007text' }))).toBe('invalid_description');
        expect(await errorMessage(c, MANUAL, manualArgs({ norm: 'lower case' }))).toBe('invalid_description');
      });
    });

    it('A cannot use B\'s category, card or account (same answer as a non-existent one)', async () => {
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        expect(await errorMessage(c, MANUAL, manualArgs({ category: ids.categoryB! }))).toBe('invalid_category');
        expect(await errorMessage(c, MANUAL, manualArgs({ category: randomUUID() }))).toBe('invalid_category');
        expect(await errorMessage(c, MANUAL, manualArgs({ card: ids.cardB! }))).toBe('invalid_card');
        expect(await errorMessage(c, MANUAL, manualArgs({ account: ids.accountB! }))).toBe('invalid_account');
      });
    });
  });

  describe('review queue: confirm / ignore', () => {
    const review = 'select public.review_transaction($1, $2)';

    it('confirm moves review_required -> confirmed, audits it and keeps provenance intact', async () => {
      const before = await sourcesOf(ids.depositA!);
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        await c.query(review, [ids.depositA, 'confirm']);
        expect((await c.query('select status from public.transactions where id = $1', [ids.depositA])).rows[0].status).toBe('confirmed');
        const audit = (await c.query('select action, changes from public.audit_events where transaction_id = $1', [ids.depositA])).rows;
        expect(audit).toEqual([{ action: 'confirm', changes: { status: { from: 'review_required', to: 'confirmed' } } }]);
        expect((await c.query('select count(*)::int as n from public.transaction_sources where transaction_id = $1', [ids.depositA])).rows[0].n).toBe(before.length);
        await c.query(review, [ids.depositA, 'confirm']); // idempotent: no second audit row
        expect((await c.query('select count(*)::int as n from public.audit_events where transaction_id = $1', [ids.depositA])).rows[0].n).toBe(1);
      });
    });

    it('an undetermined type (unknown) cannot be confirmed without correcting it first', async () => {
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        expect(await errorMessage(c, review, [ids.unknownA, 'confirm'])).toBe('type_required');
      });
    });

    it('ignore keeps the row and its sources (never deletes)', async () => {
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        await c.query(review, [ids.purchaseA, 'ignore']);
        const row = (await c.query('select status from public.transactions where id = $1', [ids.purchaseA])).rows[0];
        expect(row.status).toBe('ignored');
        expect((await c.query('select count(*)::int as n from public.transaction_sources where transaction_id = $1', [ids.purchaseA])).rows[0].n).toBe(1);
        expect(await errorMessage(c, review, [ids.purchaseA, 'delete'])).toBe('invalid_action');
      });
    });
  });

  describe('corrections', () => {
    const correct = 'select public.correct_transaction($1, $2::jsonb, $3)';

    it('type change derives direction server-side, clears non-applicable category and records from/to', async () => {
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        await c.query(correct, [ids.unknownA, JSON.stringify({ type: 'internal_transfer' }), true]);
        const t = (await c.query('select type, direction, status, category_id, fingerprint from public.transactions where id = $1', [ids.unknownA])).rows[0];
        expect(t).toMatchObject({ type: 'internal_transfer', direction: 'neutral', status: 'confirmed', category_id: null });
        const audit = (await c.query('select changes from public.audit_events where transaction_id = $1', [ids.unknownA])).rows[0].changes;
        expect(audit.type).toEqual({ from: 'unknown', to: 'internal_transfer' });
        expect(audit.status).toEqual({ from: 'review_required', to: 'confirmed' });
      });
    });

    it('a direction sent by the client is never accepted; only whitelisted fields', async () => {
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        for (const key of ['direction', 'status', 'user_id', 'fingerprint', 'confidence', 'card_last4', 'institution_code']) {
          expect(await errorMessage(c, correct, [ids.purchaseA, JSON.stringify({ [key]: 'x' }), false])).toBe('invalid_field');
        }
        expect(await errorMessage(c, correct, [ids.purchaseA, JSON.stringify({ type: 'unknown' }), false])).toBe('invalid_type');
        expect(await errorMessage(c, correct, [ids.purchaseA, JSON.stringify({ amount_minor: 12.5 }), false])).toBe('invalid_amount');
        expect(await errorMessage(c, correct, [ids.purchaseA, JSON.stringify({ amount_minor: '100' }), false])).toBe('invalid_amount');
        expect(await errorMessage(c, correct, [ids.purchaseA, JSON.stringify({ occurred_at: '2026-02-31T10:00:00-05:00' }), false])).toBe('invalid_date');
        expect(await errorMessage(c, correct, [ids.purchaseA, JSON.stringify({ category_id: null }), false])).toBe('invalid_category');
        expect(await errorMessage(c, correct, [ids.purchaseA, '[]', false])).toBe('invalid_request');
      });
    });

    it('amount/category/description corrections keep the original values in the audit trail and provenance untouched', async () => {
      const sourcesBefore = await sourcesOf(ids.purchaseA!);
      const fpBefore = (await txRow(ids.purchaseA!)).fingerprint;
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        const food = (await c.query(`select id from public.categories where user_id is null and name = 'Alimentación'`)).rows[0].id;
        await c.query(correct, [ids.purchaseA, JSON.stringify({ amount_minor: 9550, category_id: food, merchant_raw: 'Restaurante X Miraflores', merchant_normalized: 'RESTAURANTE X MIRAFLORES' }), true]);
        const t = (await c.query('select amount_minor, status, fingerprint, merchant_raw from public.transactions where id = $1', [ids.purchaseA])).rows[0];
        expect(t).toMatchObject({ amount_minor: '9550', status: 'confirmed', fingerprint: fpBefore, merchant_raw: 'Restaurante X Miraflores' });
        const changes = (await c.query('select changes from public.audit_events where transaction_id = $1', [ids.purchaseA])).rows[0].changes;
        expect(changes.amount_minor).toEqual({ from: 10000, to: 9550 });
        expect(changes.merchant_raw).toEqual({ from: 'RESTAURANTE X', to: 'Restaurante X Miraflores' });
      });
      expect(await sourcesOf(ids.purchaseA!)).toEqual(sourcesBefore);
    });

    it('card association: own matching card OK; different digits rejected; B\'s card (same digits) rejected', async () => {
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        expect(await errorMessage(c, correct, [ids.purchaseA, JSON.stringify({ card_id: ids.other4A }), false])).toBe('card_mismatch');
        expect(await errorMessage(c, correct, [ids.purchaseA, JSON.stringify({ card_id: ids.cardB }), false])).toBe('invalid_card');
        expect(await errorMessage(c, correct, [ids.purchaseA, JSON.stringify({ account_id: ids.accountB }), false])).toBe('invalid_account');
        expect(await errorMessage(c, correct, [ids.purchaseA, JSON.stringify({ category_id: ids.categoryB }), false])).toBe('invalid_category');
        await c.query(correct, [ids.purchaseA, JSON.stringify({ card_id: ids.cardA, account_id: ids.accountA }), false]);
        expect((await c.query('select card_id, account_id, card_last4 from public.transactions where id = $1', [ids.purchaseA])).rows[0])
          .toEqual({ card_id: ids.cardA, account_id: ids.accountA, card_last4: '4821' });
      });
    });
  });

  describe('A/B isolation through the write functions', () => {
    it('A cannot confirm, ignore or correct B\'s transactions (not_found, B unchanged, nothing audited)', async () => {
      const before = await txRow(ids.purchaseB!);
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        expect(await errorMessage(c, 'select public.review_transaction($1, $2)', [ids.purchaseB, 'confirm'])).toBe('not_found');
        expect(await errorMessage(c, 'select public.review_transaction($1, $2)', [ids.purchaseB, 'ignore'])).toBe('not_found');
        expect(await errorMessage(c, 'select public.correct_transaction($1, $2::jsonb, $3)', [ids.purchaseB, JSON.stringify({ amount_minor: 1 }), true])).toBe('not_found');
        expect(await errorMessage(c, 'select public.review_transaction($1, $2)', [randomUUID(), 'confirm'])).toBe('not_found');
      });
      expect(await txRow(ids.purchaseB!)).toEqual(before);
      expect((await pool.query('select count(*)::int as n from public.audit_events where user_id = $1', [USER_B])).rows[0].n).toBe(0);
    });

    it('audit trail: A reads only own events and cannot write or erase any', async () => {
      await pool.query(`insert into public.audit_events (user_id, transaction_id, action) values ($1, $2, 'confirm')`, [USER_B, ids.purchaseB]);
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        await c.query('select public.review_transaction($1, $2)', [ids.depositA, 'confirm']);
        expect((await c.query('select user_id from public.audit_events')).rows).toEqual([{ user_id: USER_A }]);
        expect(await errorCode(c, `insert into public.audit_events (user_id, action) values ($1, 'confirm')`, [USER_A])).toBe(PERMISSION_DENIED);
        expect(await errorCode(c, 'update public.audit_events set changes = $1', ['{}'])).toBe(PERMISSION_DENIED);
        expect(await errorCode(c, 'delete from public.audit_events')).toBe(PERMISSION_DENIED);
      });
    });

    it('anon cannot execute the write functions; authenticated without identity is rejected', async () => {
      await asRole(pool, 'anon', null, async (c) => {
        expect(await errorCode(c, MANUAL, manualArgs())).toBe(PERMISSION_DENIED);
        expect(await errorCode(c, 'select public.review_transaction($1, $2)', [ids.depositA, 'confirm'])).toBe(PERMISSION_DENIED);
        expect(await errorCode(c, 'select public.correct_transaction($1, $2::jsonb, $3)', [ids.depositA, '{}', false])).toBe(PERMISSION_DENIED);
      });
      await asRole(pool, 'authenticated', null, async (c) => {
        expect(await errorMessage(c, MANUAL, manualArgs())).toBe('not_authenticated');
      });
    });

    it('internal helpers are not callable by clients', async () => {
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        expect(await errorCode(c, `select public.direction_for('expense')`)).toBe(PERMISSION_DENIED);
        expect(await errorCode(c, `select public.resolve_category($1, 'expense', null)`, [USER_A])).toBe(PERMISSION_DENIED);
      });
    });

    it('second barrier: inside the functions (role app_writer) RLS still hides B and blocks forged bank provenance', async () => {
      await asRole(pool, 'authenticated', USER_A, async (c) => {
        await c.query('set local role app_writer');
        expect((await c.query('select id from public.transactions where id = $1', [ids.purchaseB])).rowCount).toBe(0);
        expect((await c.query('update public.transactions set amount_minor = 1 where id = $1', [ids.purchaseB])).rowCount).toBe(0);
        expect((await c.query('select id from public.cards where id = $1', [ids.cardB])).rowCount).toBe(0);
        expect(await errorCode(c, `insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, received_at)
          values ($1, $2, 'email', 'forged', 'BCP_EMAIL_V1', now())`, [USER_A, ids.purchaseA])).toBe(PERMISSION_DENIED);
        expect(await errorCode(c, `insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, status, confidence, fingerprint)
          values ($1, now(), 'expense', 'outflow', 100, 'PEN', 'confirmed', 'high', 'x')`, [USER_B])).toBe(PERMISSION_DENIED);
        // DELETE exists only for delete_manual_transaction (TASK-005); RLS still hides B's rows from it.
        expect((await c.query('delete from public.transactions where id = $1', [ids.purchaseB])).rowCount).toBe(0);
        expect(await errorCode(c, 'delete from public.transaction_sources where transaction_id = $1', [ids.purchaseA])).toBe(PERMISSION_DENIED);
      });
    });
  });

  describe('financial rules still hold after review and manual entry', () => {
    it('purchase S/100 + card payment S/100 + ATM S/200 + refund S/30 -> expenses S/70; ignored duplicate excluded', async () => {
      const c = await pool.connect();
      try {
        await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: USER_A, role: 'authenticated' })]);
        await c.query('set role authenticated');
        await c.query('select public.correct_transaction($1, $2::jsonb, true)', [ids.purchaseA, JSON.stringify({ card_id: ids.cardA })]);
        await c.query(MANUAL, manualArgs({ type: 'credit_card_payment', amount: 10000, desc: null, norm: null }));
        await c.query(MANUAL, manualArgs({ type: 'withdrawal', amount: 20000, desc: null, norm: null }));
        await c.query(MANUAL, manualArgs({ type: 'refund', amount: 3000, desc: 'Devolución', norm: 'DEVOLUCION' }));
        const dup = (await c.query(MANUAL, manualArgs({ amount: 10000, desc: 'Duplicado', norm: 'DUPLICADO' }))).rows[0].id;
        await c.query('select public.review_transaction($1, $2)', [dup, 'ignore']);
        await c.query('select public.review_transaction($1, $2)', [ids.depositA, 'ignore']);
        await c.query('select public.correct_transaction($1, $2::jsonb, true)', [ids.unknownA, JSON.stringify({ type: 'internal_transfer' })]);
      } finally {
        await c.query('reset role');
        c.release();
      }
      const s = monthlySummary(await repo.listTransactions(USER_A), '2026-09', 'PEN');
      expect(s).toMatchObject({ expensesMinor: 7000, incomeMinor: 0, cashWithdrawalsMinor: 20000, pendingCount: 0, savingsLabel: 'confirmed' });
    });
  });
});
