import { randomUUID } from 'node:crypto';
import { parseAmountToMinor, type Currency } from '../domain/money';
import type { Direction, Transaction, TransactionType } from '../domain/types';
import { CATEGORIES, normalizeMerchant, type Category } from './categorizer';
import type { TransactionRepository } from './repository';

/** Types a user can register by hand. Card payments/transfers come from banks or later UI flows. */
const MANUAL_TYPES = {
  expense: 'outflow',
  income: 'inflow',
  withdrawal: 'outflow',
  internal_transfer: 'neutral',
  credit_card_payment: 'outflow',
  refund: 'inflow',
} as const satisfies Partial<Record<TransactionType, Direction>>;

export type ManualType = keyof typeof MANUAL_TYPES;

export interface ManualTransactionInput {
  type: ManualType;
  /** Decimal string as typed by the user ("35", "82.50"). Never a float. */
  amount: string;
  currency: Currency;
  /** ISO 8601 with offset. */
  occurredAt: string;
  description?: string;
  category?: Category;
}

export type ManualResult = { ok: true; transaction: Transaction } | { ok: false; error: string };

/** Manual entry is always available as fallback (§10). User-entered data is confirmed by definition. */
export async function createManualTransaction(
  userId: string,
  input: ManualTransactionInput,
  repo: TransactionRepository,
): Promise<ManualResult> {
  if (!(input.type in MANUAL_TYPES)) return { ok: false, error: 'invalid type' };
  const amountMinor = typeof input.amount === 'string' ? parseAmountToMinor(input.amount) : null;
  if (amountMinor === null) return { ok: false, error: 'invalid amount' };
  if (input.currency !== 'PEN' && input.currency !== 'USD') return { ok: false, error: 'invalid currency' };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(input.occurredAt) || Number.isNaN(Date.parse(input.occurredAt))) {
    return { ok: false, error: 'invalid occurredAt' };
  }
  if (input.category !== undefined && !CATEGORIES.includes(input.category)) return { ok: false, error: 'invalid category' };
  const description = input.description?.trim().slice(0, 120) || null;
  const isSpending = input.type === 'expense' || input.type === 'refund';

  const transaction = await repo.insert({
    userId,
    occurredAt: input.occurredAt,
    type: input.type,
    direction: MANUAL_TYPES[input.type],
    amountMinor,
    currency: input.currency,
    institution: null,
    cardLast4: null,
    merchantRaw: description,
    merchantNormalized: normalizeMerchant(description),
    category: isSpending ? (input.category ?? 'Otros') : null,
    status: 'confirmed',
    confidence: 'high',
    fingerprint: `manual:${randomUUID()}`,
    sources: [{ channel: 'manual', externalEventId: randomUUID(), parserVersion: 'MANUAL', templateVerification: null, receivedAt: new Date().toISOString() }],
    originalTransactionId: null,
    duplicateOfId: null,
  }, null);
  return { ok: true, transaction };
}
