import type { Currency } from '../domain/money';
import { addDays, daysBetween } from '../domain/dates';
import { incomeOccurrencesBetween, occurrencesBetween, type ExpectedIncome, type Obligation } from './planning';

/**
 * Observed facts vs declared plans (ADR-0007). Everything here is a SUGGESTION the person confirms; nothing is
 * linked, replaced or changed silently. Expected income is never money until a real movement is linked to it.
 */

// ── Received income ↔ expected income ────────────────────────────────────────────────────────────────────
export interface IncomeCandidate { id: string; occurredOn: string; amountMinor: number; currency: Currency; merchant: string | null }
export interface IncomeMatch {
  incomeId: string; name: string; period: string; expectedDate: string; transactionId: string; receivedMinor: number; currency: Currency;
  expectedMinor: number | null; confidence: 'high' | 'medium';
  /** Another expected income fits this deposit equally well: the person must pick (never auto-resolved). */
  ambiguous?: boolean;
  /** Every equally good candidate (this one included), so the person can choose which income it was. */
  candidates?: Array<{ incomeId: string; name: string; period: string; expectedDate: string }>;
}

/** Days around the expected date (or window) a real deposit may land and still be "that" income. PROPUESTO. */
export const INCOME_DATE_TOLERANCE_DAYS = 5;

/**
 * Suggests which expected income a received deposit is. Amount must agree with the expected one (±5 % confirmed,
 * ±25 % estimated); when the expected amount is unknown only the date is used (medium). One deposit settles at
 * most one occurrence and each occurrence is matched once. Linked deposits and settled periods are skipped.
 */
export function suggestIncomeMatches(
  incomes: readonly ExpectedIncome[], deposits: readonly IncomeCandidate[],
  settled: ReadonlyMap<string, ReadonlySet<string>>, linkedTx: ReadonlySet<string>,
): IncomeMatch[] {
  const out: IncomeMatch[] = [];
  const usedTx = new Set(linkedTx);
  const usedOcc = new Set<string>();
  const byDate = [...deposits].sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
  for (const t of byDate) {
    if (usedTx.has(t.id)) continue;
    let best: { m: IncomeMatch; distance: number } | null = null;
    let ties: IncomeMatch[] = [];
    for (const i of incomes) {
      if (i.currency !== t.currency) continue;
      const occs = incomeOccurrencesBetween(i, addDays(t.occurredOn, -40), addDays(t.occurredOn, 40));
      for (const o of occs) {
        const key = `${i.id}|${o.period}`;
        if (usedOcc.has(key) || settled.get(i.id)?.has(o.period)) continue;
        const end = o.dateMax ?? o.date;
        const distance = t.occurredOn < o.date ? daysBetween(t.occurredOn, o.date) : t.occurredOn > end ? daysBetween(end, t.occurredOn) : 0;
        if (distance > INCOME_DATE_TOLERANCE_DAYS) continue;
        const expected = o.amountMinor;
        if (expected !== null) {
          const tol = Math.max(100, Math.round(expected * (o.amountStatus === 'confirmed' ? 0.05 : 0.25)));
          if (Math.abs(t.amountMinor - expected) > tol) continue;
        }
        const m: IncomeMatch = {
          incomeId: i.id, name: i.name, period: o.period, expectedDate: o.date, transactionId: t.id, receivedMinor: t.amountMinor, currency: t.currency,
          expectedMinor: expected, confidence: expected !== null && distance <= 2 ? 'high' : 'medium',
        };
        if (!best || distance < best.distance) { best = { m, distance }; ties = []; }
        else if (distance === best.distance && best.m.incomeId !== i.id) ties.push(m);
      }
    }
    if (best && ties.length) {
      const all = [best.m, ...ties].map((x) => ({ incomeId: x.incomeId, name: x.name, period: x.period, expectedDate: x.expectedDate }));
      best.m = { ...best.m, confidence: 'medium', ambiguous: true, candidates: all };
    }
    if (best) { out.push(best.m); usedTx.add(t.id); usedOcc.add(`${best.m.incomeId}|${best.m.period}`); }
  }
  return out;
}

