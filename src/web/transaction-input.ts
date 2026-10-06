/**
 * Pure validation for the transaction write forms (manual entry, correction, review, cards).
 * First server-side layer: the database functions validate everything again (second layer) and
 * RLS + composite FKs are the last barrier. Nothing here trusts the browser.
 */
import { parseAmountToMinor, type Currency } from '../domain/money';
import type { CardKind, InstitutionCode, TransactionType } from '../domain/types';
import { normalizeMerchant } from '../engine/categorizer';
import { limaIso } from '../ingestion/lima-time';

export const TYPE_LABEL: Record<TransactionType, string> = {
  expense: 'Gasto',
  income: 'Ingreso',
  credit_card_purchase: 'Compra con tarjeta de crédito',
  credit_card_payment: 'Pago de tarjeta de crédito',
  internal_transfer: 'Transferencia entre mis cuentas',
  deposit: 'Depósito recibido',
  withdrawal: 'Retiro de efectivo',
  refund: 'Devolución',
  reversal: 'Reverso',
  unknown: 'Sin determinar',
};

/** Types a user can register by hand (same list as the database function). */
export const MANUAL_TYPES = ['expense', 'income', 'withdrawal', 'internal_transfer', 'credit_card_payment', 'refund'] as const;
export type ManualType = (typeof MANUAL_TYPES)[number];

/** Every type a correction may set ('unknown' is never a valid correction). */
export const CORRECTABLE_TYPES: readonly TransactionType[] = (Object.keys(TYPE_LABEL) as TransactionType[]).filter((t) => t !== 'unknown');

export const CATEGORIZABLE_TYPES: ReadonlySet<TransactionType> = new Set(['expense', 'credit_card_purchase', 'refund', 'reversal']);

const INSTITUTIONS: readonly InstitutionCode[] = ['BCP', 'BBVA', 'INTERBANK'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESCRIPTION_MAX = 120;
/** Same upper bound as the database (S/ 1,000,000,000.00). */
export const AMOUNT_MAX_MINOR = 100_000_000_000;

export type Get = (key: string) => unknown;
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function optionalUuid(v: unknown): string | null | undefined {
  const s = str(v);
  if (!s) return null;
  return isUuid(s) ? s : undefined;
}

function parseAmount(v: unknown): number | null {
  const minor = parseAmountToMinor(str(v));
  return minor !== null && minor <= AMOUNT_MAX_MINOR ? minor : null;
}

function parseCurrency(v: unknown): Currency | null {
  return v === 'PEN' || v === 'USD' ? v : null;
}

/** HTML date + time inputs (Lima wall clock) -> ISO with -05:00. */
export function limaDateTimeToIso(date: unknown, time: unknown): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(date));
  const t = /^(\d{2}):(\d{2})$/.exec(str(time) || '12:00');
  if (!d || !t) return null;
  return limaIso(Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2]));
}

