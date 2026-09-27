import type { InstitutionCode, NormalizedFinancialEvent, RawFinancialEvent } from '../domain/types';

export type ParseResult =
  | { ok: true; event: NormalizedFinancialEvent }
  /** Recognized as coming from this bank but not parseable with enough certainty. */
  | { ok: false; reason: 'unknown_template' | 'malformed'; detail: string; parserVersion: string };

/** One adapter per bank + channel + template version. No bank-specific ifs outside adapters. */
export interface BankAdapter {
  readonly institution: InstitutionCode;
  readonly parserVersion: string;
  /** Cheap routing check: does this raw event belong to this adapter? */
  canHandle(raw: RawFinancialEvent): boolean;
  /** Is the sender a known official sender? Unverified sources can never be auto-confirmed. */
  verifySource(raw: RawFinancialEvent): boolean;
  /** parse + normalize + confidence. Must never invent a field it did not read. */
  parse(raw: RawFinancialEvent, text: string): ParseResult;
}
