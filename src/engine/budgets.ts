import type { Currency } from '../domain/money';
import type { Transaction } from '../domain/types';
import { monthlySummary } from './monthly-summary';

export interface Budget { category: string; currency: Currency; amountMinor: number }
export interface BudgetStatus extends Budget { spentMinor: number; remainingMinor: number; ratio: number; state: 'ok' | 'warning' | 'exceeded' }

export const WARNING_RATIO = 0.8;

/** Spending per budgeted category for a month, computed with the same rules as the dashboard (confirmed only). */
export function budgetStatus(txs: readonly Transaction[], month: string, budgets: readonly Budget[]): BudgetStatus[] {
  const byCurrency = new Map<Currency, Record<string, number>>();
  return budgets.map((b): BudgetStatus => {
    if (!byCurrency.has(b.currency)) byCurrency.set(b.currency, monthlySummary(txs, month, b.currency).expensesByCategory);
    const spent = Math.max(0, byCurrency.get(b.currency)![b.category] ?? 0);
    const ratio = spent / b.amountMinor;
    return { ...b, spentMinor: spent, remainingMinor: b.amountMinor - spent, ratio, state: ratio > 1 ? 'exceeded' : ratio >= WARNING_RATIO ? 'warning' : 'ok' };
  }).sort((a, b) => b.ratio - a.ratio);
}
