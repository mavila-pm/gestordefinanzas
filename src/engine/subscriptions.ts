import { addDays } from '../domain/dates';
import type { Currency } from '../domain/money';
import { occurrencesBetween, type Obligation } from './planning';

/**
 * Mis suscripciones. Pure. A subscription is an obligation with kind 'subscription': its future charges come from the
 * same occurrence engine as Próximos pagos (day 29–31 clamp to the month's last day, pause/end lifecycle, Lima dates),
 * and its history is only what really happened: plan_settlements linked to confirmed transactions.
 *   planned ≠ paid · unknown ≠ 0 · PEN ≠ USD · a yearly charge is projected whole on its real date; its monthly
 *   equivalent is an analytical figure, never a monthly expense.
 */
export interface SubscriptionRow extends Obligation { active: boolean; provider: string | null; cardId: string | null; accountId: string | null }
export interface SettlementFact {
  obligationId: string; period: string; status: 'paid' | 'skipped';
  /** The linked real movement (confirmed transaction); null if it is no longer readable. */
  transactionId: string | null; amountMinor: number | null; occurredOn: string | null; currency: Currency | null; merchant: string | null;
}
export type SubscriptionState = 'active' | 'paused' | 'ended' | 'pending';

export function subscriptionState(s: Pick<SubscriptionRow, 'active' | 'endedOn' | 'pausedUntil' | 'amountStatus' | 'dueDay'>, today: string): SubscriptionState {
  if (!s.active || s.endedOn) return 'ended';
  if (s.pausedUntil && s.pausedUntil > today) return 'paused';
  if (s.amountStatus === 'unknown' || s.dueDay === null) return 'pending';
  return 'active';
}

const MONTHS: Record<Obligation['frequency'], number> = { monthly: 1, bimonthly: 2, quarterly: 3, yearly: 12 };
/** Analytical monthly equivalent (yearly / 12), integer minor units; null when the price is unknown. */
export function monthlyEquivalentMinor(s: Pick<Obligation, 'amountMinor' | 'amountStatus' | 'frequency'>): number | null {
  if (s.amountStatus === 'unknown' || s.amountMinor === null) return null;
  return Math.round(s.amountMinor / MONTHS[s.frequency]);
}

export interface Charge { period: string; date: string | null; amountMinor: number | null; estimated: boolean; overdue: boolean }

/**
 * First charge on a later date than the engine would project from today (a trial, or this period already paid
 * elsewhere): planned charges before it are suspended with the same field a pause uses. null when not needed.
 */
export function startPause(s: Pick<Obligation, 'frequency' | 'anchorMonth' | 'dueDay' | 'dueDayMax' | 'targetDay'>, today: string, nextDate: string): string | null {
  const probe = { ...s, id: 'probe', source: 'obligation' as const, name: '', kind: 'subscription' as const, currency: 'PEN' as const, amountMinor: null, amountStatus: 'unknown' as const, since: today };
  const first = occurrencesBetween(probe, today, nextDate).find((o) => o.dueDate !== null && o.dueDate >= today);
  return first?.dueDate && first.dueDate < nextDate ? nextDate : null;
}

/**
 * The charge to show next: one that passed in the last 7 days with no payment linked comes first ("venció, sin pago
 * registrado": maybe the bank has not notified it yet); older unlinked months are not chased here (Próximos pagos
 * keeps its own overdue window). Otherwise the next charge from today. Settled or skipped periods never show.
 */
export function nextCharge(s: SubscriptionRow, today: string, settled: ReadonlySet<string>): Charge | null {
  if (subscriptionState(s, today) === 'ended') return null;
  const since = s.since.slice(0, 7);
  const occ = occurrencesBetween(s, addDays(today, -7), addDays(today, 400))
    .filter((o) => !settled.has(o.period) && o.period >= since && (o.dueDate === null || o.dueDate >= s.since));
  const recent = addDays(today, -7);
  const pick = occ.find((o) => o.dueDate !== null && o.dueDate < today && o.dueDate >= recent) ?? occ.find((o) => o.dueDate === null || o.dueDate >= today);
  if (!pick) return null;
  return { period: pick.period, date: pick.dueDate, amountMinor: pick.amountMinor, estimated: pick.amountStatus !== 'confirmed', overdue: pick.dueDate !== null && pick.dueDate < today };
}

/** Real payment history of one subscription, newest first: what was paid (linked movement) or skipped, never planned. */
export function paymentHistory(id: string, settlements: readonly SettlementFact[]): SettlementFact[] {
  return settlements.filter((x) => x.obligationId === id).sort((a, b) => b.period.localeCompare(a.period));
}

export interface SubscriptionTotals {
  currency: Currency;
  active: number;
  /** Charges due in the next 30 days (planned, unpaid), and how many of them have no known price. */
  next30Minor: number; next30Count: number; next30Unknown: number;
  /** Analytical monthly cost of the active ones; subscriptions without a price are counted apart, never as 0. */
  monthlyMinor: number; monthlyUnknown: number;
  /** Paid this calendar month (Lima): linked confirmed movements only. */
  paidMonthMinor: number; paidMonthCount: number;
}

export function subscriptionTotals(subs: readonly SubscriptionRow[], settlements: readonly SettlementFact[], today: string): SubscriptionTotals[] {
  const month = today.slice(0, 7);
  const horizon = addDays(today, 30);
  const out = new Map<Currency, SubscriptionTotals>();
  const t = (c: Currency) => out.get(c) ?? out.set(c, { currency: c, active: 0, next30Minor: 0, next30Count: 0, next30Unknown: 0, monthlyMinor: 0, monthlyUnknown: 0, paidMonthMinor: 0, paidMonthCount: 0 }).get(c)!;
  const settledBy = new Map<string, Set<string>>();
  for (const x of settlements) (settledBy.get(x.obligationId) ?? settledBy.set(x.obligationId, new Set()).get(x.obligationId)!).add(x.period);
  for (const s of subs) {
    const state = subscriptionState(s, today);
    if (state === 'ended') continue;
    const row = t(s.currency);
    // Paused = no charges until a date (a pause, or a first charge set later): still yours, still counted.
    row.active++;
    const eq = monthlyEquivalentMinor(s);
    if (eq === null) row.monthlyUnknown++; else row.monthlyMinor += eq;
    const settled = settledBy.get(s.id) ?? new Set<string>();
    for (const o of occurrencesBetween(s, today, horizon)) {
      if (o.dueDate === null || o.dueDate < today || o.dueDate > horizon || settled.has(o.period) || o.period < s.since.slice(0, 7)) continue;
      row.next30Count++;
      if (o.amountMinor === null) row.next30Unknown++; else row.next30Minor += o.amountMinor;
    }
  }
  const ids = new Map(subs.map((s) => [s.id, s.currency]));
  for (const x of settlements) {
    if (x.status !== 'paid' || x.amountMinor === null || !x.occurredOn?.startsWith(month)) continue;
    const cur = x.currency ?? ids.get(x.obligationId);
    if (!cur || !ids.has(x.obligationId) || ids.get(x.obligationId) !== cur) continue;
    const row = t(cur);
    row.paidMonthMinor += x.amountMinor; row.paidMonthCount++;
  }
  return [...out.values()].sort((a, b) => (a.currency === 'PEN' ? -1 : b.currency === 'PEN' ? 1 : 0));
}

/** A sum shown to the person: null ("por confirmar") when every item in it has an unknown price — never S/ 0. */
export const knownSum = (minor: number, unknownCount: number): number | null => (minor === 0 && unknownCount > 0 ? null : minor);
