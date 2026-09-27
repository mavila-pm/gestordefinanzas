import type { Currency } from '../domain/money';

export interface FixedExpense { id: string; name: string; currency: Currency; amountMinor: number; dueDay: number; active: boolean }
export interface Debt {
  id: string; name: string; currency: Currency; principalMinor: number; balanceMinor: number;
  installmentMinor: number | null; installmentsTotal: number | null; installmentsPaid: number; dueDay: number | null; active: boolean;
}
export interface Commitment { kind: 'fixed' | 'debt'; id: string; name: string; currency: Currency; amountMinor: number; dueDate: string; daysUntil: number }

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
  const days = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const items: Omit<Commitment, 'daysUntil'>[] = [
    ...fixed.filter((f) => f.active).map((f) => ({ kind: 'fixed' as const, id: f.id, name: f.name, currency: f.currency, amountMinor: f.amountMinor, dueDate: dueDateIn(month, f.dueDay) })),
    ...debts.filter((d) => d.active && d.dueDay && d.installmentMinor && d.balanceMinor > 0
      && (d.installmentsTotal === null || d.installmentsPaid < d.installmentsTotal))
      .map((d) => ({ kind: 'debt' as const, id: d.id, name: d.name, currency: d.currency, amountMinor: Math.min(d.installmentMinor!, d.balanceMinor), dueDate: dueDateIn(month, d.dueDay!) })),
  ];
  return items.map((c) => ({ ...c, daysUntil: days(c.dueDate) })).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
}

export function totalsByCurrency(items: readonly { currency: Currency; amountMinor: number }[]): Partial<Record<Currency, number>> {
  const out: Partial<Record<Currency, number>> = {};
  for (const i of items) out[i.currency] = (out[i.currency] ?? 0) + i.amountMinor;
  return out;
}

/** Debt progress: how much principal has been paid down (never negative). */
export function debtProgress(d: Pick<Debt, 'principalMinor' | 'balanceMinor'>): { paidMinor: number; ratio: number } {
  const paid = Math.max(0, d.principalMinor - d.balanceMinor);
  return { paidMinor: paid, ratio: Math.min(1, paid / d.principalMinor) };
}
