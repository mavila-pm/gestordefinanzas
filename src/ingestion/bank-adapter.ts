import type { InstitutionCode, NormalizedFinancialEvent, RawFinancialEvent, TemplateVerification } from '../domain/types';

export type ParseFailureReason =
  /** Recognized as this bank's message, but no known template matched. Goes to unresolved. */
  | 'unknown_template'
  /** Template matched but a required field is unreadable or ambiguous. Goes to unresolved. */
  | 'malformed'
  /** Genuine bank message that is not a money movement (statement, security alert). No transaction. */
  | 'non_transactional';

export type ParseResult =
  | { ok: true; event: NormalizedFinancialEvent }
  | { ok: false; reason: ParseFailureReason; detail: string; parserVersion: string };

/** One adapter per bank + channel + template version. No bank-specific ifs outside adapters. */
export interface BankAdapter {
  readonly institution: InstitutionCode;
  readonly parserVersion: string;
  /** Evidence behind the templates. Only real anonymized fixtures can make this VERIFIED. */
  readonly templateVerification: TemplateVerification;
  /** Cheap routing check: does this raw event belong to this adapter? */
  canHandle(raw: RawFinancialEvent): boolean;
  /** Is the sender an observed official sender? Unverified senders can never be auto-confirmed. */
  verifySource(raw: RawFinancialEvent): boolean;
  /** parse + normalize + confidence. Must never invent a field it did not read. */
  parse(raw: RawFinancialEvent, text: string): ParseResult;
}
