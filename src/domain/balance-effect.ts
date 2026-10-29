import type { TransactionType } from './types';

/**
 * Where a confirmed movement moves money (ADR-0020). Sibling of `financialEffect()`, which still decides what counts
 * as income or spending; this one decides which BALANCE changes: an account (bank or cash) or a credit card's used
 * line. A credit card purchase is spending but leaves the accounts untouched until the card is paid; a card payment
 * or an own transfer is neither income nor spending but does move money between places. Pure.
 *
 *   income, deposit                  account +amount
 *   expense (debit / no card)        account −amount
 *   expense or purchase, credit card card used +amount (accounts untouched)
 *   credit_card_payment              paying account −amount · card used −amount
 *   internal_transfer                account −amount · destination account +amount
 *   withdrawal (ATM)                 account −amount · cash account +amount
 *   refund, reversal                 credit card used −amount, else account +amount
 *   unknown                          nothing (flagged)
 *
 * A destination the movement does not name is never guessed: it is reported as missing.
 */
export interface BalanceTx {
  type: TransactionType;
  amountMinor: number;
  accountId: string | null;
  counterpartyAccountId?: string | null;
  cardId: string | null;
  /** Kind of the card named by cardId, when the card is known. */
  cardKind?: 'credit' | 'debit' | null;
}

export interface BalanceDelta {
  /** Signed change per account id. */
  accounts: { accountId: string; deltaMinor: number }[];
  /** Signed change of a credit card's used line. */
  cardUsed: { cardId: string; deltaMinor: number } | null;
  /** What the movement does not say and the balance needs (never guessed). */
  missing: 'source_account' | 'transfer_destination' | 'cash_destination' | 'undetermined' | null;
}

export function balanceEffect(tx: BalanceTx): BalanceDelta {
  const a = tx.amountMinor;
  const credit = tx.cardId !== null && tx.cardKind === 'credit' ? tx.cardId : null;
  const acc = (sign: 1 | -1) => (tx.accountId ? [{ accountId: tx.accountId, deltaMinor: sign * a }] : []);
  const none: BalanceDelta = { accounts: [], cardUsed: null, missing: null };
  switch (tx.type) {
    case 'income':
    case 'deposit':
      return { ...none, accounts: acc(1), missing: tx.accountId ? null : 'source_account' };
    case 'expense':
    case 'credit_card_purchase':
      if (credit) return { ...none, cardUsed: { cardId: credit, deltaMinor: a } };
      return { ...none, accounts: acc(-1), missing: tx.accountId ? null : 'source_account' };
    case 'credit_card_payment':
      return { accounts: acc(-1), cardUsed: credit ? { cardId: credit, deltaMinor: -a } : null, missing: tx.accountId ? null : 'source_account' };
    case 'internal_transfer':
    case 'withdrawal': {
      // Without its source a move between own pockets moves nothing: +destination alone would create money.
      if (!tx.accountId) return { ...none, missing: 'source_account' };
      const to = tx.counterpartyAccountId ?? null;
      const accounts = [...acc(-1), ...(to ? [{ accountId: to, deltaMinor: a }] : [])];
      const missing = !tx.accountId ? 'source_account' : to ? null : tx.type === 'withdrawal' ? 'cash_destination' : 'transfer_destination';
      return { accounts, cardUsed: null, missing };
    }
    case 'refund':
    case 'reversal':
      if (credit) return { ...none, cardUsed: { cardId: credit, deltaMinor: -a } };
      return { ...none, accounts: acc(1), missing: tx.accountId ? null : 'source_account' };
    case 'unknown':
      return { ...none, missing: 'undetermined' };
  }
}
