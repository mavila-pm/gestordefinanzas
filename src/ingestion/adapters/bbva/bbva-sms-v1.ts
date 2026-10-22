import type { BankAdapter, ParseResult } from '../../bank-adapter';
import type { RawFinancialEvent } from '../../../domain/types';
import { BBVA_SMS_SENDERS, DATE, MONEY, nonTransactionalKind, parseLine, TIME, type LineTemplate } from './common';

const VERSION = 'BBVA_SMS_V1';

const PREFIX = String.raw`^BBVA: ?`;
const AT = String.raw`el ${DATE} ${TIME}\.?$`;

// SYNTHETIC_UNVERIFIED templates (no real BBVA SMS observed). Whole-message anchored: extra text means no match.
const TEMPLATES: LineTemplate[] = [
  {
    re: new RegExp(String.raw`${PREFIX}Compra de ${MONEY} con Tarjeta de Cr[eé]dito \*(\d{4}) en (.{1,80}?) ${AT}`, 'i'),
    type: 'credit_card_purchase', direction: 'outflow', cardKind: 'credit', groups: { money: 1, card: 2, merchant: 3, date: 4, time: 5 },
  },
  {
    re: new RegExp(String.raw`${PREFIX}Compra de ${MONEY} con Tarjeta de D[eé]bito \*(\d{4}) en (.{1,80}?) ${AT}`, 'i'),
    type: 'expense', direction: 'outflow', cardKind: 'debit', groups: { money: 1, card: 2, merchant: 3, date: 4, time: 5 },
  },
  {
    re: new RegExp(String.raw`${PREFIX}Pago de ${MONEY} a tu Tarjeta de Cr[eé]dito \*(\d{4}) ${AT}`, 'i'),
    type: 'credit_card_payment', direction: 'outflow', cardKind: 'credit', groups: { money: 1, card: 2, date: 3, time: 4 },
  },
  {
    re: new RegExp(String.raw`${PREFIX}Transferencia enviada de ${MONEY} a la cuenta \*(\d{4}) ${AT}`, 'i'),
    type: 'unknown', direction: 'outflow', cardKind: null, outgoingTransfer: true, groups: { money: 1, counterparty: 2, date: 3, time: 4 },
  },
  {
    // ATM cash withdrawal: transfer_to_cash, never an ordinary expense (ADR-0002).
    re: new RegExp(String.raw`${PREFIX}Retiro en cajero de ${MONEY} con Tarjeta de D[eé]bito \*(\d{4}) ${AT}`, 'i'),
    type: 'withdrawal', direction: 'outflow', cardKind: 'debit', groups: { money: 1, card: 2, date: 3, time: 4 },
  },
  {
    re: new RegExp(String.raw`${PREFIX}Abono recibido de ${MONEY} en tu cuenta ${AT}`, 'i'),
    type: 'deposit', direction: 'inflow', cardKind: null, uncertainty: 'deposit_origin_unknown', groups: { money: 1, date: 2, time: 3 },
  },
];

export const bbvaSmsV1: BankAdapter = {
  institution: 'BBVA',
  parserVersion: VERSION,
  templateVerification: 'SYNTHETIC_UNVERIFIED',

  canHandle(raw: RawFinancialEvent) {
    return raw.channel === 'sms' && (bbvaSmsV1.verifySource(raw) || /^BBVA:/i.test(raw.body.trim()));
  },

  /** Empty allowlist: no BBVA SMS sender id has been observed. */
  verifySource(raw: RawFinancialEvent) {
    return BBVA_SMS_SENDERS.includes(raw.sender.trim().toUpperCase());
  },

  parse(raw: RawFinancialEvent, text: string): ParseResult {
    const body = text.replace(/\s+/g, ' ').trim();
    const read = parseLine(raw, body, TEMPLATES, VERSION);
    if (read) return read;
    const kind = nonTransactionalKind(body);
    if (kind) return { ok: false, reason: 'non_transactional', detail: kind, parserVersion: VERSION };
    return { ok: false, reason: 'unknown_template', detail: 'no known BBVA SMS pattern', parserVersion: VERSION };
  },
};
