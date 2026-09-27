import type { BankAdapter, ParseResult } from '../../bank-adapter';
import type { Direction, RawFinancialEvent, TransactionType } from '../../../domain/types';
import { parseNumericDate } from '../../lima-time';
import { deriveExternalEventId } from '../../sanitize';
import { BCP_SMS_SENDERS, cleanMerchant, parseMoneyExpr } from './common';

const VERSION = 'BCP_SMS_V1';

const MONEY = String.raw`((?:S\/\.?|US\$|\$)\s*[\d,]+(?:\.\d{1,2})?)`;
const DATE = String.raw`(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})`;

interface Template {
  re: RegExp;
  type: TransactionType;
  direction: Direction;
  /** Capture group indexes. */
  groups: { money: number; card: number; merchant?: number; date: number };
}

// Whole-message anchored patterns: extra text (including injected text) means no match.
const TEMPLATES: Template[] = [
  {
    re: new RegExp(String.raw`^BCP: Realizaste un consumo de ${MONEY} con tu Tarjeta de Credito \*(\d{4}) en (.{1,80}?) el ${DATE}\.?$`, 'i'),
    type: 'credit_card_purchase', direction: 'outflow', groups: { money: 1, card: 2, merchant: 3, date: 4 },
  },
  {
    re: new RegExp(String.raw`^BCP: Realizaste un consumo de ${MONEY} con tu Tarjeta de Debito \*(\d{4}) en (.{1,80}?) el ${DATE}\.?$`, 'i'),
    type: 'expense', direction: 'outflow', groups: { money: 1, card: 2, merchant: 3, date: 4 },
  },
  {
    re: new RegExp(String.raw`^BCP: Realizaste un pago de ${MONEY} a tu Tarjeta de Credito \*(\d{4}) el ${DATE}\.?$`, 'i'),
    type: 'credit_card_payment', direction: 'outflow', groups: { money: 1, card: 2, date: 3 },
  },
];

export const bcpSmsV1: BankAdapter = {
  institution: 'BCP',
  parserVersion: VERSION,

  canHandle(raw: RawFinancialEvent) {
    return raw.channel === 'sms' && /^BCP:/i.test(raw.body.trim());
  },

  verifySource(raw: RawFinancialEvent) {
    return BCP_SMS_SENDERS.includes(raw.sender.trim().toUpperCase());
  },

  parse(raw: RawFinancialEvent, text: string): ParseResult {
    const body = text.replace(/\s+/g, ' ').trim();
    for (const t of TEMPLATES) {
      const m = t.re.exec(body);
      if (!m) continue;
      const money = parseMoneyExpr(m[t.groups.money]!);
      const occurredAt = parseNumericDate(m[t.groups.date]!);
      if (!money || !occurredAt) {
        return { ok: false, reason: 'malformed', detail: 'amount or date not readable', parserVersion: VERSION };
      }
      const reasons = this.verifySource(raw) ? [] : ['sender_not_verified'];
      return {
        ok: true,
        event: {
          institution: 'BCP',
          channel: 'sms',
          parserVersion: VERSION,
          externalEventId: deriveExternalEventId(raw),
          type: t.type,
          direction: t.direction,
          amountMinor: money.amountMinor,
          currency: money.currency,
          occurredAt,
          merchantRaw: t.groups.merchant ? cleanMerchant(m[t.groups.merchant]) : null,
          cardLast4: m[t.groups.card]!,
          counterpartyAccountLast4: null,
          isOutgoingTransfer: false,
          bankOperationId: null,
          confidence: reasons.length ? 'medium' : 'high',
          confidenceReasons: reasons,
        },
      };
    }
    return { ok: false, reason: 'unknown_template', detail: 'no known BCP SMS pattern', parserVersion: VERSION };
  },
};
