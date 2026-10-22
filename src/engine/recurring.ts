import type { Transaction } from '../domain/types';
import type { Currency } from '../domain/money';
import { financialEffect } from '../domain/financial-effect';

/**
 * Recurring spending detection (spec §52, §82 Plus). Deterministic, no AI: the same merchant charged in at least
 * MIN_MONTHS distinct recent months, with a stable amount and a stable day of the month. Only confirmed spending
 * counts (card payments, transfers, ATM withdrawals and refunds never do). It only SUGGESTS: nothing is created
 * until the user accepts it as a fixed expense.
 */
export interface RecurringCandidate {
  merchant: string;
  currency: Currency;
  typicalAmountMinor: number;
  dayOfMonth: number;
  months: string[];
  lastSeen: string;
  /** Already tracked as an active fixed expense (same name, currency and similar amount). */
  tracked: boolean;
}

export const RECURRING_RULES = { minMonths: 3, lookbackMonths: 6, maxAmountDeviation: 0.15, maxDaySpread: 6 } as const;

const LIMA_OFFSET_MS = 5 * 3600_000;
const limaDate = (iso: string) => new Date(Date.parse(iso) - LIMA_OFFSET_MS).toISOString().slice(0, 10);

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

function monthsBack(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
}

export function detectRecurring(
  txs: readonly Pick<Transaction, 'type' | 'status' | 'amountMinor' | 'currency' | 'occurredAt' | 'merchantNormalized'>[],
  currentMonth: string,
  fixed: readonly { name: string; currency: Currency; amountMinor: number | null; active: boolean }[] = [],
): RecurringCandidate[] {
  const from = monthsBack(currentMonth, RECURRING_RULES.lookbackMonths - 1);
  const groups = new Map<string, { merchant: string; currency: Currency; byMonth: Map<string, { amount: number; day: number; date: string }> }>();
  for (const t of txs) {
    if (t.status !== 'confirmed' || !t.merchantNormalized || financialEffect(t.type) !== 'expense') continue;
    const date = limaDate(t.occurredAt);
    const month = date.slice(0, 7);
    if (month < from || month > currentMonth) continue;
    const key = `${t.currency}|${t.merchantNormalized}`;
    const g = groups.get(key) ?? { merchant: t.merchantNormalized, currency: t.currency, byMonth: new Map() };
    groups.set(key, g);
    // Several charges in one month (e.g. many taxi rides) are not a monthly bill: mark the month as noisy.
    const prev = g.byMonth.get(month);
    g.byMonth.set(month, prev ? { amount: -1, day: prev.day, date: prev.date } : { amount: t.amountMinor, day: Number(date.slice(8, 10)), date });
  }

  const out: RecurringCandidate[] = [];
  for (const g of groups.values()) {
    const entries = [...g.byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (entries.some(([, v]) => v.amount < 0) || entries.length < RECURRING_RULES.minMonths) continue;
    const amounts = entries.map(([, v]) => v.amount);
    const typical = median(amounts);
    if (amounts.some((a) => Math.abs(a - typical) > typical * RECURRING_RULES.maxAmountDeviation)) continue;
    const days = entries.map(([, v]) => v.day);
    if (Math.max(...days) - Math.min(...days) > RECURRING_RULES.maxDaySpread) continue;
    const tracked = fixed.some((f) => f.active && f.currency === g.currency && f.name.toUpperCase() === g.merchant.toUpperCase()
      && (f.amountMinor === null || Math.abs(f.amountMinor - typical) <= typical * RECURRING_RULES.maxAmountDeviation));
    out.push({
      merchant: g.merchant, currency: g.currency, typicalAmountMinor: typical, dayOfMonth: median(days),
      months: entries.map(([m]) => m), lastSeen: entries.at(-1)![1].date, tracked,
    });
  }
  return out.sort((a, b) => Number(a.tracked) - Number(b.tracked) || b.typicalAmountMinor - a.typicalAmountMinor);
}
