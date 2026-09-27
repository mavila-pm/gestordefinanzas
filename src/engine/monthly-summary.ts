import type { Currency } from '../domain/money';
import type { Transaction } from '../domain/types';

export interface MonthlySummary {
  month: string;
  currency: Currency;
  incomeMinor: number;
  expensesMinor: number;
  netCashFlowMinor: number;
  cashWithdrawalsMinor: number;
  /** Transactions not yet trusted (review_required / possible_duplicate). */
  pendingCount: number;
  /**
   * 'confirmed' only when nothing is pending; otherwise the figure is an estimate (§39).
   */
  savingsLabel: 'confirmed' | 'estimated';
  expensesByCategory: Record<string, number>;
}

/**
 * Card purchase = expense. Card payment, internal transfer and withdrawals are NOT expenses.
 * Refunds/reversals reduce expenses; they are never ordinary income.
 * Currencies are never mixed: FX conversion is out of scope for this function.
 */
export function monthlySummary(txs: readonly Transaction[], month: string, currency: Currency): MonthlySummary {
  const s: MonthlySummary = {
    month, currency, incomeMinor: 0, expensesMinor: 0, netCashFlowMinor: 0, cashWithdrawalsMinor: 0,
    pendingCount: 0, savingsLabel: 'confirmed', expensesByCategory: {},
  };
  for (const t of txs) {
    if (t.currency !== currency || t.occurredAt.slice(0, 7) !== month) continue;
    if (t.status === 'ignored') continue;
    if (t.status !== 'confirmed') { s.pendingCount++; continue; }
    const cat = t.category ?? 'Otros';
    switch (t.type) {
      case 'income':
      case 'deposit':
        s.incomeMinor += t.amountMinor; break;
      case 'expense':
      case 'credit_card_purchase':
        s.expensesMinor += t.amountMinor;
        s.expensesByCategory[cat] = (s.expensesByCategory[cat] ?? 0) + t.amountMinor; break;
      case 'refund':
      case 'reversal':
        s.expensesMinor -= t.amountMinor;
        s.expensesByCategory[cat] = (s.expensesByCategory[cat] ?? 0) - t.amountMinor; break;
      case 'withdrawal':
        s.cashWithdrawalsMinor += t.amountMinor; break;
      case 'credit_card_payment':
      case 'internal_transfer':
      case 'unknown':
        break;
    }
  }
  s.netCashFlowMinor = s.incomeMinor - s.expensesMinor;
  s.savingsLabel = s.pendingCount === 0 ? 'confirmed' : 'estimated';
  return s;
}
