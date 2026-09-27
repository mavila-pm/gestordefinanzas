import { beforeEach, describe, expect, it } from 'vitest';
import { financialEffect } from '../src/domain/financial-effect';
import { createManualTransaction } from '../src/engine/manual';
import { ingestRawEvent, type UserContext } from '../src/engine/ingest';
import { monthlySummary } from '../src/engine/monthly-summary';
import { InMemoryTransactionRepository } from '../src/engine/repository';
import { bcpAdapters } from '../src/ingestion/adapter-registry';
import * as fx from './fixtures/bcp';

const CTX: UserContext = { userId: 'u1', ownAccountLast4: [], cards: [{ last4: '4821', kind: 'credit' }], merchantRules: [] };
let repo: InMemoryTransactionRepository;
beforeEach(() => { repo = new InMemoryTransactionRepository(); });

describe('ADR-0002: WITHDRAWAL != EXPENSE', () => {
  it('ATM S/200 + cash taxi S/30 + cash lunch S/45 = S/75 of expenses, not S/275', async () => {
    const atm = await ingestRawEvent(fx.withdrawalEmail(), CTX, repo);
    expect(atm.outcome).toBe('created');
    const [w] = await repo.listTransactions('u1');
    expect(w).toMatchObject({ type: 'withdrawal', direction: 'outflow', category: null });
    expect(financialEffect('withdrawal')).toBe('transfer_to_cash');

    await createManualTransaction('u1', { type: 'expense', amount: '30', currency: 'PEN', occurredAt: '2026-09-12T20:00:00-05:00', description: 'Taxi', category: 'Transporte' }, repo);
    await createManualTransaction('u1', { type: 'expense', amount: '45.00', currency: 'PEN', occurredAt: '2026-09-13T13:00:00-05:00', description: 'Almuerzo', category: 'Alimentación' }, repo);

    const s = monthlySummary(await repo.listTransactions('u1'), '2026-09', 'PEN');
    expect(s.expensesMinor).toBe(7500);
    expect(s.cashWithdrawalsMinor).toBe(20000);
    expect(s.expensesByCategory).toEqual({ Transporte: 3000, 'Alimentación': 4500 });
  });

  it('future opt-in preference counts withdrawals as expense (default off)', async () => {
    await ingestRawEvent(fx.withdrawalEmail(), CTX, repo);
    const txs = await repo.listTransactions('u1');
    expect(monthlySummary(txs, '2026-09', 'PEN').expensesMinor).toBe(0);
    expect(monthlySummary(txs, '2026-09', 'PEN', { withdrawalsAsExpense: true }).expensesMinor).toBe(20000);
  });
});

describe('manual entry', () => {
  it('is confirmed, traced as MANUAL and never uses floats', async () => {
    const r = await createManualTransaction('u1', { type: 'income', amount: '5,500.00', currency: 'PEN', occurredAt: '2026-09-01T09:00:00-05:00' }, repo);
    expect(r.ok && r.transaction).toMatchObject({ amountMinor: 550000, direction: 'inflow', status: 'confirmed', category: null });
    expect(r.ok && r.transaction.sources[0]).toMatchObject({ channel: 'manual', parserVersion: 'MANUAL' });
  });

  it.each([
    ['float-like amount', { amount: '12.345' }],
    ['negative amount', { amount: '-10' }],
    ['number instead of string', { amount: 10 }],
    ['bad currency', { currency: 'EUR' }],
    ['bad date', { occurredAt: '12/09/2026' }],
    ['bad type', { type: 'unknown' }],
    ['bad category', { category: 'Casino' }],
  ])('rejects %s', async (_n, patch) => {
    const base = { type: 'expense', amount: '10', currency: 'PEN', occurredAt: '2026-09-12T20:00:00-05:00' };
    const r = await createManualTransaction('u1', { ...base, ...patch } as never, repo);
    expect(r.ok).toBe(false);
    expect(await repo.listTransactions('u1')).toHaveLength(0);
  });
});

describe('card kind resolution', () => {
  const op = () => fx.bcpEmail({
    id: '<op-1@mail.test>', subject: 'Notificación de operación con tu tarjeta',
    lines: ['Se realizó una operación con tu tarjeta terminada en ****4821.', 'Operación: Consumo', 'Establecimiento: UBER TRIP', 'Monto: S/ 18.90', 'Fecha: 22/09/2026', 'Hora: 08:10'],
  });

  it('registered credit card -> credit_card_purchase, confirmed', async () => {
    await ingestRawEvent(op(), CTX, repo);
    expect((await repo.listTransactions('u1'))[0]).toMatchObject({ type: 'credit_card_purchase', status: 'confirmed', category: 'Transporte' });
  });

  it('registered debit card -> expense, confirmed', async () => {
    await ingestRawEvent(op(), { ...CTX, cards: [{ last4: '4821', kind: 'debit' }] }, repo);
    expect((await repo.listTransactions('u1'))[0]).toMatchObject({ type: 'expense', status: 'confirmed' });
  });

  it('unregistered card -> review_required (still counted once confirmed by the user)', async () => {
    await ingestRawEvent(op(), { ...CTX, cards: [] }, repo);
    expect((await repo.listTransactions('u1'))[0]).toMatchObject({ type: 'expense', status: 'review_required' });
  });

  it('operation kinds other than Consumo are not guessed', async () => {
    const raw = op();
    raw.body = raw.body.replace('Operación: Consumo', 'Operación: Disposición de efectivo');
    expect((await ingestRawEvent(raw, CTX, repo)).outcome).toBe('unresolved');
  });
});

describe('template evidence labels', () => {
  it('no BCP parser claims VERIFIED until real transactional samples exist', () => {
    for (const a of bcpAdapters) expect(a.templateVerification).toBe('SYNTHETIC_UNVERIFIED');
  });

  it('every automatic transaction records the evidence level of its parser', async () => {
    await ingestRawEvent(fx.purchasePenEmail(), CTX, repo);
    expect((await repo.listTransactions('u1'))[0]!.sources[0]!.templateVerification).toBe('SYNTHETIC_UNVERIFIED');
  });
});
