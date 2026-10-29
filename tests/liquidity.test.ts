import { describe, expect, it } from 'vitest';
import { balanceEffect } from '../src/domain/balance-effect';
import { financialEffect } from '../src/domain/financial-effect';
import { cardUsed, liquidity, type LiquidityAccount, type LiquidityTx } from '../src/engine/liquidity';

const acc = (id: string, kind: 'bank' | 'cash' = 'bank', currency: 'PEN' | 'USD' = 'PEN'): LiquidityAccount => ({ id, alias: id, kind, currency, active: true });
let n = 0;
const tx = (o: Partial<LiquidityTx>): LiquidityTx => ({
  id: `t${n++}`, type: 'expense', status: 'confirmed', amountMinor: 1000, currency: 'PEN', occurredAt: '2026-10-27T12:00:00-05:00',
  accountId: null, counterpartyAccountId: null, cardId: null, ...o,
});
const cp = (ownerId: string, amountMinor: number, asOf = '2026-10-27T09:00:00-05:00') => ({ ownerId, amountMinor, asOf });
const run = (o: Partial<Parameters<typeof liquidity>[0]>) => liquidity({ currency: 'PEN', accounts: [], checkpoints: [], txs: [], cards: [], declared: null, ...o });

describe('balanceEffect: which balance a movement moves', () => {
  it('maps every type × instrument', () => {
    const b = (o: Parameters<typeof balanceEffect>[0]) => balanceEffect(o);
    expect(b({ type: 'income', amountMinor: 5, accountId: 'A', cardId: null })).toEqual({ accounts: [{ accountId: 'A', deltaMinor: 5 }], cardUsed: null, missing: null });
    expect(b({ type: 'expense', amountMinor: 5, accountId: 'A', cardId: 'D', cardKind: 'debit' }).accounts).toEqual([{ accountId: 'A', deltaMinor: -5 }]);
    // Credit purchase: spending, but accounts untouched until the card is paid.
    expect(b({ type: 'credit_card_purchase', amountMinor: 5, accountId: null, cardId: 'C', cardKind: 'credit' })).toEqual({ accounts: [], cardUsed: { cardId: 'C', deltaMinor: 5 }, missing: null });
    expect(b({ type: 'expense', amountMinor: 5, accountId: null, cardId: 'C', cardKind: 'credit' }).cardUsed).toEqual({ cardId: 'C', deltaMinor: 5 });
    // Card payment: −account, −used. Not a second expense.
    expect(b({ type: 'credit_card_payment', amountMinor: 5, accountId: 'A', cardId: 'C', cardKind: 'credit' }))
      .toEqual({ accounts: [{ accountId: 'A', deltaMinor: -5 }], cardUsed: { cardId: 'C', deltaMinor: -5 }, missing: null });
    expect(financialEffect('credit_card_payment')).toBe('internal_movement');
    expect(b({ type: 'internal_transfer', amountMinor: 5, accountId: 'A', counterpartyAccountId: 'B', cardId: null }).accounts)
      .toEqual([{ accountId: 'A', deltaMinor: -5 }, { accountId: 'B', deltaMinor: 5 }]);
    expect(b({ type: 'internal_transfer', amountMinor: 5, accountId: 'A', cardId: null }).missing).toBe('transfer_destination');
    expect(b({ type: 'withdrawal', amountMinor: 5, accountId: 'A', counterpartyAccountId: 'CASH', cardId: null }).accounts)
      .toEqual([{ accountId: 'A', deltaMinor: -5 }, { accountId: 'CASH', deltaMinor: 5 }]);
    expect(b({ type: 'withdrawal', amountMinor: 5, accountId: 'A', cardId: null }).missing).toBe('cash_destination');
    expect(b({ type: 'refund', amountMinor: 5, accountId: null, cardId: 'C', cardKind: 'credit' }).cardUsed).toEqual({ cardId: 'C', deltaMinor: -5 });
    expect(b({ type: 'refund', amountMinor: 5, accountId: 'A', cardId: null }).accounts).toEqual([{ accountId: 'A', deltaMinor: 5 }]);
    expect(b({ type: 'unknown', amountMinor: 5, accountId: 'A', cardId: null })).toEqual({ accounts: [], cardUsed: null, missing: 'undetermined' });
  });
});

