import { formatMoney, type Currency } from '../domain/money';
import type { Transaction } from '../domain/types';
import { compareMonths, previousMonth } from './analysis';
import { monthlySummary } from './monthly-summary';

export interface Insight { text: string; estimated: boolean }

/**
 * Main insight (spec §40): the category that explains most of the spending increase vs the previous month.
 * Concrete and explainable, or nothing. Marked estimated when movements are still pending.
 */
export function mainInsight(txs: readonly Transaction[], month: string, currency: Currency): Insight | null {
  const cmp = compareMonths(txs, month, currency);
  if (cmp.previous.expensesMinor === 0 || cmp.current.expensesMinor === 0) return null;
  const m = (v: number) => formatMoney({ amountMinor: Math.abs(v), currency });
  const estimated = cmp.current.pendingCount > 0;
  if (cmp.expensesDeltaMinor > 0) {
    const driver = cmp.categories.filter((c) => c.deltaMinor > 0).sort((a, b) => b.deltaMinor - a.deltaMinor)[0];
    if (!driver) return null;
    const share = Math.round((driver.deltaMinor / cmp.expensesDeltaMinor) * 100);
    return { estimated, text: `${driver.category} aumentó ${m(driver.deltaMinor)} y explica el ${Math.min(share, 100)}% del incremento de tus gastos frente a ${monthName(cmp.previous.month)}.` };
  }
  if (cmp.expensesDeltaMinor < 0) {
    const driver = cmp.categories.filter((c) => c.deltaMinor < 0).sort((a, b) => a.deltaMinor - b.deltaMinor)[0];
    return { estimated, text: `Gastaste ${m(cmp.expensesDeltaMinor)} menos que en ${monthName(cmp.previous.month)}${driver ? `; la mayor baja fue ${driver.category} (${m(driver.deltaMinor)})` : ''}.` };
  }
  return null;
}

export type MilestoneKind = 'consistency' | 'improvement' | 'category_budget' | 'monthly_saving';
export interface Milestone { kind: MilestoneKind; month: string; text: string }

const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const monthName = (month: string) => MONTH_NAMES[Number(month.slice(5, 7)) - 1]!;

/**
 * FinancialMilestoneEngine (spec §41-45). Event-driven: evaluated only for a CLOSED month. Confidence gate (§44):
 * no pending movements in the months involved, real activity, and data health not requiring action. Never
 * congratulates logins, syncs, registering or spending. Returns at most ONE milestone (scarcity, §43).
 */
export function closedMonthMilestone(
  txs: readonly Transaction[],
  closedMonth: string,
  currency: Currency,
  opts: { firstName?: string | null; dataHealthOk: boolean; budgets?: readonly import('./budgets').Budget[] },
): Milestone | null {
  if (!opts.dataHealthOk) return null;
  const cur = monthlySummary(txs, closedMonth, currency);
  if (cur.pendingCount > 0 || cur.incomeMinor === 0 || cur.netCashFlowMinor <= 0) return null;
  const hello = opts.firstName ? `, ${opts.firstName}` : '';
  const m = (v: number) => formatMoney({ amountMinor: v, currency });
  const prev = monthlySummary(txs, previousMonth(closedMonth), currency);
  const prev2 = monthlySummary(txs, previousMonth(closedMonth, 2), currency);
  const trusted = (s: typeof cur) => s.pendingCount === 0 && s.incomeMinor > 0;

  if (trusted(prev) && trusted(prev2) && prev.netCashFlowMinor > 0 && prev2.netCashFlowMinor > 0) {
    return { kind: 'consistency', month: closedMonth, text: `Llevas tres meses consecutivos cerrando con saldo positivo${hello}. En ${monthName(closedMonth)} ahorraste ${m(cur.netCashFlowMinor)}.` };
  }
  if (trusted(prev) && cur.netCashFlowMinor > prev.netCashFlowMinor && prev.netCashFlowMinor > 0) {
    return { kind: 'improvement', month: closedMonth, text: `Felicidades${hello}. Cerraste ${monthName(closedMonth)} con ${m(cur.netCashFlowMinor)} de ahorro, ${m(cur.netCashFlowMinor - prev.netCashFlowMinor)} más que en ${monthName(previousMonth(closedMonth))}.` };
  }
  // Category kept under its limit (largest margin), only for categories with real spending.
  const kept = (opts.budgets ?? []).filter((b) => b.currency === currency)
    .map((b) => ({ b, spent: cur.expensesByCategory[b.category] ?? 0 }))
    .filter((x) => x.spent > 0 && x.spent <= x.b.amountMinor)
    .sort((a, b) => (b.b.amountMinor - b.spent) - (a.b.amountMinor - a.spent))[0];
  if (kept) {
    return { kind: 'category_budget', month: closedMonth, text: `Buen cierre${hello}. Mantuviste ${kept.b.category} ${m(kept.b.amountMinor - kept.spent)} por debajo de tu límite en ${monthName(closedMonth)}, y ahorraste ${m(cur.netCashFlowMinor)}.` };
  }
  return { kind: 'monthly_saving', month: closedMonth, text: `Felicidades${hello}. Cerraste ${monthName(closedMonth)} con ${m(cur.netCashFlowMinor)} de ahorro.` };
}
