/**
 * Pure validation of the Cuentas y tarjetas forms (ADR-0020, CR-001): a card (credit or debit) with its colour, bank,
 * expiry, and — for credit — line, cycle and the line used today; for debit, the accounts inside it with their
 * balance; cash. First server-side layer: save_money_source / set_cash_balance and the table checks validate again.
 * Never accepts a full card number, CVV, PIN or passwords (last 4 only; names refuse long digit runs).
 */
import { parseAmountToMinor, type Currency } from '../domain/money';
import type { Get, Parsed } from './transaction-input';

export const CARD_COLORS = ['black', 'gray', 'blue', 'green', 'red', 'sky', 'yellow'] as const;
export type CardColor = (typeof CARD_COLORS)[number];
export const COLOR_LABEL: Record<CardColor, string> = { black: 'Negro', gray: 'Gris', blue: 'Azul', green: 'Verde', red: 'Rojo', sky: 'Celeste', yellow: 'Amarillo' };

/** Banks offered in the UI. 'OTHER' asks for the bank's name (never a bare "Otro": two cards would look the same). */
export const BANKS = [
  { code: 'BCP', label: 'BCP' }, { code: 'INTERBANK', label: 'Interbank' }, { code: 'BBVA', label: 'BBVA' },
  { code: 'SCOTIABANK', label: 'Scotiabank' }, { code: 'OTHER', label: 'Otro' },
] as const;
export const BANK_LABEL: Record<string, string> = { BCP: 'BCP', INTERBANK: 'Interbank', BBVA: 'BBVA', SCOTIABANK: 'Scotiabank' };
export const MAX_ACCOUNTS = 6;

export interface AccountInput { alias: string; currency: Currency; balanceMinor: number | null }
export interface CardInput {
  alias: string; kind: 'credit' | 'debit'; institution: string | null; bankName: string | null; currency: Currency; last4: string;
  color: CardColor | null; expiryMonth: number | null; expiryYear: number | null;
  creditLimitMinor: number | null; statementDay: number | null; paymentDay: number | null; usedMinor: number | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const CONTROL = /[\u0000-\u001f\u007f]/;
const hasPan = (s: string) => /\d{5,}/.test(s.replace(/[\s-]/g, ''));
const currencyOf = (v: unknown): Currency | null => (v === 'PEN' || v === 'USD' ? v : null);

/** Blank = unknown (null); "0" is a real 0; anything else must be a valid amount. undefined = invalid. */
function amount(v: unknown): number | null | undefined {
  const s = str(v);
  if (!s) return null;
  if (/^0+([.,]0{1,2})?$/.test(s)) return 0;
  const m = parseAmountToMinor(s);
  return m === null ? undefined : m;
}

function name(v: unknown, max: number): string | undefined {
  const s = str(v);
  if (!s || s.length > max || CONTROL.test(s) || hasPan(s)) return undefined;
  return s;
}

function day(v: unknown): number | null | undefined {
  const s = str(v);
  if (!s) return null;
  const n = Number(s);
  return /^\d{1,2}$/.test(s) && n >= 1 && n <= 31 ? n : undefined;
}

/** "MM/AA" (or MM/AAAA). Blank = unknown. A date already past is refused (it would remind about nothing). */
export function parseExpiry(v: unknown, today: string): { month: number; year: number } | null | undefined {
  const s = str(v).replace(/\s/g, '');
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!m) return undefined;
  const month = Number(m[1]);
  const yy = m[2] ?? '';
  const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
  if (month < 1 || month > 12 || year < 2000 || year > 2099) return undefined;
  const ty = Number(today.slice(0, 4));
  const tm = Number(today.slice(5, 7));
  if (year < ty || (year === ty && month < tm)) return undefined;
  return { month, year };
}

/** Accounts typed inside a debit card: account[i].alias / .currency / .balance, i = 0..5. Empty rows are skipped. */
export function parseAccounts(get: Get): Parsed<AccountInput[]> {
  const out: AccountInput[] = [];
  for (let i = 0; i < MAX_ACCOUNTS; i++) {
    const rawAlias = str(get(`account${i}_alias`));
    const rawBalance = str(get(`account${i}_balance`));
    if (!rawAlias && !rawBalance) continue;
    const alias = name(rawAlias, 60);
    if (!alias) return fail(hasPan(rawAlias) ? 'pan_in_alias' : 'invalid_account_name');
    const currency = currencyOf(get(`account${i}_currency`));
    if (!currency) return fail('invalid_currency');
    const balanceMinor = amount(rawBalance);
    if (balanceMinor === undefined) return fail('invalid_balance');
    out.push({ alias, currency, balanceMinor });
  }
  return { ok: true, value: out };
}

