import { daysBetween } from '../domain/dates';
import type { Currency } from '../domain/money';

/** Recurring obligation template (fixed_expenses). Unknown amount/day stay null — never 0 (ADR-0005). */
export interface FixedExpense {
  id: string; name: string; currency: Currency; amountMinor: number | null; dueDay: number | null; active: boolean;
  pausedUntil?: string | null; endedOn?: string | null;
  frequency?: 'monthly' | 'bimonthly' | 'quarterly' | 'yearly'; anchorMonth?: number | null;
}
export interface Debt {
  id: string; name: string; currency: Currency; principalMinor: number; balanceMinor: number;
  installmentMinor: number | null; installmentsTotal: number | null; installmentsPaid: number; dueDay: number | null; active: boolean;
}
export interface Commitment { kind: 'fixed' | 'debt'; id: string; name: string; currency: Currency; amountMinor: number | null; dueDate: string; daysUntil: number }

/** Day of month clamped to the month length (31 in February -> 28/29). */
export function dueDateIn(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/**
 * Commitments of a month (spec §38 "compromisos"): active fixed expenses + active debt installments with a due day.
 * `today` is the Lima calendar date (YYYY-MM-DD). Nothing here is counted as spending: the real payment arrives as
 * a movement.
 */
export function monthCommitments(month: string, today: string, fixed: readonly FixedExpense[], debts: readonly Debt[]): Commitment[] {
  const days = (date: string) => daysBetween(today, date);
  const items: Omit<Commitment, 'daysUntil'>[] = [
    ...fixed.filter((f) => f.active && f.dueDay !== null && occursIn(f, month)
      && !(f.pausedUntil && dueDateIn(month, f.dueDay) < f.pausedUntil) && !(f.endedOn && dueDateIn(month, f.dueDay) > f.endedOn))
      .map((f) => ({ kind: 'fixed' as const, id: f.id, name: f.name, currency: f.currency, amountMinor: f.amountMinor, dueDate: dueDateIn(month, f.dueDay!) })),
    ...debts.filter((d) => d.active && d.dueDay && d.installmentMinor && d.balanceMinor > 0
      && (d.installmentsTotal === null || d.installmentsPaid < d.installmentsTotal))
      .map((d) => ({ kind: 'debt' as const, id: d.id, name: d.name, currency: d.currency, amountMinor: Math.min(d.installmentMinor!, d.balanceMinor), dueDate: dueDateIn(month, d.dueDay!) })),
  ];
  return items.map((c) => ({ ...c, daysUntil: days(c.dueDate) })).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
}

const STEP = { monthly: 1, bimonthly: 2, quarterly: 3, yearly: 12 } as const;
function occursIn(f: FixedExpense, month: string): boolean {
  const freq = f.frequency ?? 'monthly';
  if (freq === 'monthly') return true;
  const m = Number(month.slice(5, 7));
  return f.anchorMonth != null && ((m - f.anchorMonth) % STEP[freq] + 12) % STEP[freq] === 0;
}

/** Sum of KNOWN amounts per currency (unknown amounts are reported separately, never counted as 0). */
export function totalsByCurrency(items: readonly { currency: Currency; amountMinor: number | null }[]): Partial<Record<Currency, number>> {
  const out: Partial<Record<Currency, number>> = {};
  for (const i of items) if (i.amountMinor !== null) out[i.currency] = (out[i.currency] ?? 0) + i.amountMinor;
  return out;
}

/** Debt progress: how much principal has been paid down (never negative). */
export function debtProgress(d: Pick<Debt, 'principalMinor' | 'balanceMinor'>): { paidMinor: number; ratio: number } {
  const paid = Math.max(0, d.principalMinor - d.balanceMinor);
  return { paidMinor: paid, ratio: Math.min(1, paid / d.principalMinor) };
}
