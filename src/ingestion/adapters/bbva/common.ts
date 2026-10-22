import type { ParseResult } from '../../bank-adapter';
import type { CardKind, Direction, MessageChannel, NormalizedFinancialEvent, RawFinancialEvent, TransactionType } from '../../../domain/types';
import { cleanMerchant, MONEY_EXPR, parseDateAndTime, parseMoneyExpr } from '../../parse-helpers';
import { deriveExternalEventId } from '../../sanitize';

/**
 * Evidence register (BBVA Perú). NOTHING IS OBSERVED YET: no real sample of any BBVA email, SMS or app notification
 * has been provided. Every template below is SYNTHETIC_UNVERIFIED wording written to exercise the multi-bank
 * architecture; it must be replaced by templates calibrated on real anonymized samples (as a new parser version)
 * before any coverage claim.
 *
 * Sender allowlists are EMPTY on purpose: no BBVA sender has been observed, so every BBVA event carries
 * `sender_not_verified` and can never be auto-confirmed.
 */
export const BBVA_EMAIL_SENDER_DOMAINS: readonly string[] = [];
export const BBVA_SMS_SENDERS: readonly string[] = [];

/**
 * Genuine-looking bank messages that are not money movements. Checked only when no template matched, and only when
 * NO amount is printed anywhere: these words also appear in the security footers of real movement emails ("nunca te
 * pediremos tu clave digital"), so a message with an amount stays unresolved (the person registers it), never
 * dismissed as a notice.
 */
export interface NonTransactionalRule { re: RegExp; kind: string }

export const NON_TRANSACTIONAL: readonly NonTransactionalRule[] = [
  // One-time codes: never a movement; the code itself is never kept (detail is only the kind).
  { re: /\b(clave digital|clave din[áa]mica|c[óo]digo de verificaci[óo]n|token digital)\b/i, kind: 'otp_message' },
  // Security notices (a blocked/unusual operation is not a completed movement).
  { re: /\b(inicio de sesi[óo]n|bloqueamos|operaci[óo]n inusual|cambio de clave|actualizaste tus datos)\b/i, kind: 'security_notice' },
  { re: /\bestado de cuenta\b/i, kind: 'account_statement' },
  { re: /\b(promoci[óo]n|campa[ñn]a|aprovecha|descuentos?|beneficios?)\b/i, kind: 'marketing' },
];

const ANY_AMOUNT = new RegExp(MONEY_EXPR, 'i');

export function nonTransactionalKind(text: string): string | null {
  if (ANY_AMOUNT.test(text)) return null;
  return NON_TRANSACTIONAL.find((r) => r.re.test(text))?.kind ?? null;
}

export interface EventShape {
  type: TransactionType;
  direction: Direction;
  cardKind: CardKind | null;
  outgoingTransfer?: boolean;
  /** Fact the template cannot establish on its own; forces review. */
  uncertainty?: string;
}

/** Builds the normalized event. Every BBVA event is SYNTHETIC_UNVERIFIED and from an unverified sender. */
export function bbvaEvent(
  raw: RawFinancialEvent,
  channel: MessageChannel,
  parserVersion: string,
  shape: EventShape,
  fields: {
    amountMinor: number; currency: NormalizedFinancialEvent['currency']; occurredAt: string; merchantRaw: string | null;
    cardLast4: string | null; counterpartyAccountLast4: string | null; bankOperationId: string | null; reasons: string[];
  },
): NormalizedFinancialEvent {
  const reasons = [...fields.reasons];
  if (shape.uncertainty) reasons.push(shape.uncertainty);
  reasons.push('sender_not_verified');
  return {
    institution: 'BBVA', channel, parserVersion, templateVerification: 'SYNTHETIC_UNVERIFIED',
    externalEventId: deriveExternalEventId(raw), type: shape.type, direction: shape.direction,
    amountMinor: fields.amountMinor, currency: fields.currency, occurredAt: fields.occurredAt, merchantRaw: fields.merchantRaw,
    cardLast4: fields.cardLast4, cardKind: shape.cardKind, counterpartyAccountLast4: fields.counterpartyAccountLast4,
    isOutgoingTransfer: !!shape.outgoingTransfer, bankOperationId: fields.bankOperationId, confidence: 'medium', confidenceReasons: reasons,
  };
}

/** Regex fragments for whole-message (anchored) templates. */
export const MONEY = `(${MONEY_EXPR})`;
export const DATE = String.raw`(\d{2}\/\d{2}\/\d{4})`;
export const TIME = String.raw`(\d{2}:\d{2})`;

export interface LineTemplate extends EventShape {
  re: RegExp;
  /** Capture group indexes. */
  groups: { money: number; date: number; time: number; card?: number; merchant?: number; counterparty?: number };
}

/**
 * Anchored one-line templates (SMS, app notification): extra or injected text means no match, never a partial read.
 * Returns null when no template matched (the caller decides between non_transactional and unknown_template).
 */
export function parseLine(raw: RawFinancialEvent, body: string, templates: readonly LineTemplate[], parserVersion: string): ParseResult | null {
  for (const t of templates) {
    const m = t.re.exec(body);
    if (!m) continue;
    const money = parseMoneyExpr(m[t.groups.money]!);
    const occurredAt = parseDateAndTime(m[t.groups.date]!, m[t.groups.time]!);
    if (!money || !occurredAt) return { ok: false, reason: 'malformed', detail: 'amount or date not readable', parserVersion };
    return {
      ok: true,
      event: bbvaEvent(raw, 'sms', parserVersion, t, {
        amountMinor: money.amountMinor, currency: money.currency, occurredAt,
        merchantRaw: t.groups.merchant ? cleanMerchant(m[t.groups.merchant]) : null,
        cardLast4: t.groups.card ? m[t.groups.card]! : null,
        counterpartyAccountLast4: t.groups.counterparty ? m[t.groups.counterparty]! : null,
        bankOperationId: null, reasons: [],
      }),
    };
  }
  return null;
}
