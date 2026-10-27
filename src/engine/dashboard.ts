import type { Currency } from '../domain/money';
import type { Transaction } from '../domain/types';
import { financialEffect } from '../domain/financial-effect';

/**
 * Resumen blocks that summarize what is already registered. Pure. Nothing here estimates, scores or invents: a card
 * without its limit or used amount is counted as "sin dato", never as 0, and currencies are never mixed.
 */

export interface SpendSlice { category: string; amountMinor: number; ratio: number }

/** "En qué se fue tu dinero": the largest categories, the rest folded into "Otros". Only positive spending counts. */
export function spendSlices(byCategory: Readonly<Record<string, number>>, top = 4): SpendSlice[] {
  const rows = Object.entries(byCategory).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = rows.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return [];
  if (rows.length <= top) return rows.map(([category, amountMinor]) => ({ category, amountMinor, ratio: amountMinor / total }));
  const head = rows.filter(([c]) => c !== 'Otros').slice(0, top - 1);
  const out = head.map(([category, amountMinor]) => ({ category, amountMinor }));
  out.push({ category: 'Otros', amountMinor: total - out.reduce((s, x) => s + x.amountMinor, 0) });
  return out.map((s) => ({ ...s, ratio: s.amountMinor / total }));
}

export interface CreditCardFacts { name: string; currency: Currency; limitMinor: number | null; usedMinor: number | null }
export interface CreditUse { currency: Currency; limitMinor: number; usedMinor: number; ratio: number; withData: number; withoutData: number }

/** Total line and registered use in one currency, over the cards whose limit AND used amount are known. */
export function creditUse(cards: readonly CreditCardFacts[], currency: Currency): CreditUse | null {
  const mine = cards.filter((c) => c.currency === currency);
  const known = mine.filter((c) => c.limitMinor !== null && c.limitMinor > 0 && c.usedMinor !== null);
  if (!known.length) return null;
  const limitMinor = known.reduce((s, c) => s + c.limitMinor!, 0);
  const usedMinor = known.reduce((s, c) => s + c.usedMinor!, 0);
  return { currency, limitMinor, usedMinor, ratio: usedMinor / limitMinor, withData: known.length, withoutData: mine.length - known.length };
}

/** Common reference for revolving credit use (shown as a reference, not as a rule or a score). */
export const USE_REFERENCE = 0.3;

export interface CreditSignal { code: 'high_use' | 'use_ok' | 'use_unknown' | 'overdue' | 'no_overdue'; level: 'good' | 'watch' | 'unknown'; text: string }

/**
 * Own credit indicators (not a bureau score): registered card use against the 30% reference and payments that are
 * past due with no payment seen. `overdueCount` null = no planned payments to judge, so nothing is said about it.
 */
export function creditSignals(cards: readonly CreditCardFacts[], overdueCount: number | null): CreditSignal[] {
  const out: CreditSignal[] = [];
  const known = cards.filter((c) => c.limitMinor !== null && c.limitMinor > 0 && c.usedMinor !== null);
  const pct = (c: CreditCardFacts) => Math.round((c.usedMinor! / c.limitMinor!) * 100);
  for (const c of known.filter((x) => x.usedMinor! / x.limitMinor! >= USE_REFERENCE).sort((a, b) => pct(b) - pct(a))) {
    out.push({ code: 'high_use', level: 'watch', text: `${c.name} usa el ${pct(c)}% de su línea. La referencia usual es menos del 30%.` });
  }
  if (known.length && !out.length) out.push({ code: 'use_ok', level: 'good', text: known.length === 1 ? 'Tu tarjeta usa menos del 30% de su línea.' : 'Tus tarjetas usan menos del 30% de su línea.' });
  const missing = cards.length - known.length;
  if (missing > 0) out.push({ code: 'use_unknown', level: 'unknown', text: missing === 1 ? 'Falta la línea o lo utilizado de 1 tarjeta.' : `Falta la línea o lo utilizado de ${missing} tarjetas.` });
  if (overdueCount !== null) {
    out.push(overdueCount > 0
      ? { code: 'overdue', level: 'watch', text: overdueCount === 1 ? '1 pago vencido sin pago registrado.' : `${overdueCount} pagos vencidos sin pago registrado.` }
      : { code: 'no_overdue', level: 'good', text: 'Ningún pago vencido sin registrar.' });
  }
  return out;
}

export interface InstrumentMonth { inMinor: number; outMinor: number; internalCount: number; cashCount: number; pendingCount: number }

/**
 * One card's or account's month, from its own confirmed movements (one currency): money in (income), money out
 * (spending net of refunds), and apart — never as income or spending — own transfers and card payments
 * (internal_movement) and ATM withdrawals (transfer_to_cash). Pending movements are only counted. Movements ≠ balance.
 */
export function instrumentMonth(txs: readonly Pick<Transaction, 'type' | 'amountMinor' | 'currency' | 'status' | 'occurredAt'>[], month: string, currency: Currency): InstrumentMonth {
  const r: InstrumentMonth = { inMinor: 0, outMinor: 0, internalCount: 0, cashCount: 0, pendingCount: 0 };
  for (const t of txs) {
    if (t.currency !== currency || t.occurredAt.slice(0, 7) !== month || t.status === 'ignored') continue;
    if (t.status !== 'confirmed') { r.pendingCount++; continue; }
    switch (financialEffect(t.type)) {
      case 'income': r.inMinor += t.amountMinor; break;
      case 'expense': r.outMinor += t.amountMinor; break;
      case 'expense_reduction': r.outMinor -= t.amountMinor; break;
      case 'internal_movement': r.internalCount++; break;
      case 'transfer_to_cash': r.cashCount++; break;
      case 'undetermined': break;
    }
  }
  return r;
}
