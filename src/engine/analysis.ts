import type { Currency } from '../domain/money';
import { financialEffect } from '../domain/financial-effect';
import type { Transaction } from '../domain/types';
import { monthlySummary, type MonthlySummary } from './monthly-summary';

/** "2026-09" -> "2026-08" (calendar months, no time zone involved). */
export function previousMonth(month: string, n = 1): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) - n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export interface MonthComparison {
  current: MonthlySummary;
  previous: MonthlySummary;
  expensesDeltaMinor: number;
  incomeDeltaMinor: number;
  netDeltaMinor: number;
  /** Per category: this month, previous month, difference (confirmed movements only). */
  categories: Array<{ category: string; currentMinor: number; previousMinor: number; deltaMinor: number }>;
}

/** Month vs previous month, driven by monthlySummary (so financialEffect rules apply identically). */
export function compareMonths(txs: readonly Transaction[], month: string, currency: Currency): MonthComparison {
  const current = monthlySummary(txs, month, currency);
  const previous = monthlySummary(txs, previousMonth(month), currency);
  const names = new Set([...Object.keys(current.expensesByCategory), ...Object.keys(previous.expensesByCategory)]);
  const categories = [...names].map((category) => {
    const c = current.expensesByCategory[category] ?? 0;
    const p = previous.expensesByCategory[category] ?? 0;
    return { category, currentMinor: c, previousMinor: p, deltaMinor: c - p };
  }).sort((a, b) => b.currentMinor - a.currentMinor || b.previousMinor - a.previousMinor);
  return {
    current, previous, categories,
    expensesDeltaMinor: current.expensesMinor - previous.expensesMinor,
    incomeDeltaMinor: current.incomeMinor - previous.incomeMinor,
    netDeltaMinor: current.netCashFlowMinor - previous.netCashFlowMinor,
  };
}

/** Last `n` months ending at `month` (oldest first). */
export function monthlyTrend(txs: readonly Transaction[], month: string, currency: Currency, n = 6): MonthlySummary[] {
  return Array.from({ length: n }, (_, i) => monthlySummary(txs, previousMonth(month, n - 1 - i), currency));
}

export interface MerchantTotal { merchant: string; totalMinor: number; count: number }

/** Where the money went: confirmed spending per merchant (refunds reduce it), largest first. */
export function topMerchants(txs: readonly Transaction[], month: string, currency: Currency, limit = 5): MerchantTotal[] {
  const by = new Map<string, MerchantTotal>();
  for (const t of txs) {
    if (t.currency !== currency || t.occurredAt.slice(0, 7) !== month || t.status !== 'confirmed') continue;
    const effect = financialEffect(t.type);
    if (effect !== 'expense' && effect !== 'expense_reduction') continue;
    const merchant = t.merchantNormalized ?? t.merchantRaw ?? 'Sin comercio';
    const e = by.get(merchant) ?? { merchant, totalMinor: 0, count: 0 };
    e.totalMinor += effect === 'expense' ? t.amountMinor : -t.amountMinor;
    e.count += effect === 'expense' ? 1 : 0;
    by.set(merchant, e);
  }
  return [...by.values()].filter((m) => m.totalMinor > 0).sort((a, b) => b.totalMinor - a.totalMinor).slice(0, limit);
}
