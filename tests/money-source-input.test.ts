import { describe, expect, it } from 'vitest';
import { parseExpiry, parseMoneySourceForm } from '../src/web/money-source-input';

const TODAY = '2026-10-27';
const form = (o: Record<string, string>) => (k: string) => o[k] ?? null;
const base = { alias: 'Visa Oro', kind: 'credit', bank: 'BCP', currency: 'PEN', last4: '1234', color: 'black' };

describe('Cuentas y tarjetas form', () => {
  it('credit card: line, cycle, expiry and the line used today', () => {
    const r = parseMoneySourceForm(form({ ...base, limit: '5,000', used: '1200.50', statementDay: '20', paymentDay: '5', expiry: '08/29' }), TODAY);
    expect(r).toEqual({ ok: true, value: { accounts: [], card: {
      alias: 'Visa Oro', kind: 'credit', institution: 'BCP', bankName: null, currency: 'PEN', last4: '1234', color: 'black',
      expiryMonth: 8, expiryYear: 2029, creditLimitMinor: 500000, statementDay: 20, paymentDay: 5, usedMinor: 120050,
    } } });
  });

  it('blank optional fields stay unknown (null), never 0; "0" used is a real 0', () => {
    const r = parseMoneySourceForm(form({ ...base, used: '0' }), TODAY);
    expect(r.ok && r.value.card).toMatchObject({ creditLimitMinor: null, statementDay: null, usedMinor: 0, expiryMonth: null, color: 'black' });
  });

  it('debit card with several accounts in different currencies', () => {
    const r = parseMoneySourceForm(form({ ...base, kind: 'debit', currency: '',
      account0_alias: 'Ahorros Soles', account0_currency: 'PEN', account0_balance: '1500',
      account1_alias: 'Dólares', account1_currency: 'USD', account1_balance: '',
      account2_alias: '', account2_balance: '' }), TODAY);
    expect(r.ok && r.value.accounts).toEqual([
      { alias: 'Ahorros Soles', currency: 'PEN', balanceMinor: 150000 },
      { alias: 'Dólares', currency: 'USD', balanceMinor: null },
    ]);
    expect(r.ok && r.value.card).toMatchObject({ kind: 'debit', currency: 'PEN', creditLimitMinor: null, usedMinor: null });
  });

  it('"Otro" banco needs its name; Scotiabank is in the list', () => {
    expect(parseMoneySourceForm(form({ ...base, bank: 'OTHER' }), TODAY)).toEqual({ ok: false, error: 'bank_name_required' });
    const r = parseMoneySourceForm(form({ ...base, bank: 'OTHER', bankName: 'Caja Arequipa' }), TODAY);
    expect(r.ok && r.value.card).toMatchObject({ institution: null, bankName: 'Caja Arequipa' });
    expect(parseMoneySourceForm(form({ ...base, bank: 'SCOTIABANK' }), TODAY)).toMatchObject({ ok: true, value: { card: { institution: 'SCOTIABANK' } } });
    expect(parseMoneySourceForm(form({ ...base, bank: 'HSBC' }), TODAY)).toEqual({ ok: false, error: 'invalid_institution' });
  });

  it('refuses what must never be stored or cannot be true', () => {
    const bad = (o: Record<string, string>) => parseMoneySourceForm(form({ ...base, ...o }), TODAY);
    expect(bad({ last4: '12345' })).toEqual({ ok: false, error: 'invalid_last4' });
    expect(bad({ alias: 'Visa 4557 8800 1234 5678' })).toEqual({ ok: false, error: 'pan_in_alias' });
    expect(bad({ kind: 'debit', account0_alias: 'Cuenta 191-12345678', account0_currency: 'PEN' })).toEqual({ ok: false, error: 'pan_in_alias' });
    expect(bad({ color: 'pink' })).toEqual({ ok: false, error: 'invalid_color' });
    expect(bad({ limit: '100', used: '200' })).toEqual({ ok: false, error: 'used_over_limit' });
    expect(bad({ statementDay: '32' })).toEqual({ ok: false, error: 'invalid_day' });
    expect(bad({ currency: 'EUR' })).toEqual({ ok: false, error: 'invalid_currency' });
    expect(bad({ kind: 'debit', account0_alias: 'Ahorros', account0_currency: 'EUR' })).toEqual({ ok: false, error: 'invalid_currency' });
  });

  it('expiry MM/AA, not in the past', () => {
    expect(parseExpiry('10/26', TODAY)).toEqual({ month: 10, year: 2026 });
    expect(parseExpiry('09/26', TODAY)).toBeUndefined();
    expect(parseExpiry('13/29', TODAY)).toBeUndefined();
    expect(parseExpiry('08/2030', TODAY)).toEqual({ month: 8, year: 2030 });
    expect(parseExpiry('', TODAY)).toBeNull();
  });
});