export function parseMoneySourceForm(get: Get, today: string): Parsed<{ card: CardInput; accounts: AccountInput[] }> {
  const rawAlias = str(get('alias'));
  const alias = name(rawAlias, 60);
  if (!alias) return fail(hasPan(rawAlias) ? 'pan_in_alias' : 'invalid_alias');
  const kind = get('kind');
  if (kind !== 'credit' && kind !== 'debit') return fail('invalid_kind');
  const bank = str(get('bank'));
  let institution: string | null = null;
  let bankName: string | null = null;
  if (bank === 'OTHER') {
    const raw = str(get('bankName'));
    const n = name(raw, 40);
    if (!n) return fail(raw ? 'invalid_bank_name' : 'bank_name_required');
    bankName = n;
  } else if (BANKS.some((b) => b.code === bank && b.code !== 'OTHER')) {
    institution = bank;
  } else return fail('invalid_institution');
  const last4 = str(get('last4'));
  if (!/^\d{4}$/.test(last4)) return fail('invalid_last4');
  const colorRaw = str(get('color'));
  const color = colorRaw ? (CARD_COLORS as readonly string[]).includes(colorRaw) ? colorRaw as CardColor : undefined : null;
  if (color === undefined) return fail('invalid_color');
  const expiry = parseExpiry(get('expiry'), today);
  if (expiry === undefined) return fail('invalid_expiry');
  const accounts = kind === 'debit' ? parseAccounts(get) : { ok: true as const, value: [] };
  if (!accounts.ok) return accounts;
  // Debit cards carry their currency through their accounts; the card itself takes the first account's (or soles).
  const currency = kind === 'credit' ? currencyOf(get('currency')) : (accounts.value[0]?.currency ?? 'PEN');
  if (!currency) return fail('invalid_currency');
  let creditLimitMinor: number | null = null; let statementDay: number | null = null; let paymentDay: number | null = null; let usedMinor: number | null = null;
  if (kind === 'credit') {
    const limit = amount(get('limit'));
    const used = amount(get('used'));
    const s = day(get('statementDay'));
    const p = day(get('paymentDay'));
    if (limit === undefined || used === undefined) return fail('invalid_amount');
    if (s === undefined || p === undefined) return fail('invalid_day');
    if (limit !== null && used !== null && used > limit) return fail('used_over_limit');
    creditLimitMinor = limit; usedMinor = used; statementDay = s; paymentDay = p;
  }
  return {
    ok: true,
    value: {
      card: { alias, kind, institution, bankName, currency, last4, color, expiryMonth: expiry?.month ?? null, expiryYear: expiry?.year ?? null,
        creditLimitMinor, statementDay, paymentDay, usedMinor },
      accounts: accounts.value,
    },
  };
}

/** JSON for save_money_source (snake_case, nulls explicit: unknown stays null in the database). */
export function cardJson(c: CardInput) {
  return {
    alias: c.alias, kind: c.kind, institution: c.institution, bank_name: c.bankName, currency: c.currency, last4: c.last4, color: c.color,
    expiry_month: c.expiryMonth, expiry_year: c.expiryYear, credit_limit_minor: c.creditLimitMinor, statement_day: c.statementDay,
    payment_day: c.paymentDay, used_minor: c.usedMinor,
  };
}
export const accountsJson = (a: AccountInput[]) => a.map((x) => ({ alias: x.alias, currency: x.currency, balance_minor: x.balanceMinor }));

export const MONEY_SOURCE_ERRORS: Record<string, string> = {
  invalid_alias: 'Ponle un nombre a la tarjeta (hasta 60 caracteres).',
  pan_in_alias: 'El nombre no puede llevar números largos. Nunca escribas el número de tu tarjeta.',
  invalid_kind: 'Elige débito o crédito.',
  invalid_institution: 'Elige un banco de la lista.',
  bank_name_required: 'Escribe el nombre del banco.',
  invalid_bank_name: 'Revisa el nombre del banco (hasta 40 letras, sin números largos).',
  invalid_last4: 'Escribe solo los últimos 4 dígitos.',
  invalid_color: 'Elige un color de la lista.',
  invalid_expiry: 'Escribe el vencimiento como MM/AA, por ejemplo 08/29.',
  invalid_currency: 'Elige soles o dólares.',
  invalid_amount: 'Revisa los montos: por ejemplo 1500 o 1500.50.',
  invalid_day: 'Los días de corte y pago van del 1 al 31.',
  used_over_limit: 'Lo usado no puede ser mayor que la línea.',
  invalid_account_name: 'Ponle un nombre a cada cuenta (hasta 60 caracteres).',
  invalid_balance: 'Revisa el saldo de la cuenta: por ejemplo 1500.',
  accounts_need_debit_card: 'Las cuentas van dentro de una tarjeta de débito.',
  duplicate_card: 'Ya tienes una tarjeta con esos 4 dígitos.',
};
