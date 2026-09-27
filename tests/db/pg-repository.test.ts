import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ingestRawEvent, type UserContext } from '../../src/engine/ingest';
import { monthlySummary } from '../../src/engine/monthly-summary';
import { PgTransactionRepository } from '../../src/infrastructure/postgres/pg-transaction-repository';
import * as fx from '../fixtures/bcp';
import { DATABASE_URL, makePool, USER_A, USER_B } from './helpers';

const ctx = (userId: string): UserContext => ({ userId, ownAccountLast4: ['9001'], cards: [{ last4: '4821', kind: 'credit' }], merchantRules: [] });

describe.skipIf(!DATABASE_URL)('pipeline on PostgreSQL', () => {
  let pool: pg.Pool;
  let repo: PgTransactionRepository;

  beforeAll(async () => {
    pool = makePool();
    repo = new PgTransactionRepository(pool);
  });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('BCP event -> transaction row with provenance, category and Lima time', async () => {
    const r = await ingestRawEvent(fx.purchasePenEmail(), ctx(USER_A), repo);
    expect(r.outcome).toBe('created');
    const [tx] = await repo.listTransactions(USER_A);
    expect(tx).toMatchObject({
      type: 'credit_card_purchase', amountMinor: 10000, currency: 'PEN', category: 'Alimentación',
      occurredAt: '2026-09-15T20:30:00-05:00', status: 'confirmed',
    });
    expect(tx!.sources[0]).toMatchObject({ channel: 'email', parserVersion: 'BCP_EMAIL_V1', templateVerification: 'SYNTHETIC_UNVERIFIED' });
    const ev = await pool.query('select outcome, transaction_id from public.financial_events where user_id = $1', [USER_A]);
    expect(ev.rows).toEqual([{ outcome: 'created', transaction_id: tx!.id }]);
  });

  it('same event x5 sequentially -> ONE transaction', async () => {
    for (let i = 0; i < 5; i++) await ingestRawEvent(fx.purchasePenEmail(), ctx(USER_A), repo);
    expect(await repo.listTransactions(USER_A)).toHaveLength(1);
  });

  it('same event x5 CONCURRENTLY -> ONE transaction (DB unique constraint)', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => ingestRawEvent(fx.purchasePenSms(), ctx(USER_A), repo)));
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate_same_event')).toHaveLength(4);
    expect(await repo.listTransactions(USER_A)).toHaveLength(1);
  });

  it('race where every pre-check misses: the DB unique constraint still yields ONE transaction', async () => {
    // Deterministic worst case: the Level-1 pre-check never sees the concurrent winner.
    const blind = new PgTransactionRepository(pool);
    blind.findBySource = async () => null;
    const results = await Promise.all(Array.from({ length: 5 }, () => ingestRawEvent(fx.purchasePenSms(), ctx(USER_A), blind)));
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.detail === 'concurrent duplicate')).toHaveLength(4);
    expect(await repo.listTransactions(USER_A)).toHaveLength(1);
  });

  it('BCP EMAIL + BCP SMS -> ONE transaction / TWO sources', async () => {
    await ingestRawEvent(fx.purchasePenEmail(), ctx(USER_A), repo);
    expect((await ingestRawEvent(fx.purchasePenSms(), ctx(USER_A), repo)).outcome).toBe('merged_cross_source');
    const txs = await repo.listTransactions(USER_A);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.sources.map((s) => s.channel).sort()).toEqual(['email', 'sms']);
  });

  it('card purchase + card payment + ATM withdrawal: expenses = S/100', async () => {
    for (const raw of [fx.purchasePenEmail(), fx.cardPaymentEmail(), fx.withdrawalEmail()]) await ingestRawEvent(raw, ctx(USER_A), repo);
    const s = monthlySummary(await repo.listTransactions(USER_A), '2026-09', 'PEN');
    expect(s.expensesMinor).toBe(10000);
    expect(s.cashWithdrawalsMinor).toBe(20000);
  });

  it('refund links to original across the DB', async () => {
    const { transactionId } = await ingestRawEvent(fx.purchasePenEmail(), ctx(USER_A), repo);
    await ingestRawEvent(fx.refundEmail('40.00'), ctx(USER_A), repo);
    const refund = (await repo.listTransactions(USER_A)).find((t) => t.type === 'refund');
    expect(refund!.originalTransactionId).toBe(transactionId);
  });

  it('dedupe is per user: same message for A and B -> one each', async () => {
    await ingestRawEvent(fx.purchasePenEmail(), ctx(USER_A), repo);
    expect((await ingestRawEvent(fx.purchasePenEmail(), ctx(USER_B), repo)).outcome).toBe('created');
    expect(await repo.listTransactions(USER_B)).toHaveLength(1);
  });

  it('unresolved and non-transactional events are traced without transactions', async () => {
    await ingestRawEvent(fx.malformedEmail(), ctx(USER_A), repo);
    const { rows } = await pool.query('select outcome, parser_version from public.financial_events where user_id = $1', [USER_A]);
    expect(rows).toEqual([{ outcome: 'unresolved', parser_version: 'BCP_EMAIL_V1' }]);
    expect(await repo.listTransactions(USER_A)).toHaveLength(0);
  });
});