describe('liquidity from accounts', () => {
  it('opening balance + movements after it; movements before the checkpoint are already inside it', () => {
    const l = run({
      accounts: [acc('A')], checkpoints: [cp('A', 150000)],
      txs: [
        tx({ accountId: 'A', amountMinor: 3000 }), // after: −30
        tx({ type: 'income', accountId: 'A', amountMinor: 500000 }), // after: +5000
        tx({ accountId: 'A', amountMinor: 9999, occurredAt: '2026-10-26T12:00:00-05:00' }), // before: ignored
      ],
    });
    expect(l).toMatchObject({ source: 'accounts', totalMinor: 647000, bankMinor: 647000, cashMinor: null, status: 'complete' });
  });

  it('a newer checkpoint replaces the older one (a correction is a new "saldo al")', () => {
    const l = run({ accounts: [acc('A')], checkpoints: [cp('A', 100), cp('A', 70000, '2026-10-27T13:00:00-05:00')], txs: [tx({ accountId: 'A', amountMinor: 1000 })] });
    expect(l.totalMinor).toBe(70000); // the 12:00 expense happened before the 13:00 balance
  });

  it('pending review does not count yet and is reported', () => {
    const l = run({ accounts: [acc('A')], checkpoints: [cp('A', 10000)], txs: [tx({ accountId: 'A', status: 'review_required' }), tx({ accountId: 'A', status: 'possible_duplicate' })] });
    expect(l).toMatchObject({ totalMinor: 10000, pendingCount: 2 });
  });

  it('PEN ≠ USD: a dollar movement never touches soles; each currency stands alone', () => {
    const accounts = [acc('S'), acc('D', 'bank', 'USD')];
    const checkpoints = [cp('S', 10000), cp('D', 5000)];
    const txs = [tx({ accountId: 'D', currency: 'USD', amountMinor: 1000 }), tx({ accountId: 'S', currency: 'USD', amountMinor: 777 })];
    expect(run({ accounts, checkpoints, txs }).totalMinor).toBe(10000);
    expect(run({ currency: 'USD', accounts, checkpoints, txs }).totalMinor).toBe(4000);
  });

  it('own transfer: −A +B, total unchanged; without destination: −A and asked', () => {
    const accounts = [acc('A'), acc('B')];
    const checkpoints = [cp('A', 10000), cp('B', 0)];
    const moved = run({ accounts, checkpoints, txs: [tx({ type: 'internal_transfer', accountId: 'A', counterpartyAccountId: 'B', amountMinor: 4000 })] });
    expect(moved.accounts.map((a) => a.balanceMinor)).toEqual([6000, 4000]);
    expect(moved.totalMinor).toBe(10000);
    const unknownDest = run({ accounts, checkpoints, txs: [tx({ id: 'tr', type: 'internal_transfer', accountId: 'A', amountMinor: 4000 })] });
    expect(unknownDest.totalMinor).toBe(6000);
    expect(unknownDest).toMatchObject({ status: 'partial', missing: [{ code: 'transfer_destination', txId: 'tr', amountMinor: 4000 }] });
  });

  it('ATM S/200 then S/30 + S/45 in cash: liquidity drops only by what was spent; spending stays S/75', () => {
    const accounts = [acc('A'), acc('CASH', 'cash')];
    const txs = [
      tx({ type: 'withdrawal', accountId: 'A', counterpartyAccountId: 'CASH', amountMinor: 20000 }),
      tx({ accountId: 'CASH', amountMinor: 3000 }), tx({ accountId: 'CASH', amountMinor: 4500 }),
    ];
    const l = run({ accounts, checkpoints: [cp('A', 100000), cp('CASH', 0)], txs });
    expect(l).toMatchObject({ totalMinor: 92500, bankMinor: 80000, cashMinor: 12500 });
    const spent = txs.filter((t) => financialEffect(t.type) === 'expense').reduce((s, t) => s + t.amountMinor, 0);
    expect(spent).toBe(7500);
  });

  it('credit card purchase leaves liquidity; paying the card lowers it once (no second expense)', () => {
    const cards = [{ id: 'C', kind: 'credit' as const, currency: 'PEN' as const }];
    const txs = [tx({ type: 'credit_card_purchase', cardId: 'C', amountMinor: 30000 }), tx({ type: 'credit_card_payment', accountId: 'A', cardId: 'C', amountMinor: 30000, occurredAt: '2026-10-27T15:00:00-05:00' })];
    expect(run({ accounts: [acc('A')], checkpoints: [cp('A', 100000)], cards, txs }).totalMinor).toBe(70000);
    expect(run({ accounts: [acc('A')], checkpoints: [cp('A', 100000)], cards, txs: txs.slice(0, 1) }).totalMinor).toBe(100000);
  });

  it('unknown ≠ 0: an account without balance is missing, never counted as zero', () => {
    const l = run({ accounts: [acc('A'), acc('B')], checkpoints: [cp('A', 5000)] });
    expect(l).toMatchObject({ totalMinor: 5000, status: 'partial', missing: [{ code: 'account_balance', accountId: 'B' }] });
    expect(l.accounts[1]?.balanceMinor).toBeNull();
    expect(run({ accounts: [acc('A')] })).toMatchObject({ source: null, totalMinor: null, status: 'unknown' });
  });

  it('falls back to the declared total and never adds both sources', () => {
    const declared = { currency: 'PEN' as const, amountMinor: 415000, bankMinor: 400000, cashMinor: 15000, asOf: '2026-10-01T00:00:00-05:00' };
    expect(run({ declared })).toMatchObject({ source: 'declared', totalMinor: 415000, cashMinor: 15000 });
    expect(run({ declared, accounts: [acc('A')], checkpoints: [cp('A', 1000)] })).toMatchObject({ source: 'accounts', totalMinor: 1000 });
    expect(run({ declared: { ...declared, currency: 'USD' } }).source).toBeNull();
  });

  it('a confirmed movement with no account after the balances makes it partial, never silently complete', () => {
    const l = run({ accounts: [acc('CASH', 'cash')], checkpoints: [cp('CASH', 50000)], txs: [tx({ amountMinor: 20000 }), tx({ type: 'income', amountMinor: 1000 })] });
    expect(l).toMatchObject({ totalMinor: 50000, status: 'partial', missing: [{ code: 'unassigned', count: 2, amountMinor: 21000 }] });
    // A credit card purchase names no account on purpose: it is not "unassigned".
    const card = run({ accounts: [acc('A')], checkpoints: [cp('A', 100)], cards: [{ id: 'C', kind: 'credit', currency: 'PEN' }], txs: [tx({ type: 'credit_card_purchase', cardId: 'C' })] });
    expect(card.status).toBe('complete');
    // Before the first balance it is already inside it.
    expect(run({ accounts: [acc('A')], checkpoints: [cp('A', 100)], txs: [tx({ occurredAt: '2026-10-01T00:00:00-05:00' })] }).status).toBe('complete');
  });

  it('a truncated read is flagged; a checkpoint in another currency than its account never counts', () => {
    expect(run({ accounts: [acc('A')], checkpoints: [cp('A', 100)], truncated: true })).toMatchObject({ status: 'partial', missing: [{ code: 'truncated' }] });
    expect(run({ accounts: [acc('A')], checkpoints: [{ ...cp('A', 100), currency: 'USD' }] }).source).toBeNull();
  });

  it('a withdrawal without its source never adds cash (no money created); it is reported as unassigned', () => {
    const l = run({ accounts: [acc('A'), acc('CASH', 'cash')], checkpoints: [cp('A', 100000), cp('CASH', 0)],
      txs: [tx({ type: 'withdrawal', accountId: null, counterpartyAccountId: 'CASH', amountMinor: 20000 })] });
    expect(l).toMatchObject({ totalMinor: 100000, cashMinor: 0, status: 'partial', missing: [{ code: 'unassigned', count: 1, amountMinor: 20000 }] });
  });

  it('inactive accounts are left out', () => {
    expect(run({ accounts: [{ ...acc('A'), active: false }], checkpoints: [cp('A', 1000)] }).source).toBeNull();
  });
});

describe('cardUsed', () => {
  const card = { id: 'C', currency: 'PEN' as const, creditLimitMinor: 500000 };
  it('used today = checkpoint + purchases − payments after it; available = línea − used', () => {
    const txs = [
      tx({ type: 'credit_card_purchase', cardId: 'C', amountMinor: 20000 }),
      tx({ type: 'credit_card_payment', cardId: 'C', accountId: 'A', amountMinor: 50000 }),
      tx({ type: 'credit_card_purchase', cardId: 'C', amountMinor: 999, occurredAt: '2026-10-01T00:00:00-05:00' }), // before
      tx({ type: 'credit_card_purchase', cardId: 'C', amountMinor: 999, currency: 'USD' }), // other currency
    ];
    expect(cardUsed(card, [cp('C', 120000)], txs)).toEqual({ usedMinor: 90000, availableMinor: 410000, asOf: '2026-10-27T09:00:00-05:00' });
  });
  it('unknown without a checkpoint; never negative available', () => {
    expect(cardUsed(card, [], [])).toEqual({ usedMinor: null, availableMinor: null, asOf: null });
    expect(cardUsed({ ...card, creditLimitMinor: 100 }, [cp('C', 500)], []).availableMinor).toBe(0);
  });
});
