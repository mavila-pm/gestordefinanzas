import { beforeEach, describe, expect, it } from 'vitest';
import { ingestRawEvent, type UserContext } from '../src/engine/ingest';
import { InMemoryTransactionRepository } from '../src/engine/repository';
import { monthlySummary } from '../src/engine/monthly-summary';
import * as fx from './fixtures/bcp';

const USER_A: UserContext = { userId: 'user-a', ownAccountLast4: ['9001'], merchantRules: [] };
const USER_B: UserContext = { userId: 'user-b', ownAccountLast4: [], merchantRules: [] };
const SEP = '2026-09';

let repo: InMemoryTransactionRepository;
beforeEach(() => { repo = new InMemoryTransactionRepository(); });

describe('vertical slice: BCP event -> transaction -> summary', () => {
  it('creates one confirmed, categorized transaction with traceability', async () => {
    const r = await ingestRawEvent(fx.purchasePenEmail(), USER_A, repo);
    expect(r.outcome).toBe('created');
    const [tx] = await repo.listTransactions('user-a');
    expect(tx).toMatchObject({
      status: 'confirmed', confidence: 'high', type: 'credit_card_purchase', institution: 'BCP',
      merchantNormalized: 'RESTAURANTE EL EJEMPLO', category: 'Alimentación', amountMinor: 10000,
    });
    expect(tx!.sources).toEqual([expect.objectContaining({ channel: 'email', parserVersion: 'BCP_EMAIL_V1', externalEventId: '<purchase-pen-1@mail.test>' })]);
    expect(tx!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(monthlySummary(await repo.listTransactions('user-a'), SEP, 'PEN').expensesMinor).toBe(10000);
  });
});

describe('idempotency and deduplication', () => {
  it('processing the same event 5 times yields ONE transaction', async () => {
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push((await ingestRawEvent(fx.purchasePenEmail(), USER_A, repo)).outcome);
    expect(outcomes).toEqual(['created', 'duplicate_same_event', 'duplicate_same_event', 'duplicate_same_event', 'duplicate_same_event']);
    expect(await repo.listTransactions('user-a')).toHaveLength(1);
  });

  it('same SMS 5 times (no provider id) yields ONE transaction', async () => {
    for (let i = 0; i < 5; i++) await ingestRawEvent(fx.purchasePenSms(), USER_A, repo);
    expect(await repo.listTransactions('user-a')).toHaveLength(1);
  });

  it('BCP EMAIL S/100 + BCP SMS S/100 = ONE TRANSACTION / TWO SOURCES', async () => {
    await ingestRawEvent(fx.purchasePenEmail(), USER_A, repo);
    const r = await ingestRawEvent(fx.purchasePenSms(), USER_A, repo);
    expect(r.outcome).toBe('merged_cross_source');
    const txs = await repo.listTransactions('user-a');
    expect(txs).toHaveLength(1);
    expect(txs[0]!.sources.map((s) => s.channel).sort()).toEqual(['email', 'sms']);
    expect(monthlySummary(txs, SEP, 'PEN').expensesMinor).toBe(10000);
  });

  it('SMS first, then email: still one transaction', async () => {
    await ingestRawEvent(fx.purchasePenSms(), USER_A, repo);
    await ingestRawEvent(fx.purchasePenEmail(), USER_A, repo);
    expect(await repo.listTransactions('user-a')).toHaveLength(1);
  });

  it('same bank operation forwarded twice (different Message-IDs) is one transaction', async () => {
    await ingestRawEvent(fx.purchasePenEmail('<orig@mail.test>'), USER_A, repo);
    const r = await ingestRawEvent(fx.purchasePenEmail('<fwd@mail.test>'), USER_A, repo);
    expect(r.outcome).toBe('duplicate_same_event');
    expect(await repo.listTransactions('user-a')).toHaveLength(1);
  });

  it('weak similarity never deletes a legitimate movement: it is flagged possible_duplicate', async () => {
    await ingestRawEvent(fx.purchasePenEmail('<coffee-1@mail.test>'), USER_A, repo);
    const second = fx.purchasePenEmail('<coffee-2@mail.test>');
    second.body = second.body.replace('000111', '000112');
    const r = await ingestRawEvent(second, USER_A, repo);
    expect(r.outcome).toBe('possible_duplicate');
    const txs = await repo.listTransactions('user-a');
    expect(txs).toHaveLength(2);
    expect(txs[1]).toMatchObject({ status: 'possible_duplicate', duplicateOfId: txs[0]!.id });
    // Not counted until the user decides.
    const s = monthlySummary(txs, SEP, 'PEN');
    expect(s.expensesMinor).toBe(10000);
    expect(s.savingsLabel).toBe('estimated');
  });

  it('deduplication is scoped per user', async () => {
    await ingestRawEvent(fx.purchasePenEmail(), USER_A, repo);
    const r = await ingestRawEvent(fx.purchasePenEmail(), USER_B, repo);
    expect(r.outcome).toBe('created');
    expect(await repo.listTransactions('user-a')).toHaveLength(1);
    expect(await repo.listTransactions('user-b')).toHaveLength(1);
  });
});

describe('financial correctness', () => {
  it('card purchase S/100 + card payment S/100 = S/100 of expense, not S/200', async () => {
    await ingestRawEvent(fx.purchasePenEmail(), USER_A, repo);
    await ingestRawEvent(fx.cardPaymentEmail(), USER_A, repo);
    const s = monthlySummary(await repo.listTransactions('user-a'), SEP, 'PEN');
    expect(s.expensesMinor).toBe(10000);
    expect(s.pendingCount).toBe(0);
  });

  it('transfer to own account is internal_transfer and does not change income/expenses', async () => {
    await ingestRawEvent(fx.transferEmail('9001'), USER_A, repo);
    const [tx] = await repo.listTransactions('user-a');
    expect(tx).toMatchObject({ type: 'internal_transfer', direction: 'neutral', status: 'confirmed' });
    const s = monthlySummary([tx!], SEP, 'PEN');
    expect([s.incomeMinor, s.expensesMinor]).toEqual([0, 0]);
  });

  it('transfer to an unknown account goes to review, not guessed as expense', async () => {
    await ingestRawEvent(fx.transferEmail('5555'), USER_A, repo);
    const [tx] = await repo.listTransactions('user-a');
    expect(tx).toMatchObject({ type: 'unknown', status: 'review_required' });
  });

  it('refund links to the original purchase and reduces expenses (never income)', async () => {
    const { transactionId: purchaseId } = await ingestRawEvent(fx.purchasePenEmail(), USER_A, repo);
    await ingestRawEvent(fx.refundEmail('40.00'), USER_A, repo);
    const txs = await repo.listTransactions('user-a');
    expect(txs.find((t) => t.type === 'refund')!.originalTransactionId).toBe(purchaseId);
    const s = monthlySummary(txs, SEP, 'PEN');
    expect(s.expensesMinor).toBe(6000);
    expect(s.incomeMinor).toBe(0);
    expect(s.expensesByCategory['Alimentación']).toBe(6000);
  });

  it('reversal cancels the purchase', async () => {
    await ingestRawEvent(fx.purchasePenEmail(), USER_A, repo);
    await ingestRawEvent(fx.reversalEmail(), USER_A, repo);
    const s = monthlySummary(await repo.listTransactions('user-a'), SEP, 'PEN');
    expect([s.expensesMinor, s.incomeMinor]).toEqual([0, 0]);
  });

  it('deposit of unknown origin is pending review; savings shown as estimated', async () => {
    await ingestRawEvent(fx.depositEmail(), USER_A, repo);
    const s = monthlySummary(await repo.listTransactions('user-a'), SEP, 'PEN');
    expect(s.incomeMinor).toBe(0);
    expect(s.pendingCount).toBe(1);
    expect(s.savingsLabel).toBe('estimated');
  });

  it('withdrawal is reported apart from expenses', async () => {
    await ingestRawEvent(fx.withdrawalEmail(), USER_A, repo);
    const s = monthlySummary(await repo.listTransactions('user-a'), SEP, 'PEN');
    expect([s.expensesMinor, s.cashWithdrawalsMinor]).toEqual([0, 20000]);
  });

  it('PEN and USD are never mixed', async () => {
    await ingestRawEvent(fx.purchasePenEmail(), USER_A, repo);
    await ingestRawEvent(fx.purchaseUsdEmail(), USER_A, repo);
    const txs = await repo.listTransactions('user-a');
    expect(monthlySummary(txs, SEP, 'PEN').expensesMinor).toBe(10000);
    expect(monthlySummary(txs, SEP, 'USD').expensesMinor).toBe(125099);
    expect(txs.find((t) => t.currency === 'USD')!.category).toBe('Ocio');
  });
});

describe('robustness', () => {
  it('a bad event never stops a sync; outcomes are traced', async () => {
    const batch = [fx.purchasePenEmail(), fx.malformedEmail(), fx.unknownTemplateEmail(), fx.cardPaymentEmail(), fx.withdrawalEmail()];
    const outcomes = [];
    for (const raw of batch) outcomes.push((await ingestRawEvent(raw, USER_A, repo)).outcome);
    expect(outcomes).toEqual(['created', 'unresolved', 'unresolved', 'created', 'created']);
    expect(repo.events).toHaveLength(5);
    expect(repo.events[1]).toMatchObject({ outcome: 'unresolved', parserVersion: 'BCP_EMAIL_V1', transactionId: null });
  });

  it('oversized payload is rejected', async () => {
    const raw = fx.purchasePenEmail();
    raw.body += 'x'.repeat(70 * 1024);
    expect((await ingestRawEvent(raw, USER_A, repo)).outcome).toBe('rejected');
  });

  it('non-bank message is not_financial', async () => {
    const raw = { channel: 'sms' as const, sender: 'MAMA', body: 'Hola hijo, ¿vienes a almorzar?', receivedAt: '2026-09-16T01:31:00Z' };
    expect((await ingestRawEvent(raw, USER_A, repo)).outcome).toBe('not_financial');
  });

  it('user merchant rule wins over global rule', async () => {
    const ctx = { ...USER_A, merchantRules: [{ contains: 'Restaurante el Ejemplo', category: 'Personal' as const }] };
    await ingestRawEvent(fx.purchasePenEmail(), ctx, repo);
    expect((await repo.listTransactions('user-a'))[0]!.category).toBe('Personal');
  });
});
