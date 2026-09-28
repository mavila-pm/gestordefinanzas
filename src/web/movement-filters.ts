import type { SourceChannel, TransactionStatus, TransactionType } from '../domain/types';
import { parseAmountToMinor } from '../domain/money';
import { isUuid } from './transaction-input';

/** Movement list filters, parsed from the URL (untrusted). Unknown values fall back to "all". */
export interface MovementFilters {
  month: string | 'all';
  status: 'all' | 'confirmed' | 'pending' | 'ignored';
  kind: 'all' | 'expense' | 'income' | 'internal' | 'withdrawal' | 'refund' | 'unknown';
  source: 'all' | 'auto' | 'import' | 'manual';
  categoryId: string | null;
  currency: 'all' | 'PEN' | 'USD';
  q: string;
  page: number;
}

export const PAGE_SIZE = 50;

export const KIND_TYPES: Record<Exclude<MovementFilters['kind'], 'all'>, TransactionType[]> = {
  expense: ['expense', 'credit_card_purchase'],
  income: ['income', 'deposit'],
  internal: ['credit_card_payment', 'internal_transfer'],
  withdrawal: ['withdrawal'],
  refund: ['refund', 'reversal'],
  unknown: ['unknown'],
};
export const STATUS_VALUES: Record<Exclude<MovementFilters['status'], 'all'>, TransactionStatus[]> = {
  confirmed: ['confirmed'], pending: ['review_required', 'possible_duplicate'], ignored: ['ignored'],
};
export const SOURCE_VALUES: Record<Exclude<MovementFilters['source'], 'all'>, SourceChannel[]> = {
  auto: ['email', 'sms'], import: ['import'], manual: ['manual'],
};

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/** Search text: letters (incl. accents), digits, spaces and & . - only; LIKE wildcards removed; max 60 chars. */
export function sanitizeSearch(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.normalize('NFC').replace(/[^\p{L}\p{N} &.\-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** A search that is just an amount ("44.90", "1,200", "S/ 35") also matches movements of exactly that amount. */
export function searchAmountMinor(q: string): number | null {
  // sanitizeSearch already turned "S/ 35" into "S 35" and "1,200.50" into "1 200.50" (commas never reach a filter).
  const digits = q.replace(/^(?:US|S)\s+/i, '');
  return /^\d{1,3}( \d{3})+(\.\d{1,2})?$/.test(digits) ? parseAmountToMinor(digits.replace(/ /g, '')) : parseAmountToMinor(digits);
}

export function parseMovementFilters(sp: Record<string, string | string[] | undefined>, defaultMonth: string): MovementFilters {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]);
  const month = one('month');
  const page = Number(one('page'));
  return {
    month: month === 'all' ? 'all' : typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : defaultMonth,
    status: pick(one('status'), ['all', 'confirmed', 'pending', 'ignored'] as const, 'all'),
    kind: pick(one('kind'), ['all', 'expense', 'income', 'internal', 'withdrawal', 'refund', 'unknown'] as const, 'all'),
    source: pick(one('source'), ['all', 'auto', 'import', 'manual'] as const, 'all'),
    categoryId: isUuid(one('category')) ? (one('category') as string) : null,
    currency: pick(one('currency'), ['all', 'PEN', 'USD'] as const, 'all'),
    q: sanitizeSearch(one('q')),
    page: Number.isInteger(page) && page > 0 && page <= 1000 ? page : 1,
  };
}

/** Query string for links that keep the current filters (only non-default values). */
export function filtersToQuery(f: MovementFilters, patch: Partial<MovementFilters> = {}): string {
  const v = { ...f, ...patch };
  const qs = new URLSearchParams();
  qs.set('month', v.month);
  if (v.status !== 'all') qs.set('status', v.status);
  if (v.kind !== 'all') qs.set('kind', v.kind);
  if (v.source !== 'all') qs.set('source', v.source);
  if (v.categoryId) qs.set('category', v.categoryId);
  if (v.currency !== 'all') qs.set('currency', v.currency);
  if (v.q) qs.set('q', v.q);
  if (v.page > 1) qs.set('page', String(v.page));
  return qs.toString();
}