// ── Observed amounts for payments whose amount is unknown ("No sé cuánto pago de internet") ───────────────
export interface ObservedAmount { obligationId: string; name: string; currency: Currency; observedMinor: number; period: string }

/** Unknown stays unknown until a real, linked payment shows the amount; then we SUGGEST it (never 0, never silent). */
export function observedAmountsForUnknown(
  obligations: readonly Obligation[], paid: ReadonlyArray<{ obligationId: string; period: string; actualMinor: number; acknowledged?: boolean }>,
): ObservedAmount[] {
  const out: ObservedAmount[] = [];
  for (const o of obligations) {
    if (o.source !== 'obligation' || (o.amountMinor !== null && o.amountStatus !== 'unknown')) continue;
    const last = paid.filter((p) => p.obligationId === o.id).sort((a, b) => b.period.localeCompare(a.period))[0];
    // "Mantener sin monto" acknowledged this payment: do not ask again until a newer one arrives.
    if (last && last.actualMinor > 0 && !last.acknowledged) out.push({ obligationId: o.id, name: o.name, currency: o.currency, observedMinor: last.actualMinor, period: last.period });
  }
  return out;
}

// ── Estimated day-to-day spending vs observed ("Comida está más cerca de S/ 450") ─────────────────────────
/** Categories that make up day-to-day essentials when observed. PROPUESTO (configurable later). */
export const ESSENTIAL_CATEGORIES = ['Alimentación', 'Transporte'] as const;
export const ESSENTIALS_MIN_MONTHS = 2;
export const ESSENTIALS_MIN_TX_PER_MONTH = 5;

export interface EssentialSpend { month: string; amountMinor: number; count: number }
export interface EssentialsSuggestion { estimateMinor: number; observedMinor: number; months: string[]; deltaMinor: number }

/**
 * Suggest updating the essentials estimate only with enough evidence: ≥2 complete months, each with ≥5 essential
 * movements (a month with few movements probably means missing data, not low spending). Observed = average of
 * those months. Differences under 10 % or S/ 30 are noise and are not suggested.
 */
export function essentialsSuggestion(estimateMinor: number | null, months: readonly EssentialSpend[], currentMonth: string): EssentialsSuggestion | null {
  if (estimateMinor === null) return null;
  const complete = months.filter((m) => m.month < currentMonth && m.count >= ESSENTIALS_MIN_TX_PER_MONTH).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 3);
  if (complete.length < ESSENTIALS_MIN_MONTHS) return null;
  const observed = Math.round(complete.reduce((s, m) => s + m.amountMinor, 0) / complete.length);
  const delta = observed - estimateMinor;
  if (Math.abs(delta) < Math.max(3000, Math.round(estimateMinor * 0.1))) return null;
  return { estimateMinor, observedMinor: observed, months: complete.map((m) => m.month).reverse(), deltaMinor: delta };
}

/** Monthly essential spend from confirmed expense movements (split-aware). Pure: callers pass already-typed rows. */
export function essentialSpendByMonth(
  txs: ReadonlyArray<{ occurredOn: string; amountMinor: number; currency: Currency; isExpense: boolean; category: string | null; allocations?: ReadonlyArray<{ category: string; amountMinor: number }> }>,
  currency: Currency,
): EssentialSpend[] {
  const essential = new Set<string>(ESSENTIAL_CATEGORIES);
  const byMonth = new Map<string, EssentialSpend>();
  for (const t of txs) {
    if (!t.isExpense || t.currency !== currency) continue;
    const amount = t.allocations?.length
      ? t.allocations.filter((a) => essential.has(a.category)).reduce((s, a) => s + a.amountMinor, 0)
      : t.category && essential.has(t.category) ? t.amountMinor : 0;
    if (amount <= 0) continue;
    const month = t.occurredOn.slice(0, 7);
    const m = byMonth.get(month) ?? { month, amountMinor: 0, count: 0 };
    m.amountMinor += amount;
    m.count += 1;
    byMonth.set(month, m);
  }
  return [...byMonth.values()];
}

