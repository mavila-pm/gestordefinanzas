import type { BankAdapter, ParseResult } from '../../bank-adapter';
import type { RawFinancialEvent } from '../../../domain/types';
import { DATE, MONEY, nonTransactionalKind, parseLine, TIME, type LineTemplate } from './common';

/**
 * BBVA app notification (push) text pasted by the person in the SMS/notification field. A push has no sender id, so
 * it can never be source-verified. The notification title "BBVA" must be the first line: without it the bank cannot
 * be known and the text is not financial for us.
 */
const VERSION = 'BBVA_PUSH_V1';

const TITLE = String.raw`^BBVA(?: Per[uú])? `;
const AT = String.raw`el ${DATE} a las ${TIME}\.?$`;

// SYNTHETIC_UNVERIFIED templates (no real BBVA notification observed). Whole-message anchored.
const TEMPLATES: LineTemplate[] = [
  {
    re: new RegExp(String.raw`${TITLE}Compraste ${MONEY} en (.{1,80}?) con tu tarjeta de cr[eé]dito \*(\d{4}) ${AT}`, 'i'),
    type: 'credit_card_purchase', direction: 'outflow', cardKind: 'credit', groups: { money: 1, merchant: 2, card: 3, date: 4, time: 5 },
  },
  {
    re: new RegExp(String.raw`${TITLE}Compraste ${MONEY} en (.{1,80}?) con tu tarjeta de d[eé]bito \*(\d{4}) ${AT}`, 'i'),
    type: 'expense', direction: 'outflow', cardKind: 'debit', groups: { money: 1, merchant: 2, card: 3, date: 4, time: 5 },
  },
  {
    re: new RegExp(String.raw`${TITLE}Pagaste ${MONEY} de tu tarjeta de cr[eé]dito \*(\d{4}) ${AT}`, 'i'),
    type: 'credit_card_payment', direction: 'outflow', cardKind: 'credit', groups: { money: 1, card: 2, date: 3, time: 4 },
  },
  {
    re: new RegExp(String.raw`${TITLE}Enviaste ${MONEY} a la cuenta \*(\d{4}) ${AT}`, 'i'),
    type: 'unknown', direction: 'outflow', cardKind: null, outgoingTransfer: true, groups: { money: 1, counterparty: 2, date: 3, time: 4 },
  },
  {
    re: new RegExp(String.raw`${TITLE}Recibiste ${MONEY} en tu cuenta ${AT}`, 'i'),
    type: 'deposit', direction: 'inflow', cardKind: null, uncertainty: 'deposit_origin_unknown', groups: { money: 1, date: 2, time: 3 },
  },
];

export const bbvaPushV1: BankAdapter = {
  institution: 'BBVA',
  parserVersion: VERSION,
  templateVerification: 'SYNTHETIC_UNVERIFIED',

  canHandle(raw: RawFinancialEvent) {
    return raw.channel === 'sms' && /^BBVA(?: Per[uú])?[ \t]*\r?\n/i.test(raw.body.trim());
  },

  /** A pasted notification has no sender: never verified. */
  verifySource() {
    return false;
  },

  parse(raw: RawFinancialEvent, text: string): ParseResult {
    const body = text.replace(/\s+/g, ' ').trim();
    const read = parseLine(raw, body, TEMPLATES, VERSION);
    if (read) return read;
    const kind = nonTransactionalKind(body);
    if (kind) return { ok: false, reason: 'non_transactional', detail: kind, parserVersion: VERSION };
    return { ok: false, reason: 'unknown_template', detail: 'no known BBVA notification pattern', parserVersion: VERSION };
  },
};
