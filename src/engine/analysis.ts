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

/**
 * Where the money came from: confirmed income per source (the movement's name), largest first, with its share.
 * It says how much entered from each source, not how much each one leaves: that needs its costs, which are not tracked.
 */
export function incomeSources(txs: readonly Transaction[], month: string, currency: Currency, limit = 5): Array<MerchantTotal & { ratio: number }> {
  const by = new Map<string, MerchantTotal>();
  for (const t of txs) {
    if (t.currency !== currency || t.occurredAt.slice(0, 7) !== month || t.status !== 'confirmed' || financialEffect(t.type) !== 'income') continue;
    const merchant = t.merchantNormalized ?? t.merchantRaw ?? 'Sin nombre';
    const e = by.get(merchant) ?? { merchant, totalMinor: 0, count: 0 };
    e.totalMinor += t.amountMinor; e.count += 1;
    by.set(merchant, e);
  }
  const total = [...by.values()].reduce((s, m) => s + m.totalMinor, 0);
  return [...by.values()].sort((a, b) => b.totalMinor - a.totalMinor).slice(0, limit).map((m) => ({ ...m, ratio: m.totalMinor / total }));
}

/** Change in percent, rounded; null when there is no base to compare with (a new category is not "+∞%"). */
export function percentChange(currentMinor: number, previousMinor: number): number | null {
  return previousMinor > 0 ? Math.round(((currentMinor - previousMinor) / previousMinor) * 100) : null;
}

/** Share of income kept this month (net / income), in percent; null without income. Never invented. */
export function savingsRate(s: Pick<MonthlySummary, 'incomeMinor' | 'netCashFlowMinor'>): number | null {
  return s.incomeMinor > 0 ? Math.round((s.netCashFlowMinor / s.incomeMinor) * 100) : null;
}

/** Progress of a monthly savings goal: what was kept this month (never below 0) against the goal the person set. */
export function savingsProgress(netMinor: number, goalMinor: number | null): { savedMinor: number; ratio: number } | null {
  if (!goalMinor || goalMinor <= 0) return null;
  const savedMinor = Math.max(0, netMinor);
  return { savedMinor, ratio: Math.min(1, savedMinor / goalMinor) };
}

/**
 * "Alimentación subió 21%." — deterministic lines from the month comparison: only categories with a base last month,
 * a change of at least 15% and S/ 50 (5,000 minor), largest change in money first. At most `limit`.
 */
export function relevantChanges(cmp: Pick<MonthComparison, 'categories'>, limit = 3): Array<{ category: string; pct: number; deltaMinor: number; text: string }> {
  return cmp.categories
    .map((c) => ({ ...c, pct: percentChange(c.currentMinor, c.previousMinor) }))
    .filter((c): c is typeof c & { pct: number } => c.pct !== null && Math.abs(c.pct) >= 15 && Math.abs(c.deltaMinor) >= 5_000)
    .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor))
    .slice(0, limit)
    .map((c) => ({ category: c.category, pct: c.pct, deltaMinor: c.deltaMinor, text: `${c.category} ${c.pct > 0 ? 'subió' : 'bajó'} ${Math.abs(c.pct)}%.` }));
}

/**
 * Fixed vs variable spending of a month: fixed = confirmed expenses the person linked to a fixed payment
 * (plan settlements); variable = the rest. A card payment linked to a card obligation is not spending, so it never
 * counts here (financialEffect). Refunds reduce variable spending.
 */
export function fixedVsVariable(txs: readonly Transaction[], month: string, currency: Currency, fixedTxIds: ReadonlySet<string>): { fixedMinor: number; variableMinor: number } {
  let fixedMinor = 0, variableMinor = 0;
  for (const t of txs) {
    if (t.currency !== currency || t.occurredAt.slice(0, 7) !== month || t.status !== 'confirmed') continue;
    const effect = financialEffect(t.type);
    if (effect === 'expense') { if (fixedTxIds.has(t.id)) fixedMinor += t.amountMinor; else variableMinor += t.amountMinor; }
    else if (effect === 'expense_reduction') variableMinor -= t.amountMinor;
  }
  return { fixedMinor, variableMinor: Math.max(0, variableMinor) };
}
