import { describe, expect, it } from 'vitest';
import { cleanMerchant, emailDomain, last4, parseDateAndTime, parseMoneyExpr, readLabels } from '../src/ingestion/parse-helpers';

describe('bank-agnostic parse helpers', () => {
  it.each([
    ['S/ 100.00', 10000, 'PEN'], ['S/.45.9', 4590, 'PEN'], ['s/ 1,234.56', 123456, 'PEN'], ['PEN 12.50', 1250, 'PEN'], ['pen12', 1200, 'PEN'],
    ['US$ 1,250.99', 125099, 'USD'], ['$ 5', 500, 'USD'], ['USD 30.00', 3000, 'USD'], ['usd 0.10', 10, 'USD'],
  ])('reads %s', (raw, amountMinor, currency) => expect(parseMoneyExpr(raw)).toEqual({ amountMinor, currency }));

  it.each(['S/ 1.234,56', 'S/ 0', 'S/ 0.00', 'USD 0', 'S/ -5.00', '€ 5.00', 'EUR 5.00', 'S/ cien', '100.00', 'S/ 12.345', 'PENA 5', 'S/ 1,23'])(
    'rejects %s (never guessed)', (raw) => expect(parseMoneyExpr(raw)).toBeNull());

  it('last 4 digits only from masked numbers', () => {
    expect(last4('************4821')).toBe('4821');
    expect(last4('•••• 1234')).toBe('1234');
    expect(last4('XXXX5678')).toBe('5678');
    expect(last4('4821')).toBeNull();
    expect(last4(undefined)).toBeNull();
  });

  it('merchant is trimmed, single-spaced and capped', () => {
    expect(cleanMerchant('  TAMBO   LARCO ')).toBe('TAMBO LARCO');
    expect(cleanMerchant('   ')).toBeNull();
    expect(cleanMerchant('A'.repeat(300))!.length).toBe(120);
  });

  it('email domain of a sender', () => {
    expect(emailDomain('Banco <Avisos@Banco.Example>')).toBe('banco.example');
    expect(emailDomain('avisos@banco.example')).toBe('banco.example');
    expect(emailDomain('user-import:email')).toBeNull();
  });

  it('labels: a repeated label is ambiguous, never picked', () => {
    const L = { amount: /^Monto:\s*(.+)$/gim, date: /^Fecha:\s*(.+)$/gim };
    expect(readLabels('Monto: S/ 1.00\nFecha: hoy', L)).toEqual({ ok: true, values: { amount: 'S/ 1.00', date: 'hoy' } });
    expect(readLabels('Monto: S/ 1.00\nMonto: S/ 9.00', L)).toEqual({ ok: false, ambiguous: 'amount' });
    expect(readLabels('nada', L)).toEqual({ ok: true, values: {} });
  });

  it('numeric date + 24 h time in Lima; impossible values -> null', () => {
    expect(parseDateAndTime('15/09/2026', '20:30')).toBe('2026-09-15T20:30:00-05:00');
    expect(parseDateAndTime('31/02/2026', '10:00')).toBeNull();
    expect(parseDateAndTime('15/09/2026', '25:00')).toBeNull();
    expect(parseDateAndTime('2026-09-15', '10:00')).toBeNull();
  });
});
