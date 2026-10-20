import type { BankAdapter, ParseResult } from '../../bank-adapter';
import type { RawFinancialEvent } from '../../../domain/types';

/**
 * Interbank SCAFFOLD. No Interbank message has been observed and there are ZERO templates: these adapters only claim
 * messages that name Interbank, so an Interbank email that mentions another bank (e.g. "paga en agentes BCP") is
 * never read with that bank's templates. Everything they claim ends unresolved (unknown_template, no transaction).
 * No sender is allowlisted. Real templates arrive as new parser versions calibrated on real anonymized samples.
 */
const NAMES = /\bInterbank\b/i;

function scaffold(channel: 'email' | 'sms', parserVersion: string): BankAdapter {
  return {
    institution: 'INTERBANK',
    parserVersion,
    templateVerification: 'SYNTHETIC_UNVERIFIED',
    scaffold: true,
    canHandle(raw: RawFinancialEvent) {
      return raw.channel === channel && NAMES.test(`${raw.sender}\n${raw.subject ?? ''}\n${raw.body.slice(0, 4000)}`);
    },
    verifySource() {
      return false;
    },
    parse(): ParseResult {
      return { ok: false, reason: 'unknown_template', detail: 'no Interbank template yet', parserVersion };
    },
  };
}

export const interbankEmailV1 = scaffold('email', 'INTERBANK_EMAIL_V1');
export const interbankSmsV1 = scaffold('sms', 'INTERBANK_SMS_V1');
