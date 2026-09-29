import { describe, expect, it } from 'vitest';
import type { Transaction } from '../src/domain/types';
import { compareMonths, monthlyTrend, previousMonth, topMerchants } from '../src/engine/analysis';
import { csvCell, minorToDecimal, transactionsToCsv } from '../src/web/export-csv';

let n = 0;
const tx = (o: Partial<Transaction>): Transaction => ({
  id: `t${++n}`, userId: 'u', occurredAt: '2026-09-10T12:00:00-05:00', type: 'expense', direction: 'outflow', amountMinor: 1000,
  currency: 'PEN', institution: 'BCP', cardLast4: null, merchantRaw: 'X', merchantNormalized: 'X', category: 'Otros',
  status: 'confirmed', confidence: 'high', fingerprint: 'f', sources: [{ channel: 'manual', externalEventId: 'e', parserVersion: 'MANUAL', templateVerification: null, receivedAt: '' }],
  originalTransactionId: null, duplicateOfId: null, ...o,
});

describe('analysis', () => {
  it('previousMonth crosses years', () => {
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(previousMonth('2026-09', 5)).toBe('2026-04');
  });

  it('month vs previous: card payment and ATM never inflate spending; deltas per category', () => {
    const txs = [
      tx({ type: 'credit_card_purchase', amountMinor: 10000, category: 'Alimentación', merchantNormalized: 'RESTAURANTE' }),
      tx({ type: 'credit_card_payment', amountMinor: 10000, category: null }),
      tx({ type: 'withdrawal', amountMinor: 20000, category: null }),
      tx({ type: 'internal_transfer', direction: 'neutral', amountMinor: 50000, category: null }),
      tx({ type: 'refund', direction: 'inflow', amountMinor: 3000, category: 'Alimentación', merchantNormalized: 'RESTAURANTE' }),
      tx({ type: 'income', direction: 'inflow', amountMinor: 550000, category: null }),
      tx({ occurredAt: '2026-08-15T12:00:00-05:00', amountMinor: 4000, category: 'Transporte' }),
      tx({ occurredAt: '2026-08-15T12:00:00-05:00', amountMinor: 9999, status: 'ignored' }),
    ];
    const c = compareMonths(txs, '2026-09', 'PEN');
    expect(c.current.expensesMinor).toBe(7000);
    expect(c.previous.expensesMinor).toBe(4000);
    expect(c.expensesDeltaMinor).toBe(3000);
    expect(c.incomeDeltaMinor).toBe(550000);
    expect(c.categories).toEqual([
      { category: 'Alimentación', currentMinor: 7000, previousMinor: 0, deltaMinor: 7000 },
      { category: 'Transporte', currentMinor: 0, previousMinor: 4000, deltaMinor: -4000 },
    ]);
  });

  it('trend returns n months oldest first; USD never mixed with PEN', () => {
    const t = monthlyTrend([tx({}), tx({ currency: 'USD', amountMinor: 5000 })], '2026-09', 'PEN', 3);
    expect(t.map((m) => m.month)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(t[2]!.expensesMinor).toBe(1000);
  });

  it('top merchants: confirmed spending only, refunds reduce, pending excluded', () => {
    const top = topMerchants([
      tx({ merchantNormalized: 'TAMBO', amountMinor: 1500 }), tx({ merchantNormalized: 'TAMBO', amountMinor: 500 }),
      tx({ merchantNormalized: 'UBER', amountMinor: 3000 }),
      tx({ merchantNormalized: 'UBER', type: 'refund', direction: 'inflow', amountMinor: 3000 }),
      tx({ merchantNormalized: 'PENDIENTE', amountMinor: 99999, status: 'review_required' }),
      tx({ merchantNormalized: 'CAJERO', type: 'withdrawal', amountMinor: 20000 }),
    ], '2026-09', 'PEN');
    expect(top).toEqual([{ merchant: 'TAMBO', totalMinor: 2000, count: 2 }]);
  });
});

describe('CSV export', () => {
  it('neutralizes formula injection from untrusted merchant names and escapes quotes', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+51 999')).toBe(`"'+51 999"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('Pollería "Rico"')).toBe('"Pollería ""Rico"""');
    expect(csvCell(null)).toBe('""');
  });

  it('money as exact decimals from minor units', () => {
    expect(minorToDecimal(123456)).toBe('1234.56');
    expect(minorToDecimal(5)).toBe('0.05');
    expect(minorToDecimal(-250)).toBe('-2.50');
  });

  it('rows carry the financial effect, positive amounts and provenance; BOM + header', () => {
    const csv = transactionsToCsv([tx({ type: 'withdrawal', amountMinor: 20000, category: null, merchantRaw: 'CAJERO', sources: [
      { channel: 'import', externalEventId: 'a', parserVersion: 'BCP_SMS_V1', templateVerification: null, receivedAt: '' },
      { channel: 'sms', externalEventId: 'b', parserVersion: 'BCP_SMS_V1', templateVerification: null, receivedAt: '' }] })]);
    expect(csv.startsWith('﻿"Fecha";"Tipo";"Efecto";"Monto"')).toBe(true);
    expect(csv).toContain('"10/09/2026 12:00";"Retiro de efectivo";"Retiro de efectivo";"200.00";"PEN";"CAJERO"');
    expect(csv).toContain('"Importado + SMS"');
  });
});

import { filtersToQuery, parseMovementFilters, sanitizeSearch } from '../src/web/movement-filters';

describe('movement filters (URL is untrusted)', () => {
  it('parses known values and falls back safely', () => {
    const f = parseMovementFilters({ month: '2026-09', status: 'pending', kind: 'expense', source: 'import', q: 'Tambo', page: '2' }, '2026-10');
    expect(f).toMatchObject({ month: '2026-09', status: 'pending', kind: 'expense', source: 'import', q: 'Tambo', page: 2, categoryId: null });
    const bad = parseMovementFilters({ month: '2026-13', status: 'drop table', kind: ['x'], source: 'sms', category: "1' or 1=1", page: '-1' }, '2026-10');
    expect(bad).toMatchObject({ month: '2026-10', status: 'all', kind: 'all', source: 'all', categoryId: null, page: 1 });
  });

  it('search strips wildcards and PostgREST syntax', () => {
    expect(sanitizeSearch('%_*,()"')).toBe('');
    expect(sanitizeSearch('  Pollería   Rico & Cía. ')).toBe('Pollería Rico & Cía.');
    expect(sanitizeSearch('a'.repeat(100))).toHaveLength(60);
  });

  it('round-trips into a stable query string', () => {
    const f = parseMovementFilters({ month: 'all', status: 'confirmed', q: 'uber' }, '2026-10');
    expect(filtersToQuery(f)).toBe('month=all&status=confirmed&q=uber');
    expect(filtersToQuery(f, { page: 3 })).toBe('month=all&status=confirmed&q=uber&page=3');
  });
});

describe('search by amount (§52)', () => {
  it('a plain amount also matches movements of exactly that amount; text does not', async () => {
    const { searchAmountMinor, sanitizeSearch } = await import('../src/web/movement-filters');
    expect(searchAmountMinor(sanitizeSearch('44.90'))).toBe(4490);
    expect(searchAmountMinor(sanitizeSearch('S/ 35'))).toBe(3500);
    expect(searchAmountMinor(sanitizeSearch('1,200.50'))).toBe(120050);
    expect(searchAmountMinor(sanitizeSearch('US$ 20'))).toBe(2000);
    expect(searchAmountMinor(sanitizeSearch('NETFLIX'))).toBeNull();
    expect(searchAmountMinor(sanitizeSearch('0'))).toBeNull();
    expect(searchAmountMinor(sanitizeSearch('12.345'))).toBeNull();
  });
});

describe('sync history labels (§52)', () => {
  it('plain language only, unknown values fall back safely', async () => {
    const { describeSyncEvent } = await import('../src/web/sync-history');
    expect(describeSyncEvent({ channel: 'import', outcome: 'duplicate_same_event', created_at: '', transaction_id: null }))
      .toEqual({ channel: 'Mensaje pegado', outcome: 'Repetido: ya lo teníamos', linkable: false });
    expect(describeSyncEvent({ channel: 'x', outcome: 'BCP_SMS_V1', created_at: '', transaction_id: 't' }))
      .toEqual({ channel: 'Otra fuente', outcome: 'Procesado', linkable: true });
  });
});
