import type { TransactionType } from './types';

/**
 * How a transaction type affects the user's financial metrics. This is the single place
 * that decides it; calculations must not re-derive meaning from `type`.
 *
 * - expense            counts as spending
 * - income             counts as income
 * - expense_reduction  refund/reversal: reduces spending, never income
 * - transfer_to_cash   ATM withdrawal: money changes location, net worth unchanged (ADR-0002)
 * - internal_movement  card payment / own-account transfer: not income nor spending
 * - undetermined       not enough information; excluded until reviewed
 */
export type FinancialEffect =
  | 'expense'
  | 'income'
  | 'expense_reduction'
  | 'transfer_to_cash'
  | 'internal_movement'
  | 'undetermined';

export interface FinancialEffectOptions {
  /**
   * FUTURE optional user preference (ADR-0002): "Considerar retiros de efectivo como gasto".
   * Default false. Not exposed in UI yet.
   */
  withdrawalsAsExpense?: boolean;
}

const EFFECTS: Record<TransactionType, FinancialEffect> = {
  expense: 'expense',
  credit_card_purchase: 'expense',
  income: 'income',
  deposit: 'income',
  refund: 'expense_reduction',
  reversal: 'expense_reduction',
  withdrawal: 'transfer_to_cash',
  credit_card_payment: 'internal_movement',
  internal_transfer: 'internal_movement',
  unknown: 'undetermined',
};

export function financialEffect(type: TransactionType, opts: FinancialEffectOptions = {}): FinancialEffect {
  if (type === 'withdrawal' && opts.withdrawalsAsExpense) return 'expense';
  return EFFECTS[type];
}
