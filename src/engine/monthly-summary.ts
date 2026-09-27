import type { Currency } from '../domain/money';
import type { Transaction } from '../domain/types';
import { financialEffect, type FinancialEffectOptions } from '../domain/financial-effect';

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
 * Metrics are driven by financialEffect(): card purchase = expense; card payment, internal
 * transfer and ATM withdrawal (transfer_to_cash, ADR-0002) are NOT expenses; refunds/reversals
 * reduce expenses and are never income. Currencies are never mixed (no FX here).
 */
export function monthlySummary(
  txs: readonly Transaction[],
  month: string,
  currency: Currency,
  opts: FinancialEffectOptions = {},
): MonthlySummary {
  const s: MonthlySummary = {
    month, currency, incomeMinor: 0, expensesMinor: 0, netCashFlowMinor: 0, cashWithdrawalsMinor: 0,
    pendingCount: 0, savingsLabel: 'confirmed', expensesByCategory: {},
  };
  const addCategory = (cat: string, delta: number) => { s.expensesByCategory[cat] = (s.expensesByCategory[cat] ?? 0) + delta; };
  for (const t of txs) {
    if (t.currency !== currency || t.occurredAt.slice(0, 7) !== month) continue;
    if (t.status === 'ignored') continue;
    if (t.status !== 'confirmed') { s.pendingCount++; continue; }
    const cat = t.category ?? (t.type === 'withdrawal' ? 'Efectivo' : 'Otros');
    switch (financialEffect(t.type, opts)) {
      case 'income':
        s.incomeMinor += t.amountMinor; break;
      case 'expense':
        s.expensesMinor += t.amountMinor; addCategory(cat, t.amountMinor); break;
      case 'expense_reduction':
        s.expensesMinor -= t.amountMinor; addCategory(cat, -t.amountMinor); break;
      case 'transfer_to_cash':
        s.cashWithdrawalsMinor += t.amountMinor; break;
      case 'internal_movement':
      case 'undetermined':
        break;
    }
  }
  s.netCashFlowMinor = s.incomeMinor - s.expensesMinor;
  s.savingsLabel = s.pendingCount === 0 ? 'confirmed' : 'estimated';
  return s;
}