function parseDescription(v: unknown): { raw: string | null; normalized: string | null } | null {
  const raw = str(v);
  if (raw.length > DESCRIPTION_MAX || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw ? { raw, normalized: normalizeMerchant(raw) } : { raw: null, normalized: null };
}

export interface ManualPayload {
  clientRef: string;
  type: ManualType;
  amountMinor: number;
  currency: Currency;
  occurredAt: string;
  description: string | null;
  descriptionNormalized: string | null;
  categoryId: string | null;
  cardId: string | null;
  accountId: string | null;
}

export function parseManualForm(get: Get): Parsed<ManualPayload> {
  const clientRef = str(get('clientRef'));
  if (!isUuid(clientRef)) return fail('invalid_request');
  const type = get('type');
  if (!MANUAL_TYPES.includes(type as ManualType)) return fail('invalid_type');
  const amountMinor = parseAmount(get('amount'));
  if (amountMinor === null) return fail('invalid_amount');
  const currency = parseCurrency(get('currency'));
  if (!currency) return fail('invalid_currency');
  const occurredAt = limaDateTimeToIso(get('date'), get('time'));
  if (!occurredAt) return fail('invalid_date');
  const description = parseDescription(get('description'));
  if (!description) return fail('invalid_description');
  const categoryId = optionalUuid(get('categoryId'));
  if (categoryId === undefined) return fail('invalid_category');
  const cardId = optionalUuid(get('cardId'));
  if (cardId === undefined) return fail('invalid_card');
  const accountId = optionalUuid(get('accountId'));
  if (accountId === undefined) return fail('invalid_account');
  return {
    ok: true,
    value: {
      clientRef, type: type as ManualType, amountMinor, currency, occurredAt,
      description: description.raw, descriptionNormalized: description.normalized,
      // A category only applies to spending-like types; the database rejects it otherwise.
      categoryId: CATEGORIZABLE_TYPES.has(type as ManualType) ? categoryId : null,
      cardId, accountId,
    },
  };
}

/** Current values of the editable fields, as the correction form was rendered from. */
export interface CorrectableState {
  type: TransactionType;
  amountMinor: number;
  currency: Currency;
  occurredAt: string;
  merchantRaw: string | null;
  categoryId: string | null;
  cardId: string | null;
  accountId: string | null;
}

export type CorrectionChanges = Partial<{
  type: TransactionType;
  amount_minor: number;
  currency: Currency;
  occurred_at: string;
  merchant_raw: string | null;
  merchant_normalized: string | null;
  category_id: string | null;
  card_id: string | null;
  account_id: string | null;
}>;

/** Builds the minimal change set (only fields that actually differ) for correct_transaction. */
export function parseCorrectionForm(get: Get, current: CorrectableState): Parsed<{ id: string; changes: CorrectionChanges; confirm: boolean; rememberRule: boolean }> {
  const id = str(get('id'));
  if (!isUuid(id)) return fail('invalid_request');
  const changes: CorrectionChanges = {};

  const type = get('type');
  if (!CORRECTABLE_TYPES.includes(type as TransactionType)) return fail(current.type === 'unknown' ? 'type_required' : 'invalid_type');
  if (type !== current.type) changes.type = type as TransactionType;

  const amountMinor = parseAmount(get('amount'));
  if (amountMinor === null) return fail('invalid_amount');
  if (amountMinor !== current.amountMinor) changes.amount_minor = amountMinor;

  const currency = parseCurrency(get('currency'));
  if (!currency) return fail('invalid_currency');
  if (currency !== current.currency) changes.currency = currency;

  const occurredAt = limaDateTimeToIso(get('date'), get('time'));
  if (!occurredAt) return fail('invalid_date');
  if (Date.parse(occurredAt) !== Date.parse(current.occurredAt)) changes.occurred_at = occurredAt;

  const description = parseDescription(get('description'));
  if (!description) return fail('invalid_description');
  if (description.raw !== current.merchantRaw) {
    changes.merchant_raw = description.raw;
    changes.merchant_normalized = description.normalized;
  }

  const newType = (type as TransactionType);
  if (CATEGORIZABLE_TYPES.has(newType)) {
    const categoryId = optionalUuid(get('categoryId'));
    if (categoryId === undefined) return fail('invalid_category');
    // Empty = keep the current category (the database defaults to 'Otros' when there is none).
    if (categoryId !== null && categoryId !== current.categoryId) changes.category_id = categoryId;
  }

  const cardId = optionalUuid(get('cardId'));
  if (cardId === undefined) return fail('invalid_card');
  if (cardId !== current.cardId) changes.card_id = cardId;

  const accountId = optionalUuid(get('accountId'));
  if (accountId === undefined) return fail('invalid_account');
  if (accountId !== current.accountId) changes.account_id = accountId;

  // "Remember for this merchant" only makes sense for spending-like types (checked again server-side).
  const rememberRule = get('rememberRule') === '1' && CATEGORIZABLE_TYPES.has(newType);
  return { ok: true, value: { id, changes, confirm: get('confirm') === '1', rememberRule } };
}

export function parseReviewForm(get: Get): Parsed<{ id: string; action: 'confirm' | 'ignore' }> {
  const id = str(get('id'));
  const action = get('action');
  if (!isUuid(id) || (action !== 'confirm' && action !== 'ignore')) return fail('invalid_request');
  return { ok: true, value: { id, action } };
}

export interface CardPayload {
  alias: string;
  institution: InstitutionCode | null;
  kind: CardKind;
  currency: Currency;
  last4: string;
}

/** Only alias, institution, kind, currency and last 4 digits (spec §27). Never a full number, CVV or PIN. */
export function parseCardForm(get: Get): Parsed<CardPayload> {
  const alias = str(get('alias'));
  if (!alias || alias.length > 60 || /[\u0000-\u001f\u007f]/.test(alias)) return fail('invalid_alias');
  // A long digit run in the alias may be a card number typed in the wrong field: refuse to store it.
  if (/\d{5,}/.test(alias.replace(/[\s-]/g, ''))) return fail('pan_in_alias');
  const institution = str(get('institution'));
  if (institution && !INSTITUTIONS.includes(institution as InstitutionCode)) return fail('invalid_institution');
  const kind = get('kind');
  if (kind !== 'credit' && kind !== 'debit') return fail('invalid_kind');
  const currency = parseCurrency(get('currency'));
  if (!currency) return fail('invalid_currency');
  const last4 = str(get('last4'));
  if (!/^\d{4}$/.test(last4)) return fail('invalid_last4');
  return { ok: true, value: { alias, institution: (institution || null) as InstitutionCode | null, kind, currency, last4 } };
}

export interface AccountPayload {
  alias: string;
  institution: InstitutionCode | null;
  currency: Currency;
  last4: string | null;
}

/** Own accounts: alias, bank, currency and optionally the last 4 digits (needed to detect own transfers). */
export function parseAccountForm(get: Get): Parsed<AccountPayload> {
  const alias = str(get('alias'));
  if (!alias || alias.length > 60 || /[\u0000-\u001f\u007f]/.test(alias)) return fail('invalid_alias');
  if (/\d{5,}/.test(alias.replace(/[\s-]/g, ''))) return fail('pan_in_alias');
  const institution = str(get('institution'));
  if (institution && !INSTITUTIONS.includes(institution as InstitutionCode)) return fail('invalid_institution');
  const currency = parseCurrency(get('currency'));
  if (!currency) return fail('invalid_currency');
  const last4 = str(get('last4'));
  if (last4 && !/^\d{4}$/.test(last4)) return fail('invalid_last4');
  return { ok: true, value: { alias, institution: (institution || null) as InstitutionCode | null, currency, last4: last4 || null } };
}

/** User-facing text for validation / database error codes. Unknown codes get a generic message. */
const ERROR_TEXT: Record<string, string> = {
  invalid_request: 'No pudimos procesarlo. Recarga la página e intenta de nuevo.',
  not_authenticated: 'Tu sesión expiró. Vuelve a ingresar.',
  not_found: 'No encontramos ese movimiento.',
  invalid_type: 'Elige un tipo de movimiento de la lista.',
  type_required: 'Primero indica qué tipo de movimiento es.',
  invalid_amount: 'Escribe un monto mayor a 0, por ejemplo 82.50.',
  invalid_currency: 'Elige soles o dólares.',
  invalid_date: 'Revisa la fecha: no puede ser futura.',
  invalid_description: 'La descripción puede tener hasta 120 caracteres.',
  invalid_category: 'Elige una categoría de la lista.',
  category_not_applicable: 'Este tipo de movimiento no lleva categoría.',
  invalid_card: 'Elige una de tus tarjetas.',
  card_mismatch: 'Esa tarjeta no coincide con los 4 dígitos que envió el banco.',
  invalid_account: 'Elige una de tus cuentas.',
  invalid_action: 'No pudimos procesarlo. Recarga la página e intenta de nuevo.',
  invalid_field: 'No pudimos procesarlo. Recarga la página e intenta de nuevo.',
  invalid_alias: 'Ponle un nombre a la tarjeta (hasta 60 caracteres).',
  pan_in_alias: 'Quita los números del nombre. Nunca escribas el número de tu tarjeta.',
  invalid_institution: 'Elige un banco de la lista.',
  invalid_kind: 'Indica si es de crédito o débito.',
  invalid_last4: 'Escribe solo los últimos 4 dígitos.',
  duplicate_card: 'Ya registraste una tarjeta con esos datos.',
  import_empty: 'Pega el texto completo del mensaje de tu banco.',
  import_too_large: 'El texto es muy largo. Pega solo un mensaje.',
  invalid_name: 'Ponle un nombre (hasta 60 caracteres).',
  invalid_day: 'Elige un día del 1 al 31.',
  invalid_rate: 'Escribe la tasa como número, por ejemplo 12.5.',
  invalid_installments: 'Escribe el número de cuotas, por ejemplo 12.',
  duplicate_account: 'Ya registraste una cuenta con ese banco y esos 4 dígitos.',
  rule_not_applicable: 'No podemos recordarlo: le falta un comercio claro o una categoría estándar.',
  not_deletable: 'Este movimiento vino de tu banco o está vinculado a otro: no se elimina. Puedes ignorarlo.',
};

export function errorText(code: string | null | undefined): string {
  return (code && ERROR_TEXT[code]) || 'No se guardó. Intenta de nuevo.';
}

/** Minor units -> editable decimal string ("82.50"). */
export function minorToInput(minor: number): string {
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/** Lima ISO ("2026-09-15T20:30:00-05:00") -> { date: "2026-09-15", time: "20:30" } for form inputs. */
export function isoToLimaInputs(iso: string): { date: string; time: string } {
  const lima = new Date(Date.parse(iso) - 5 * 3600_000).toISOString();
  return { date: lima.slice(0, 10), time: lima.slice(11, 16) };
}

/** "15/09/2026 20:30" (America/Lima). */
export function formatLimaDateTime(iso: string): string {
  const { date, time } = isoToLimaInputs(iso);
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y} ${time}`;
}

const dayOf = (v: unknown) => { const n = Number(str(v)); return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null; };
const optAmount = (v: unknown) => (str(v) ? parseAmount(v) : undefined);
const cleanName = (v: unknown) => { const s = str(v); return s && s.length <= 60 && !/[\u0000-\u001f\u007f<>]/.test(s) ? s : null; };

export interface FixedExpensePayload { name: string; currency: Currency; amountMinor: number; dueDay: number; categoryId: string | null }
export function parseFixedExpenseForm(get: Get): Parsed<FixedExpensePayload> {
  const name = cleanName(get('name'));
  if (!name) return fail('invalid_name');
  const amountMinor = parseAmount(get('amount'));
  if (amountMinor === null) return fail('invalid_amount');
  const currency = parseCurrency(get('currency'));
  if (!currency) return fail('invalid_currency');
  const dueDay = dayOf(get('dueDay'));
  if (!dueDay) return fail('invalid_day');
  const categoryId = optionalUuid(get('categoryId'));
  if (categoryId === undefined) return fail('invalid_category');
  return { ok: true, value: { name, currency, amountMinor, dueDay, categoryId } };
}

export interface DebtPayload {
  name: string; lender: string | null; currency: Currency; principalMinor: number; balanceMinor: number; annualRateBp: number | null;
  installmentMinor: number | null; installmentsTotal: number | null; installmentsPaid: number; dueDay: number | null;
}
export function parseDebtForm(get: Get): Parsed<DebtPayload> {
  const name = cleanName(get('name'));
  if (!name) return fail('invalid_name');
  const lenderRaw = str(get('lender'));
  const lender = lenderRaw ? cleanName(lenderRaw) : null;
  if (lenderRaw && !lender) return fail('invalid_name');
  const currency = parseCurrency(get('currency'));
  if (!currency) return fail('invalid_currency');
  const principalMinor = parseAmount(get('principal'));
  if (principalMinor === null) return fail('invalid_amount');
  const balance = optAmount(get('balance'));
  if (balance === null) return fail('invalid_amount');
  const rateRaw = str(get('rate'));
  const rate = rateRaw ? /^\d{1,3}(\.\d{1,2})?$/.test(rateRaw) ? Math.round(Number(rateRaw) * 100) : NaN : null;
  if (Number.isNaN(rate) || (rate !== null && rate > 100000)) return fail('invalid_rate');
  const installment = optAmount(get('installment'));
  if (installment === null) return fail('invalid_amount');
  const totalRaw = str(get('installmentsTotal'));
  const total = totalRaw ? Number(totalRaw) : null;
  if (total !== null && !(Number.isInteger(total) && total >= 1 && total <= 600)) return fail('invalid_installments');
  const paidRaw = str(get('installmentsPaid'));
  const paid = paidRaw ? Number(paidRaw) : 0;
  if (!Number.isInteger(paid) || paid < 0 || (total !== null && paid > total)) return fail('invalid_installments');
  const dueRaw = str(get('dueDay'));
  const dueDay = dueRaw ? dayOf(dueRaw) : null;
  if (dueRaw && !dueDay) return fail('invalid_day');
  return { ok: true, value: { name, lender, currency, principalMinor, balanceMinor: balance ?? principalMinor, annualRateBp: rate,
    installmentMinor: installment ?? null, installmentsTotal: total, installmentsPaid: paid, dueDay } };
}

/** Split form payload (untrusted): strict shape; the database re-validates everything (set_transaction_split). */
export function parseSplitForm(raw: unknown): { ok: true; value: Array<{ category_id: string; amount_minor: number; note?: string }> } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.length > 4000) return { ok: false, error: 'invalid_request' };
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { ok: false, error: 'invalid_request' }; }
  if (!Array.isArray(data) || data.length > 12) return { ok: false, error: 'invalid_request' };
  const out: Array<{ category_id: string; amount_minor: number; note?: string }> = [];
  for (const p of data) {
    if (typeof p !== 'object' || p === null) return { ok: false, error: 'invalid_request' };
    const { categoryId, amountMinor, note } = p as Record<string, unknown>;
    if (typeof categoryId !== 'string' || !isUuid(categoryId)) return { ok: false, error: 'missing_category' };
    if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return { ok: false, error: 'invalid_amount' };
    if (note !== null && note !== undefined && (typeof note !== 'string' || note.trim().length > 40)) return { ok: false, error: 'note_too_long' };
    out.push({ category_id: categoryId, amount_minor: amountMinor, ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}) });
  }
  return { ok: true, value: out };
}

/** Card cycle (Vels, ADR-0011): bank limit and statement/payment days. All optional; empty clears the value. */
export function parseCardCycleForm(get: Get): Parsed<{ creditLimitMinor: number | null; statementDay: number | null; paymentDay: number | null }> {
  const day = (k: string) => { const v = str(get(k)); if (!v) return null; const n = Number(v); return /^\d{1,2}$/.test(v) && n >= 1 && n <= 31 ? n : undefined; };
  const s = day('statementDay'); const p = day('paymentDay');
  const limitRaw = str(get('limit'));
  const limit = limitRaw ? parseAmountToMinor(limitRaw) : null;
  if (s === undefined || p === undefined || limit === undefined || (limitRaw && limit === null)) return fail('invalid_request');
  return { ok: true, value: { creditLimitMinor: limit, statementDay: s, paymentDay: p } };
}

/** Card statement entry (ADR-0014): dates required; amounts optional (blank = unknown, never 0). */
export function parseCardStatementForm(get: Get): Parsed<{ cutDate: string; dueDate: string; billedMinor: number | null; minimumMinor: number | null; usedMinor: number | null }> {
  const date = (k: string) => { const v = str(get(k)); return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null; };
  // "0" is a real, known value here (nothing billed) — distinct from blank (unknown).
  const amount = (k: string) => { const v = str(get(k)); if (!v) return null; if (/^0+(\.0{1,2})?$/.test(v)) return 0; const m = parseAmountToMinor(v); return m === null ? undefined : m; };
  const cutDate = date('cutDate'); const dueDate = date('dueDate');
  const billedMinor = amount('billed'); const minimumMinor = amount('minimum'); const usedMinor = amount('used');
  if (!cutDate || !dueDate || billedMinor === undefined || minimumMinor === undefined || usedMinor === undefined) return fail('invalid_request');
  return { ok: true, value: { cutDate, dueDate, billedMinor, minimumMinor, usedMinor } };
}
