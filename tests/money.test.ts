import { describe, expect, it } from 'vitest';
import { formatMoney, parseAmountToMinor, parseCurrencyMarker } from '../src/domain/money';

describe('money (integer minor units, no floats)', () => {
  it.each([
    ['100', 10000], ['100.00', 10000], ['82.5', 8250], ['1,234.56', 123456], ['0.10', 10], ['1,000,000.01', 100000001],
  ])('parses %s', (raw, minor) => expect(parseAmountToMinor(raw)).toBe(minor));

  it.each(['1.234,56', '0', '0.00', '-5', '12.345', 'abc', '1,23', ''])('rejects ambiguous/invalid %s', (raw) => {
    expect(parseAmountToMinor(raw)).toBeNull();
  });

  it('avoids float drift (0.1 + 0.2)', () => {
    expect(parseAmountToMinor('0.10')! + parseAmountToMinor('0.20')!).toBe(30);
  });

  it('maps currency markers', () => {
    expect(parseCurrencyMarker('S/')).toBe('PEN');
    expect(parseCurrencyMarker('S/.')).toBe('PEN');
    expect(parseCurrencyMarker('US$')).toBe('USD');
    expect(parseCurrencyMarker('€')).toBeNull();
  });

  it('formats', () => expect(formatMoney({ amountMinor: 128450, currency: 'PEN' })).toBe('S/ 1,284.50'));
});
