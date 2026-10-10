import { describe, expect, it } from 'vitest';
import type { Transaction } from '../src/domain/types';
import { incomeSources } from '../src/engine/analysis';
import { creditSignals, creditUse, spendSlices } from '../src/engine/dashboard';
import { detectIntent } from '../src/ai/vels-answers';

let n = 0;
const tx = (o: Partial<Transaction>): Transaction => ({
  id: `t${++n}`, userId: 'u', occurredAt: '2026-09-10T12:00:00-05:00', type: 'income', direction: 'inflow', amountMinor: 1000,
  currency: 'PEN', institution: 'BCP', cardLast4: null, merchantRaw: 'X', merchantNormalized: 'X', category: null,
  status: 'confirmed', confidence: 'high', fingerprint: 'f', sources: [{ channel: 'manual', externalEventId: 'e', parserVersion: 'MANUAL', templateVerification: null, receivedAt: '' }],
  originalTransactionId: null, duplicateOfId: null, ...o,
});

describe('Resumen: en qué se fue tu dinero', () => {
  it('keeps the largest categories and folds the rest (with any "Otros") into one "Otros"', () => {
    const s = spendSlices({ Vivienda: 180000, Alimentación: 105000, Otros: 5000, Ocio: 30000, Salud: 20000, Transporte: 10000 });
    expect(s.map((x) => x.category)).toEqual(['Vivienda', 'Alimentación', 'Ocio', 'Otros']);
    expect(s.at(-1)!.amountMinor).toBe(35000);
    expect(s.reduce((a, x) => a + x.amountMinor, 0)).toBe(350000);
    expect(s.reduce((a, x) => a + x.ratio, 0)).toBeCloseTo(1);
  });
  it('a category reduced below zero by refunds is not a slice; nothing spent → nothing shown', () => {
    expect(spendSlices({ Ocio: -500, Salud: 1000 })).toEqual([{ category: 'Salud', amountMinor: 1000, ratio: 1 }]);
    expect(spendSlices({})).toEqual([]);
  });
});

describe('Resumen: tarjetas (línea y uso registrado)', () => {
  const cards = [
    { name: 'Tarjeta BCP', currency: 'PEN' as const, limitMinor: 1000000, usedMinor: 100000 },
    { name: 'Tarjeta Oro', currency: 'PEN' as const, limitMinor: 500000, usedMinor: 320000 },
    { name: 'Visa sin datos', currency: 'PEN' as const, limitMinor: null, usedMinor: null },
    { name: 'Amex', currency: 'USD' as const, limitMinor: 300000, usedMinor: 30000 },
  ];
  it('sums only cards with both figures, per currency; unknown is reported, never counted as 0', () => {
    expect(creditUse(cards, 'PEN')).toEqual({ currency: 'PEN', limitMinor: 1500000, usedMinor: 420000, ratio: 0.28, withData: 2, withoutData: 1 });
    expect(creditUse(cards, 'USD')!.limitMinor).toBe(300000);
    expect(creditUse([cards[2]!], 'PEN')).toBeNull();
  });
  it('own indicators: high use per card against the 30% reference, missing data, overdue payments', () => {
    const s = creditSignals(cards, 0);
    expect(s.map((x) => x.code)).toEqual(['high_use', 'use_unknown', 'no_overdue']);
    expect(s[0]!.text).toBe('Tarjeta Oro usa el 64% de su línea. La referencia usual es menos del 30%.');
    expect(creditSignals([cards[0]!], 2).map((x) => x.text)).toEqual(['Tu tarjeta usa menos del 30% de su línea.', '2 pagos vencidos sin pago registrado.']);
    // No planned payments → nothing said about punctuality; no cards → nothing said about use.
    expect(creditSignals([], null)).toEqual([]);
    // Never a score: no text mentions a rating.
    expect(creditSignals(cards, 1).every((x) => !/score|puntaje|calificaci/i.test(x.text))).toBe(true);
  });
});

describe('Análisis: de dónde entró tu dinero', () => {
  it('confirmed income per source; transfers, refunds, pending and other currencies do not count', () => {
    const txs = [
      tx({ merchantNormalized: 'SUELDO ACME', amountMinor: 550000 }),
      tx({ merchantNormalized: 'TIENDA EN LINEA', amountMinor: 64000 }),
      tx({ merchantNormalized: 'TIENDA EN LINEA', amountMinor: 36000 }),
      tx({ type: 'internal_transfer', direction: 'neutral', merchantNormalized: 'MIS AHORROS', amountMinor: 900000 }),
      tx({ type: 'refund', merchantNormalized: 'SAGA', amountMinor: 5000 }),
      tx({ merchantNormalized: 'PENDIENTE', amountMinor: 70000, status: 'review_required' }),
      tx({ merchantNormalized: 'USD CLIENT', amountMinor: 10000, currency: 'USD' }),
    ];
    const s = incomeSources(txs, '2026-09', 'PEN');
    expect(s.map((x) => [x.merchant, x.totalMinor, x.count])).toEqual([['SUELDO ACME', 550000, 1], ['TIENDA EN LINEA', 100000, 2]]);
    expect(s[1]!.ratio).toBeCloseTo(100000 / 650000);
  });
});

describe('Vels: landing questions are answered by the engine (0 AI quota)', () => {
  it('¿Me alcanza? · ¿Qué pasa si gasto S/300? · ¿Cuándo pago? · ¿Cómo voy este mes?', () => {
    expect(detectIntent('¿Me alcanza?')).toEqual({ k: 'free' });
    expect(detectIntent('¿Me alcanza a fin de mes?')).toEqual({ k: 'free' });
    expect(detectIntent('¿Qué pasa si gasto S/300?')).toEqual({ k: 'can_spend', amountMinor: 30000, currency: 'PEN' });
    expect(detectIntent('y si compro unas zapatillas de 250')).toEqual({ k: 'can_spend', amountMinor: 25000, currency: 'PEN' });
    expect(detectIntent('¿Cuándo pago?')).toEqual({ k: 'upcoming', range: 'next' });
    expect(detectIntent('¿Cómo voy este mes?')).toEqual({ k: 'how' });
    expect(detectIntent('¿En qué se me fue el sueldo?')).toEqual({ k: 'changed' });
    // Paying a debt is still its own what-if, not a purchase.
    expect(detectIntent('¿qué pasa si pago 1000 a la tarjeta?').k).toBe('what_pay_debt');
  });
});
