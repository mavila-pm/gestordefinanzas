import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

const INSERT = 'select public.import_insert_transaction($1::jsonb, $2::jsonb, $3) as id';
const tx = (o: Record<string, unknown> = {}) => JSON.stringify({
  type: 'credit_card_purchase', direction: 'outflow', amount_minor: 10000, currency: 'PEN', occurred_at: '2026-09-15T20:30:00-05:00',
  institution_code: 'BCP', card_last4: '4821', merchant_raw: 'RESTAURANTE X', merchant_normalized: 'RESTAURANTE X',
  category: 'Alimentación', status: 'review_required', confidence: 'medium', fingerprint: 'fp', ...o,
});
const src = (o: Record<string, unknown> = {}) => JSON.stringify({
  channel: 'import', external_event_id: `sha256:${Math.random()}`, parser_version: 'BCP_SMS_V1',
  template_verification: 'SYNTHETIC_UNVERIFIED', received_at: '2026-09-15T20:31:00Z', ...o,
});

describe.skipIf(!DATABASE_URL)('TASK-006: import write path (pasted notifications)', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('inserts an import with channel import, review status and the global category', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const id = (await c.query(INSERT, [tx(), src({ external_event_id: 'e1' }), '000111'])).rows[0].id;
      const row = (await c.query(`select t.status, t.user_id, t.bank_operation_id, c.name as category, s.channel, s.parser_version
        from public.transactions t join public.categories c on c.id = t.category_id join public.transaction_sources s on s.transaction_id = t.id where t.id = $1`, [id])).rows[0];
      expect(row).toEqual({ status: 'review_required', user_id: USER_A, bank_operation_id: '000111', category: 'Alimentación', channel: 'import', parser_version: 'BCP_SMS_V1' });
      expect(await errorCode(c, INSERT, [tx(), src({ external_event_id: 'e1' }), null])).toBe('23505'); // idempotent source
    });
  });

  it('can never insert a confirmed movement nor a bank-delivered provenance', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, INSERT, [tx({ status: 'confirmed' }), src(), null])).toBe('import_must_be_reviewed');
      expect(await errorMessage(c, INSERT, [tx({ status: 'ignored' }), src(), null])).toBe('import_must_be_reviewed');
      for (const channel of ['email', 'sms', 'manual']) expect(await errorMessage(c, INSERT, [tx(), src({ channel }), null])).toBe('invalid_source');
      expect(await errorMessage(c, INSERT, [tx(), src({ parser_version: 'MANUAL' }), null])).toBe('invalid_source');
      expect(await errorMessage(c, 'select public.import_record_event($1::jsonb)', [JSON.stringify({ channel: 'email', external_event_id: 'x', outcome: 'created' })])).toBe('invalid_request');
    });
  });

  it('validates the financial invariants server-side', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, INSERT, [tx({ direction: 'inflow' }), src(), null])).toBe('invalid_type'); // purchase must be outflow
      expect(await errorMessage(c, INSERT, [tx({ type: 'refund', direction: 'outflow' }), src(), null])).toBe('invalid_type');
      expect(await errorMessage(c, INSERT, [tx({ amount_minor: 0 }), src(), null])).toBe('invalid_amount');
      expect(await errorMessage(c, INSERT, [tx({ amount_minor: 12.5 }), src(), null])).toBe('invalid_amount');
      expect(await errorMessage(c, INSERT, [tx({ currency: 'EUR' }), src(), null])).toBe('invalid_currency');
      expect(await errorMessage(c, INSERT, [tx({ card_last4: '4557881234563456' }), src(), null])).toBe('invalid_card');
      expect(await errorMessage(c, INSERT, [tx({ category: 'Inventada' }), src(), null])).toBe('invalid_category');
      // Non-spending types never get a category, whatever the caller sends.
      const w = (await c.query(INSERT, [tx({ type: 'withdrawal', category: 'Alimentación' }), src(), null])).rows[0].id;
      expect((await c.query('select category_id from public.transactions where id = $1', [w])).rows[0].category_id).toBeNull();
    });
  });

  it('A/B: A cannot add sources to, or reference, B\'s movements; B sees nothing of A', async () => {
    const bTx = await asRole(pool, 'authenticated', USER_B, async (c) => (await c.query(INSERT, [tx(), src(), null])).rows[0].id);
    // asRole rolled back B's insert; create it for real as a privileged setup.
    const bId = (await pool.query(`insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, status, confidence, fingerprint)
      values ($1, now(), 'expense', 'outflow', 100, 'PEN', 'review_required', 'medium', 'b') returning id`, [USER_B])).rows[0].id;
    expect(bTx).toBeTruthy();
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, 'select public.import_add_source($1, $2::jsonb, $3::jsonb)', [bId, src(), '{}'])).toBe('not_found');
      expect(await errorCode(c, INSERT, [tx({ duplicate_of_id: bId }), src(), null])).toBe('23503'); // composite FK
      expect(await errorCode(c, 'select public.import_record_event($1::jsonb)', [JSON.stringify({ channel: 'import', external_event_id: 'x', outcome: 'created', transaction_id: bId })])).toBe('23503');
    });
    expect((await pool.query('select count(*)::int as n from public.transaction_sources where transaction_id = $1', [bId])).rows[0].n).toBe(0);
  });

  it('add_source only fills a missing merchant; never overwrites', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const id = (await c.query(INSERT, [tx({ merchant_raw: null, merchant_normalized: null, category: null }), src(), null])).rows[0].id;
      await c.query('select public.import_add_source($1, $2::jsonb, $3::jsonb)', [id, src({ parser_version: 'BCP_EMAIL_V1' }),
        JSON.stringify({ merchant_raw: 'TIENDA', merchant_normalized: 'TIENDA', category: 'Otros' })]);
      await c.query('select public.import_add_source($1, $2::jsonb, $3::jsonb)', [id, src(),
        JSON.stringify({ merchant_raw: 'OTRA', merchant_normalized: 'OTRA', category: 'Ocio' })]);
      const row = (await c.query('select merchant_raw, (select count(*)::int from public.transaction_sources s where s.transaction_id = t.id) as n from public.transactions t where id = $1', [id])).rows[0];
      expect(row).toEqual({ merchant_raw: 'TIENDA', n: 3 });
    });
  });

  it('anon cannot call the import functions', async () => {
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, INSERT, [tx(), src(), null])).toBe('42501');
    });
  });
});
