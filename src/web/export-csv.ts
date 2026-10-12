import { financialEffect } from '../domain/financial-effect';
import type { Transaction } from '../domain/types';
import { TYPE_LABEL, formatLimaDateTime } from './transaction-input';

const EFFECT_LABEL: Record<string, string> = {
  expense: 'Gasto', income: 'Ingreso', expense_reduction: 'Reduce gasto', transfer_to_cash: 'Retiro de efectivo',
  internal_movement: 'Movimiento interno', undetermined: 'Sin determinar',
};
const STATUS_LABEL: Record<string, string> = { confirmed: 'Confirmado', review_required: 'Por revisar', possible_duplicate: 'Posible duplicado', ignored: 'Ignorado' };
const SOURCE_LABEL: Record<string, string> = { email: 'Email', sms: 'SMS', import: 'Importado', manual: 'Manual' };

/**
 * CSV cell: quoted, with quotes doubled, and neutralized against spreadsheet formula injection (a cell starting
 * with = + - @ tab or CR is prefixed with an apostrophe). Merchant names come from bank messages: untrusted.
 */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Minor units -> "1234.50" (no float arithmetic). */
export function minorToDecimal(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const a = Math.abs(minor);
  return `${sign}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

export const CSV_HEADER = ['Fecha', 'Tipo', 'Efecto', 'Monto', 'Moneda', 'Comercio o descripción', 'Categoría', 'Banco', 'Tarjeta', 'Estado', 'Origen', 'División'];

/**
 * A split movement stays ONE row with its full amount (sums of the Monto column never double count); the
 * División column lists the parts and the unallocated remainder so the distribution stays traceable.
 */
export function splitCell(t: Pick<Transaction, 'amountMinor' | 'category' | 'allocations'>): string {
  if (!t.allocations?.length) return '';
  const parts = t.allocations.map((a) => `${a.category}${a.note ? ` (${a.note})` : ''} ${minorToDecimal(a.amountMinor)}`);
  const rest = t.amountMinor - t.allocations.reduce((s, a) => s + a.amountMinor, 0);
  if (rest > 0) parts.push(`${t.category ?? 'Sin categoría'} ${minorToDecimal(rest)}`);
  return parts.join(' | ');
}

/** Semicolon-separated (Excel in es-PE opens it correctly), UTF-8 with BOM. Amounts are always positive; Efecto says what they mean. */
export function transactionsToCsv(txs: readonly Transaction[]): string {
  const rows = txs.map((t) => [
    formatLimaDateTime(t.occurredAt), TYPE_LABEL[t.type], EFFECT_LABEL[financialEffect(t.type)], minorToDecimal(t.amountMinor), t.currency,
    t.merchantRaw, t.category, t.institution, t.cardLast4 ? `****${t.cardLast4}` : '', STATUS_LABEL[t.status],
    [...new Set(t.sources.map((s) => SOURCE_LABEL[s.channel]))].join(' + '), splitCell(t),
  ].map(csvCell).join(';'));
  return `﻿${CSV_HEADER.map(csvCell).join(';')}\r\n${rows.join('\r\n')}${rows.length ? '\r\n' : ''}`;
}
