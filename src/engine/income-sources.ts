import type { Currency } from '../domain/money';
import type { Transaction } from '../domain/types';
import { financialEffect } from '../domain/financial-effect';

export interface IncomeSource { name: string; amountMinor: number; count: number }

/**
 * Ingresos de un mes agrupados por su origen ("Negocio 1", "Sueldo", "Cliente X"): confirmed income only (through
 * financialEffect), one currency, the source = what the movement says (merchant/description), folded so "SUELDO" and
 * "Sueldo" are one. A movement without a name is "Sin descripción", never guessed. Largest first. Pure.
 */
export function incomeBySource(txs: readonly Transaction[], month: string, currency: Currency): IncomeSource[] {
  const groups = new Map<string, IncomeSource>();
  for (const t of txs) {
    if (t.currency !== currency || t.occurredAt.slice(0, 7) !== month || t.status !== 'confirmed') continue;
    if (financialEffect(t.type) !== 'income') continue;
    const raw = (t.merchantRaw ?? '').trim();
    const key = raw ? raw.toLocaleLowerCase('es').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ') : '';
    const g = groups.get(key) ?? { name: raw || 'Sin descripción', amountMinor: 0, count: 0 };
    g.amountMinor += t.amountMinor;
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.amountMinor - a.amountMinor);
}
