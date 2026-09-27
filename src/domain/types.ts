import type { Currency } from './money';

export type TransactionType =
  | 'expense'
  | 'income'
  | 'credit_card_purchase'
  | 'credit_card_payment'
  | 'internal_transfer'
  | 'deposit'
  | 'withdrawal'
  | 'refund'
  | 'reversal'
  | 'unknown';

export type Direction = 'inflow' | 'outflow' | 'neutral';

/**
 * - email / sms: delivered by a bank notification source (Email Bridge, Android SMS...).
 * - import: bank notification text pasted by the user (parsed by the same adapters; sender unverifiable).
 * - manual: typed by the user.
 */
export type SourceChannel = 'email' | 'sms' | 'import' | 'manual';

/** Channels a bank adapter parses (the message format). */
export type MessageChannel = 'email' | 'sms';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type TransactionStatus =
  | 'confirmed'
  | 'review_required'
  | 'possible_duplicate'
  | 'ignored';

export type InstitutionCode = 'BCP' | 'BBVA' | 'INTERBANK';

export type CardKind = 'credit' | 'debit';

/**
 * Evidence level of the template a parser was written from.
 * - SYNTHETIC_UNVERIFIED: built from assumed structure; never claim production coverage.
 * - VERIFIED: calibrated against real anonymized samples committed as fixtures.
 */
export type TemplateVerification = 'SYNTHETIC_UNVERIFIED' | 'VERIFIED';

/**
 * A raw event as delivered by a FinancialEventSource (Email Bridge, Gmail, Android SMS...).
 * Everything in here is UNTRUSTED INPUT: it is parsed with fixed patterns and never
 * interpreted as instructions.
 */
export interface RawFinancialEvent {
  channel: MessageChannel;
  /** Stable id from the source (email Message-ID, SMS provider id). Optional for SMS. */
  externalEventId?: string;
  /** Sender as reported by the source: email address or SMS sender id. */
  sender: string;
  subject?: string;
  /** Plain text or HTML body. */
  body: string;
  /** ISO timestamp when the source received the message. */
  receivedAt: string;
}

/** Output of a BankAdapter: the channel/bank-independent representation of a financial fact. */
export interface NormalizedFinancialEvent {
  institution: InstitutionCode;
  channel: MessageChannel;
  parserVersion: string;
  templateVerification: TemplateVerification;
  externalEventId: string;
  type: TransactionType;
  direction: Direction;
  amountMinor: number;
  currency: Currency;
  /** ISO 8601 with offset (America/Lima, -05:00). */
  occurredAt: string;
  merchantRaw: string | null;
  cardLast4: string | null;
  /** Null when the notification does not say whether the card is credit or debit. */
  cardKind: CardKind | null;
  /** Last digits of the destination account, for transfers. */
  counterpartyAccountLast4: string | null;
  /**
   * The bank reported an outgoing transfer. Whether it is an internal_transfer depends on the
   * user's own accounts, which the adapter does not know: the engine resolves it.
   */
  isOutgoingTransfer: boolean;
  bankOperationId: string | null;
  confidence: ConfidenceLevel;
  /** Why confidence is not high; empty when high. */
  confidenceReasons: string[];
}

export interface TransactionSource {
  channel: SourceChannel;
  externalEventId: string;
  /** 'MANUAL' for user-entered transactions. */
  parserVersion: string;
  templateVerification: TemplateVerification | null;
  receivedAt: string;
}

export interface Transaction {
  id: string;
  userId: string;
  occurredAt: string;
  type: TransactionType;
  direction: Direction;
  amountMinor: number;
  currency: Currency;
  institution: InstitutionCode | null;
  cardLast4: string | null;
  merchantRaw: string | null;
  merchantNormalized: string | null;
  category: string | null;
  status: TransactionStatus;
  confidence: ConfidenceLevel;
  fingerprint: string;
  sources: TransactionSource[];
  originalTransactionId: string | null;
  duplicateOfId: string | null;
}
