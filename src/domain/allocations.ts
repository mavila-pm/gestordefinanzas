import type { Transaction, TransactionType } from './types';

/**
 * Split ("Dividir gasto"): an internal distribution of ONE movement across categories. It never creates money:
 * the movement keeps its amount, currency, direction, sources and dedupe identity; allocations only say which
 * categories that amount belongs to. Invariant: 0 < sum(allocations) <= amount. What is not allocated stays in the
 * movement's own category ("restante").
 *
 * Eligible: confirmed spending only (expense, credit_card_purchase). Excluded on purpose:
 *  - refund / reversal: they reduce the ORIGINAL purchase's category; splitting them would move money twice.
 *  - withdrawal: cash is not spending until the user says what it paid for (ADR-0002).
 *  - card payment / internal transfer: not spending at all (would double count the purchases they pay).
 *  - income, unknown, and anything pending review: confirm it first, then divide it.
 */
export const SPLITTABLE_TYPES: readonly TransactionType[] = ['expense', 'credit_card_purchase'];
export const MAX_PARTS = 12;
export const NOTE_MAX = 40;

export interface Allocation { category: string; amountMinor: number; note: string | null }

export function isSplittable(t: Pick<Transaction, 'type' | 'status'>): boolean {
  return t.status === 'confirmed' && SPLITTABLE_TYPES.includes(t.type);
}

/** How a movement's amount is attributed to categories: its allocations plus the unallocated remainder. */
export function categoryShares(
  t: Pick<Transaction, 'amountMinor'> & { allocations?: readonly Allocation[] },
  ownCategory: string,
): Array<{ category: string; amountMinor: number }> {
  const parts = t.allocations ?? [];
  if (parts.length === 0) return [{ category: ownCategory, amountMinor: t.amountMinor }];
  const allocated = parts.reduce((a, p) => a + p.amountMinor, 0);
  // Defensive: the database enforces allocated <= amount; never let a bad row create or remove money here.
  if (allocated > t.amountMinor) return [{ category: ownCategory, amountMinor: t.amountMinor }];
  const out = parts.map((p) => ({ category: p.category, amountMinor: p.amountMinor }));
  if (allocated < t.amountMinor) out.push({ category: ownCategory, amountMinor: t.amountMinor - allocated });
  return out;
}

export type SplitError = 'no_parts' | 'too_many_parts' | 'invalid_amount' | 'missing_category' | 'over_allocated' | 'note_too_long';

export interface SplitCheck { allocatedMinor: number; remainingMinor: number; error: SplitError | null }

/** Same rules the database enforces (set_transaction_split), for immediate feedback while editing. */
export function checkSplit(amountMinor: number, parts: ReadonlyArray<{ categoryId: string | null; amountMinor: number | null; note?: string | null }>): SplitCheck {
  let allocated = 0;
  let error: SplitError | null = null;
  if (parts.length === 0) error = 'no_parts';
  else if (parts.length > MAX_PARTS) error = 'too_many_parts';
  for (const p of parts) {
    if (p.amountMinor === null || !Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0) error ??= 'invalid_amount';
    else allocated += p.amountMinor;
    if (!p.categoryId) error ??= 'missing_category';
    if ((p.note ?? '').length > NOTE_MAX) error ??= 'note_too_long';
  }
  if (allocated > amountMinor) error ??= 'over_allocated';
  return { allocatedMinor: allocated, remainingMinor: amountMinor - allocated, error };
}

export const SPLIT_ERROR_TEXT: Record<SplitError | 'stale' | 'not_splittable' | 'invalid_category' | 'currency_mismatch' | 'invalid_request' | 'unknown', string> = {
  no_parts: 'Añade al menos una parte.',
  too_many_parts: `Puedes dividir en hasta ${MAX_PARTS} partes.`,
  invalid_amount: 'Cada parte necesita un importe mayor que cero.',
  missing_category: 'Elige una categoría para cada parte.',
  over_allocated: 'Las partes suman más que el movimiento.',
  note_too_long: `La nota puede tener hasta ${NOTE_MAX} caracteres.`,
  stale: 'Este movimiento cambió mientras lo editabas. Revisa la división y guarda de nuevo.',
  not_splittable: 'Este movimiento no se puede dividir.',
  invalid_category: 'Esa categoría ya no está disponible. Elige otra.',
  currency_mismatch: 'Todas las partes deben estar en la moneda del movimiento.',
  invalid_request: 'No pudimos leer la división. Intenta de nuevo.',
  unknown: 'No pudimos guardar la división. Intenta de nuevo.',
};
