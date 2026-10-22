import { describe, expect, it } from 'vitest';
import { categorize } from '../src/engine/categorizer';
import { buildUserContext } from '../src/engine/user-context';
import { parseAccountForm, parseCorrectionForm } from '../src/web/transaction-input';

describe('buildUserContext (ingestion context from the user\'s own data)', () => {
  const ctx = buildUserContext('u', {
    cards: [{ last4: '4821', kind: 'credit' }, { last4: '1111', kind: 'debit', active: false }, { last4: 'x12', kind: 'debit' }],
    accounts: [{ last4: '9001' }, { last4: '9001' }, { last4: null }, { last4: '5555', active: false }],
    rules: [
      { contains: 'UBER', category_name: 'Transporte' },
      { contains: 'UBER EATS', category_name: 'Alimentación' },
      { contains: 'XY', category_name: 'Ocio' },
      { contains: 'TIENDA MIA', category_name: 'Categoría inexistente' },
    ],
  });

  it('keeps only active, well-formed cards and accounts (deduplicated)', () => {
    expect(ctx.cards).toEqual([{ last4: '4821', kind: 'credit' }]);
    expect(ctx.ownAccountLast4).toEqual(['9001']);
  });

  it('drops too-short rules and unknown categories; most specific rule wins', () => {
    expect(ctx.merchantRules.map((r) => r.contains)).toEqual(['UBER EATS', 'UBER']);
    expect(categorize('credit_card_purchase', 'UBER EATS LIMA', ctx.merchantRules)).toBe('Alimentación');
    expect(categorize('credit_card_purchase', 'UBER TRIP', ctx.merchantRules)).toBe('Transporte');
  });

  it('user rule beats global rule; never applies to non-spending types', () => {
    const rules = buildUserContext('u', { cards: [], accounts: [], rules: [{ contains: 'TAMBO', category_name: 'Personal' }] }).merchantRules;
    expect(categorize('expense', 'TAMBO MIRAFLORES', rules)).toBe('Personal');
    expect(categorize('expense', 'TAMBO MIRAFLORES', [])).toBe('Alimentación');
    expect(categorize('withdrawal', 'TAMBO MIRAFLORES', rules)).toBeNull();
  });
});

describe('account form and "remember" flag', () => {
  const f = (o: Record<string, string>) => (k: string) => o[k] ?? null;
  it('accounts: last 4 optional but exactly 4 digits when given; no long digit runs in the alias', () => {
    expect(parseAccountForm(f({ alias: 'Ahorros', institution: 'BBVA', currency: 'PEN', last4: '9001' }))).toEqual({ ok: true, value: { alias: 'Ahorros', institution: 'BBVA', currency: 'PEN', last4: '9001' } });
    expect(parseAccountForm(f({ alias: 'Ahorros', currency: 'USD' }))).toMatchObject({ ok: true, value: { last4: null, institution: null } });
    expect(parseAccountForm(f({ alias: 'Ahorros', currency: 'PEN', last4: '191-12345678-0-12' }))).toEqual({ ok: false, error: 'invalid_last4' });
    expect(parseAccountForm(f({ alias: 'Cta 19112345678012', currency: 'PEN' }))).toEqual({ ok: false, error: 'pan_in_alias' });
  });

  it('rememberRule only for spending-like types', () => {
    const REF = '7f1c1a3e-2b1d-4e5f-9a8b-0c1d2e3f4a5b';
    const CAT = '11111111-1111-4111-8111-111111111111';
    const current = { type: 'expense' as const, amountMinor: 100, currency: 'PEN' as const, occurredAt: '2026-09-15T20:30:00-05:00', merchantRaw: 'X', categoryId: CAT, cardId: null, accountId: null };
    const base = { id: REF, amount: '1.00', currency: 'PEN', date: '2026-09-15', time: '20:30', description: 'X', categoryId: CAT, rememberRule: '1' };
    expect(parseCorrectionForm(f({ ...base, type: 'expense' }), current)).toMatchObject({ ok: true, value: { rememberRule: true } });
    expect(parseCorrectionForm(f({ ...base, type: 'withdrawal' }), current)).toMatchObject({ ok: true, value: { rememberRule: false } });
  });
});

import { parseDebtForm, parseFixedExpenseForm } from '../src/web/transaction-input';

describe('commitment forms', () => {
  const f = (o: Record<string, string>) => (k: string) => o[k] ?? null;
  it('fixed expense: day 1..31, positive amount, safe name', () => {
    expect(parseFixedExpenseForm(f({ name: 'Alquiler', amount: '1,500.00', currency: 'PEN', dueDay: '5' }))).toEqual({ ok: true, value: { name: 'Alquiler', currency: 'PEN', amountMinor: 150000, dueDay: 5, categoryId: null } });
    expect(parseFixedExpenseForm(f({ name: 'X', amount: '10', currency: 'PEN', dueDay: '32' }))).toEqual({ ok: false, error: 'invalid_day' });
    expect(parseFixedExpenseForm(f({ name: '<script>', amount: '10', currency: 'PEN', dueDay: '1' }))).toEqual({ ok: false, error: 'invalid_name' });
  });
  it('debt: balance defaults to principal; rate in basis points; paid <= total', () => {
    expect(parseDebtForm(f({ name: 'Auto', currency: 'PEN', principal: '30000', rate: '12.5', installment: '1000', installmentsTotal: '36', installmentsPaid: '12', dueDay: '29' })))
      .toEqual({ ok: true, value: { name: 'Auto', lender: null, currency: 'PEN', principalMinor: 3000000, balanceMinor: 3000000, annualRateBp: 1250, installmentMinor: 100000, installmentsTotal: 36, installmentsPaid: 12, dueDay: 29 } });
    expect(parseDebtForm(f({ name: 'X', currency: 'PEN', principal: '100', installmentsTotal: '3', installmentsPaid: '4' }))).toEqual({ ok: false, error: 'invalid_installments' });
    expect(parseDebtForm(f({ name: 'X', currency: 'PEN', principal: '100', rate: 'abc' }))).toEqual({ ok: false, error: 'invalid_rate' });
  });
});