// ── Timeline: what comes, in date order, from today ──────────────────────────────────────────────────────
export interface TimelineItem {
  date: string | null; dateMax: string | null; kind: 'income' | 'payment' | 'debt'; label: string; currency: Currency;
  amountMinor: number | null; amountStatus: 'confirmed' | 'estimated' | 'unknown'; overdue: boolean; refId: string;
}

/**
 * Expected incomes and planned payments between today and `days` ahead (default 35), plus unpaid items overdue
 * within the last month. Expected ≠ received and planned ≠ paid: settled occurrences are left out,
 * and every item keeps its status. Items with an unknown date are listed last (date null).
 */
export function timeline(
  input: { today: string; obligations: readonly Obligation[]; incomes: readonly ExpectedIncome[]; settledObligations: ReadonlyMap<string, ReadonlySet<string>>; settledIncomes: ReadonlyMap<string, ReadonlySet<string>> },
  days = 35,
): TimelineItem[] {
  const { today } = input;
  const to = addDays(today, days);
  const from = addDays(today, -31); // same one-month overdue look-back as the plan
  const items: TimelineItem[] = [];
  const undated: TimelineItem[] = [];
  for (const o of input.obligations) {
    let undatedListed = false;
    for (const x of occurrencesBetween(o, from, to)) {
      if (input.settledObligations.get(o.id)?.has(x.period) || x.period < o.since.slice(0, 7) || (x.dueDate !== null && x.dueDate < o.since)) continue;
      const last = x.dueDateMax ?? x.dueDate;
      const item: TimelineItem = {
        date: x.dueDate, dateMax: x.dueDateMax, kind: o.source === 'debt' ? 'debt' : 'payment', label: o.name, currency: o.currency,
        amountMinor: x.amountMinor, amountStatus: x.amountMinor === null ? 'unknown' : x.amountStatus, overdue: last !== null && last < today, refId: o.id,
      };
      if (x.dueDate === null) { if (!undatedListed) undated.push(item); undatedListed = true; continue; }
      if (x.dueDate >= from) items.push(item);
    }
  }
  for (const i of input.incomes) {
    // An expected income of the last week not linked to a real deposit stays listed as "not received yet".
    for (const x of incomeOccurrencesBetween(i, addDays(today, -7), to)) {
      if (input.settledIncomes.get(i.id)?.has(x.period)) continue;
      items.push({ date: x.date, dateMax: x.dateMax, kind: 'income', label: i.name, currency: i.currency, amountMinor: x.amountMinor,
        amountStatus: x.amountMinor === null ? 'unknown' : x.amountStatus, overdue: (x.dateMax ?? x.date) < today, refId: i.id });
    }
  }
  const rank = (k: TimelineItem['kind']) => (k === 'income' ? 0 : 1);
  items.sort((a, b) => a.date!.localeCompare(b.date!) || rank(a.kind) - rank(b.kind));
  return [...items, ...undated];
}

// ── The person's decisions on suggestions ("Ahora no" / "Descartar") ─────────────────────────────────────
export type SuggestionKind = 'essentials' | 'observed_amount' | 'income_match' | 'variation' | 'payment_match';
export interface Decision { kind: SuggestionKind; subject: string; valueMinor: number | null; decision: 'later' | 'dismissed'; until: string | null }
/** "Ahora no" waits this many days. PROPUESTO. */
export const SNOOZE_DAYS = 14;

/**
 * A snoozed suggestion stays hidden until its date. A dismissed one stays hidden for that value; if the observed
 * value moves materially (> 10 % and > S/ 30) it may be suggested again, because it is new evidence.
 */
export function isSuppressed(decisions: readonly Decision[], kind: SuggestionKind, subject: string, valueMinor: number | null, today: string): boolean {
  const d = decisions.find((x) => x.kind === kind && x.subject === subject);
  if (!d) return false;
  if (d.decision === 'later') return d.until !== null && d.until > today;
  if (d.valueMinor === null || valueMinor === null) return true;
  return Math.abs(valueMinor - d.valueMinor) <= Math.max(3000, Math.round(d.valueMinor * 0.1));
}
