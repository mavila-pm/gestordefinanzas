import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

const INSERT = 'select public.import_insert_transaction($1::jsonb, $2::jsonb, null) as id';
const tx = (o: Record<string, unknown> = {}) => JSON.stringify({
  type: 'expense', direction: 'outflow', amount_minor: 10000, currency: 'PEN', occurred_at: '2026-09-15T20:30:00-05:00',
  institution_code: 'BCP', card_last4: '4821', merchant_raw: 'RESTAURANTE X', merchant_normalized: 'RESTAURANTE X',
  category: 'Alimentación', status: 'review_required', confidence: 'medium', fingerprint: 'fp', ...o,
});
const src = () => JSON.stringify({
  channel: 'import', external_event_id: `sha256:${Math.random()}`, parser_version: 'BCP_SMS_V1',
  template_verification: 'SYNTHETIC_UNVERIFIED', received_at: '2026-09-15T20:31:00Z',
});

describe.skipIf(!DATABASE_URL)('TASK-014: automatic card link', () => {
  let pool: pg.Pool;
  const card = async (user: string, last4: string, institution: string | null = 'BCP', active = true) =>
    (await pool.query(`insert into public.cards (user_id, alias, institution_code, kind, currency, last4, active)
      values ($1, 'T', $2, 'credit', 'PEN', $3, $4) returning id`, [user, institution, last4, active])).rows[0].id as string;
  // asRole rolls back: read inside the same transaction.
  const cardOf = async (c: pg.PoolClient, id: string) => (await c.query('select card_id from public.transactions where id = $1', [id])).rows[0].card_id;

  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('an import is linked to the single matching active card, resolved in the database', async () => {
    const c1 = await card(USER_A, '4821');
    await card(USER_A, '4821', 'BBVA'); // other bank: not a match
    await card(USER_A, '4821', 'BCP', false); // inactive: not a match
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const id = (await c.query(INSERT, [tx(), src()])).rows[0].id;
      expect(await cardOf(c, id)).toBe(c1);
      // The caller cannot choose the card: an unknown key is ignored, the resolved card wins.
      const forged = (await c.query(INSERT, [tx({ card_id: '00000000-0000-4000-8000-000000000999', card_last4: '0000' }), src()])).rows[0].id;
      expect(await cardOf(c, forged)).toBeNull();
    });
  });

  it('two matching cards (or a card without bank plus one with it) stay unlinked: the user decides', async () => {
    await card(USER_A, '4821');
    await card(USER_A, '4821', null);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const id = (await c.query(INSERT, [tx(), src()])).rows[0].id;
      expect(await cardOf(c, id)).toBeNull();
      expect((await c.query('select status from public.transactions where id = $1', [id])).rows[0].status).toBe('review_required');
    });
  });

  it('A/B: B\'s card with the same digits never links A\'s movement', async () => {
    await card(USER_B, '4821');
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const id = (await c.query(INSERT, [tx(), src()])).rows[0].id;
      expect(await cardOf(c, id)).toBeNull();
    });    // Privileged server path (email webhook, no RLS): the user filter in the resolver is the only barrier.
    expect((await pool.query("select public.card_for_event($1, 'BCP', '4821') as id", [USER_A])).rows[0].id).toBeNull();
  });

  it('registering a card links past unlinked movements, audited, without touching type, amount or status', async () => {
    const ins = async (user: string, last4: string) => (await pool.query(`insert into public.transactions (user_id, occurred_at, type,
      direction, amount_minor, currency, institution_code, card_last4, status, confidence, fingerprint)
      values ($1, now(), 'expense', 'outflow', 500, 'PEN', 'BCP', $2, 'review_required', 'medium', 'x') returning id`, [user, last4])).rows[0].id as string;
    const past = await ins(USER_A, '4821');
    const other = await ins(USER_A, '1111');
    const bTx = await ins(USER_B, '4821');
    const c1 = await card(USER_A, '4821');
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query('select public.link_card_history($1) as n', [c1])).rows[0].n).toBe(1);
      expect((await c.query('select public.link_card_history($1) as n', [c1])).rows[0].n).toBe(0); // idempotent
      expect(await cardOf(c, past)).toBe(c1);
      expect(await cardOf(c, other)).toBeNull();
      expect((await c.query('select type, amount_minor, status from public.transactions where id = $1', [past])).rows[0])
        .toEqual({ type: 'expense', amount_minor: '500', status: 'review_required' });
      const audit = (await c.query('select action, changes from public.audit_events where transaction_id = $1', [past])).rows;
      expect(audit).toEqual([{ action: 'card_link', changes: { card_id: { from: null, to: c1 } } }]);
    });
    expect((await pool.query('select card_id from public.transactions where id = $1', [bTx])).rows[0].card_id).toBeNull();
  });

  it('A/B: nobody can link with another user\'s card; anon cannot call it; the resolver is not exposed', async () => {
    const bCard = await card(USER_B, '4821');
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, 'select public.link_card_history($1)', [bCard])).toBe('not_found');
      expect(await errorCode(c, 'select public.card_for_event($1, $2, $3)', [USER_B, 'BCP', '4821'])).toBe('42501');
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, 'select public.link_card_history($1)', [bCard])).toBe('42501');
    });
  });
});
