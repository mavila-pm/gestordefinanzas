import { daysBetween } from '../domain/dates';
import type { Currency } from '../domain/money';
import { cardCycle } from './scenarios';

/**
 * Credit card position (ADR-0014). Pure. Six numbers that must never be mixed:
 * línea (bank limit) · utilizado (used today, as the person/bank says) · facturado (billed at the last cut, due on the
 * due date) · post-corte (purchases after the cut: they go to the NEXT statement) · mínimo vs total · usable real
 * (what can be used without breaking the plan). Unknown stays null — never 0, never guessed.
 */
export interface CardInput { currency: Currency; creditLimitMinor: number | null; statementDay: number | null; paymentDay: number | null; annualRateBp?: number | null }
export interface Statement { cutDate: string; dueDate: string; billedMinor: number | null; minimumMinor: number | null; usedMinor: number | null; usedAsOf: string | null; status: 'confirmed' | 'estimated'; source: 'manual' | 'camera' | 'import'; updatedAt: string }
export interface CardPosition {
  currency: Currency;
  limitMinor: number | null;
  usedMinor: number | null;
  /** Bank-side room: línea − utilizado (both known). */
  bankAvailableMinor: number | null;
  billed: { amountMinor: number | null; minimumMinor: number | null; cutDate: string; dueDate: string; status: Statement['status']; daysLeft: number } | null;
  /** The statement on file is older than the last cut: ask for the new one instead of using old numbers as current. */
  statementOutdated: boolean;
  /** Real purchases on this card registered after the cut (Velsuno movements only). */
  postCutMinor: number | null;
  /** What can be used this cycle without touching planned payments: min(plan free, bank room when known). */
  usableMinor: number | null;
  /** When a purchase made today is paid (next statement's due date), from the cycle days. */
  purchaseTodayPaidOn: string | null;
  nextCut: string | null;
  /** Paying only the minimum: what rolls to the next cycle, and its monthly interest if the rate is known. */
  minimumOnly: { carriedMinor: number; interestMinor: number | null } | null;
}


export function cardPosition(today: string, card: CardInput, st: Statement | null, postCutMinor: number | null, planFreeMinor: number | null): CardPosition {
  const cycle = card.statementDay && card.paymentDay ? cardCycle(today, card.statementDay, card.paymentDay) : null;
  const statementOutdated = !!st && (cycle ? st.cutDate < cycle.lastCut : daysBetween(st.cutDate, today) > 35);
  const current = st && !statementOutdated ? st : null;
  const usedMinor = current?.usedMinor ?? null;
  const bankAvailableMinor = card.creditLimitMinor !== null && usedMinor !== null ? Math.max(0, card.creditLimitMinor - usedMinor) : null;
  const free = planFreeMinor === null ? null : Math.max(0, planFreeMinor);
  const usableMinor = free === null ? null : bankAvailableMinor === null ? free : Math.min(free, bankAvailableMinor);
  const billed = current ? {
    amountMinor: current.billedMinor, minimumMinor: current.minimumMinor, cutDate: current.cutDate, dueDate: current.dueDate,
    status: current.status, daysLeft: daysBetween(today, current.dueDate),
  } : null;
  const carried = billed?.amountMinor != null && billed.minimumMinor != null ? billed.amountMinor - billed.minimumMinor : null;
  const rate = card.annualRateBp ?? null;
  return {
    currency: card.currency, limitMinor: card.creditLimitMinor, usedMinor, bankAvailableMinor, billed, statementOutdated,
    postCutMinor: current ? postCutMinor : null, usableMinor,
    purchaseTodayPaidOn: cycle?.dueOfToday ?? null, nextCut: cycle?.nextCut ?? null,
    minimumOnly: carried !== null && carried > 0 ? { carriedMinor: carried, interestMinor: rate ? Math.round((carried * rate) / 10000 / 12) : null } : null,
  };
}

/** Manual statement entry → validated values (the server re-checks; the database checks again). */
export function validStatement(v: { cutDate: string; dueDate: string; billedMinor: number | null; minimumMinor: number | null; usedMinor: number | null }): string | null {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE.test(v.cutDate) || !DATE.test(v.dueDate) || Number.isNaN(Date.parse(v.cutDate)) || Number.isNaN(Date.parse(v.dueDate))) return 'Revisa las fechas.';
  const gap = daysBetween(v.cutDate, v.dueDate);
  if (gap <= 0 || gap > 62) return 'El pago vence después del corte (hasta 2 meses).';
  if (v.minimumMinor !== null && v.billedMinor !== null && v.minimumMinor > v.billedMinor) return 'El mínimo no puede ser mayor que el total.';
  return null;
}
