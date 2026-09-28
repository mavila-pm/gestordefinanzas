import { formatMoney, type Currency } from '../domain/money';
import { financialEffect } from '../domain/financial-effect';
import type { Transaction } from '../domain/types';
import type { BudgetStatus } from './budgets';
import type { Commitment } from './commitments';

/** Alert engine (spec §46): CRITICAL / IMPORTANT / INFORMATIONAL, few and relevant (no bombarding). */
export type AlertLevel = 'CRITICAL' | 'IMPORTANT' | 'INFORMATIONAL';
export interface Alert { level: AlertLevel; code: string; text: string; href?: string }

export const MAX_ALERTS = 3;
const ORDER: Record<AlertLevel, number> = { CRITICAL: 0, IMPORTANT: 1, INFORMATIONAL: 2 };
/** A single expense is "unusual" when > 3x the median of the last 90 days and at least this amount. */
export const UNUSUAL_MIN_MINOR = 20_000;

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function buildAlerts(input: {
  txs: readonly Transaction[];
  pendingCount: number;
  oldestPendingDays: number | null;
  unresolvedEvents30d: number;
  now: Date;
  currency: Currency;
  budgets?: readonly BudgetStatus[];
  commitments?: readonly Commitment[];
}): Alert[] {
  const out: Alert[] = [];
  if (input.pendingCount > 0) {
    const stale = input.oldestPendingDays !== null && input.oldestPendingDays > 7;
    out.push({ level: stale ? 'IMPORTANT' : 'INFORMATIONAL', code: 'pending', href: '/app/revisar',
      text: `${input.pendingCount} movimiento(s) esperan tu revisión${stale ? `; el más antiguo, hace ${input.oldestPendingDays} días` : ''}. No cuentan en tus cifras hasta confirmarlos.` });
  }
  // Debt due soon (spec §46 "deuda próxima"): installments due today or in the next 3 days.
  for (const c of (input.commitments ?? []).filter((c) => c.kind === 'debt' && c.daysUntil >= 0 && c.daysUntil <= 3)) {
    out.push({ level: 'IMPORTANT', code: `debt_due:${c.id}`, href: '/app/compromisos',
      text: `${c.name}: cuota de ${c.amountMinor !== null ? formatMoney({ amountMinor: c.amountMinor, currency: c.currency }) : 'monto por confirmar'} ${c.daysUntil === 0 ? 'vence hoy' : `vence en ${c.daysUntil} día(s)`} (${c.dueDate.slice(8, 10)}/${c.dueDate.slice(5, 7)}).` });
  }
  for (const b of input.budgets ?? []) {
    const m = (v: number) => formatMoney({ amountMinor: v, currency: b.currency });
    if (b.state === 'exceeded') {
      out.push({ level: 'IMPORTANT', code: `budget_exceeded:${b.category}`, href: '/app/presupuestos',
        text: `Presupuesto excedido: ${b.category} lleva ${m(b.spentMinor)} de ${m(b.amountMinor)} (${m(-b.remainingMinor)} por encima).` });
    } else if (b.state === 'warning') {
      out.push({ level: 'INFORMATIONAL', code: `budget_warning:${b.category}`, href: '/app/presupuestos',
        text: `${b.category}: ya usaste el ${Math.floor(b.ratio * 100)}% de tu presupuesto (${m(b.spentMinor)} de ${m(b.amountMinor)}).` });
    }
  }
  if (input.unresolvedEvents30d > 0) {
    out.push({ level: 'INFORMATIONAL', code: 'unresolved', href: '/app/movimientos/nuevo',
      text: `${input.unresolvedEvents30d} mensaje(s) del banco no se pudieron leer. Si eran movimientos, regístralos manualmente.` });
  }
  // Unusual expense in the last 7 days vs the last 90 (confirmed expenses only).
  const since90 = input.now.getTime() - 90 * 86_400_000;
  const since7 = input.now.getTime() - 7 * 86_400_000;
  const expenses = input.txs.filter((t) => t.currency === input.currency && t.status === 'confirmed' && financialEffect(t.type) === 'expense'
    && Date.parse(t.occurredAt) >= since90);
  if (expenses.length >= 5) {
    const med = median(expenses.map((t) => t.amountMinor));
    const unusual = expenses.filter((t) => Date.parse(t.occurredAt) >= since7 && t.amountMinor >= UNUSUAL_MIN_MINOR && t.amountMinor > 3 * med)
      .sort((a, b) => b.amountMinor - a.amountMinor)[0];
    if (unusual) {
      out.push({ level: 'INFORMATIONAL', code: 'unusual_expense', href: `/app/movimientos/${unusual.id}`,
        text: `Gasto inusual: ${formatMoney(unusual)} en ${unusual.merchantRaw ?? 'un comercio'}, más de 3 veces tu gasto típico. Verifica que lo reconozcas.` });
    }
  }
  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level]).slice(0, MAX_ALERTS);
}
