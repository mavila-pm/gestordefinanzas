import type { BankAdapter, ParseResult } from '../../bank-adapter';
import type { RawFinancialEvent } from '../../../domain/types';
import { cleanMerchant, emailDomain, labelProblemDetail, last4, parseDateAndTime, parseMoneyExpr, readLabels } from '../../parse-helpers';
import { BBVA_EMAIL_SENDER_DOMAINS, bbvaEvent, nonTransactionalKind, type EventShape } from './common';

const VERSION = 'BBVA_EMAIL_V1';

interface Template extends EventShape {
  headline: RegExp;
  requires: Array<'merchant' | 'card' | 'counterparty'>;
}

// SYNTHETIC_UNVERIFIED templates (no real BBVA email observed). Exactly one headline may appear: a promo line or a
// quoted original ("Compra realizada con tu Tarjeta..." inside a refund) makes the message unreadable, never a
// purchase. Wording is distinct from the BCP templates on purpose, so one message is never read by both banks.
const TEMPLATES: Template[] = [
  { headline: /Compra realizada con tu Tarjeta de Cr[ée]dito/i, type: 'credit_card_purchase', direction: 'outflow', cardKind: 'credit', requires: ['merchant', 'card'] },
  { headline: /Compra realizada con tu Tarjeta de D[ée]bito/i, type: 'expense', direction: 'outflow', cardKind: 'debit', requires: ['merchant', 'card'] },
  { headline: /Pago de tu Tarjeta de Cr[ée]dito registrado/i, type: 'credit_card_payment', direction: 'outflow', cardKind: 'credit', requires: ['card'] },
  { headline: /Devoluci[óo]n de compra en tu Tarjeta/i, type: 'refund', direction: 'inflow', cardKind: null, requires: ['merchant', 'card'] },
  { headline: /Extorno de operaci[óo]n en tu Tarjeta/i, type: 'reversal', direction: 'inflow', cardKind: null, requires: ['merchant', 'card'] },
  // Own vs third-party account is resolved by the engine from the person's registered accounts.
  { headline: /Transferencia enviada desde tu cuenta/i, type: 'unknown', direction: 'outflow', cardKind: null, outgoingTransfer: true, requires: ['counterparty'] },
  // ATM cash withdrawal: transfer_to_cash, never an ordinary expense (ADR-0002), like BCP.
  { headline: /Retiro en cajero autom[áa]tico/i, type: 'withdrawal', direction: 'outflow', cardKind: null, requires: [] },
  { headline: /Abono recibido en tu cuenta/i, type: 'deposit', direction: 'inflow', cardKind: null, requires: [], uncertainty: 'deposit_origin_unknown' },
];

const LABELS = {
  amount: /^Importe:\s*(.+)$/gim,
  merchant: /^Comercio:\s*(.+)$/gim,
  card: /^Tarjeta:\s*(.+)$/gim,
  counterparty: /^Cuenta (?:de )?destino:\s*(.+)$/gim,
  date: /^Fecha:\s*(.+)$/gim,
  time: /^Hora:\s*(.+)$/gim,
  operation: /^N(?:[°º]|[úu]mero) de operaci[óo]n:\s*(\S+)$/gim,
} as const;

export const bbvaEmailV1: BankAdapter = {
  institution: 'BBVA',
  parserVersion: VERSION,
  templateVerification: 'SYNTHETIC_UNVERIFIED',

  canHandle(raw: RawFinancialEvent) {
    return raw.channel === 'email'
      && (bbvaEmailV1.verifySource(raw) || /\bBBVA\b/i.test(`${raw.sender}\n${raw.subject ?? ''}\n${raw.body.slice(0, 4000)}`));
  },

  /** Empty allowlist: no BBVA sender has been observed, so no BBVA email is ever source-verified. */
  verifySource(raw: RawFinancialEvent) {
    const domain = emailDomain(raw.sender);
    return !!domain && BBVA_EMAIL_SENDER_DOMAINS.includes(domain);
  },

  parse(raw: RawFinancialEvent, text: string): ParseResult {
    const fail = (reason: 'unknown_template' | 'malformed' | 'non_transactional', detail: string): ParseResult =>
      ({ ok: false, reason, detail, parserVersion: VERSION });

    const haystack = `${raw.subject ?? ''}\n${text}`;
    const matched = TEMPLATES.filter((t) => t.headline.test(haystack));
    if (matched.length > 1) return fail('malformed', 'more than one movement headline');
    const tpl = matched[0];
    if (!tpl) {
      // Only when no movement template matched and no amount is printed: a footer never turns a movement into a notice.
      const kind = nonTransactionalKind(haystack);
      return kind ? fail('non_transactional', kind) : fail('unknown_template', 'no known BBVA headline');
    }

    const labels = readLabels(text, LABELS);
    if (!labels.ok) return fail('malformed', labelProblemDetail(labels));
    const v = labels.values;

    const money = v.amount ? parseMoneyExpr(v.amount) : null;
    if (!money) return fail('malformed', 'amount/currency not readable');
    const occurredAt = v.date && v.time ? parseDateAndTime(v.date, v.time) : null;
    if (!occurredAt) return fail('malformed', 'date not readable');

    const merchantRaw = cleanMerchant(v.merchant);
    const cardLast4 = last4(v.card);
    const counterpartyAccountLast4 = last4(v.counterparty);
    const reasons: string[] = [];
    if (tpl.requires.includes('merchant') && !merchantRaw) reasons.push('merchant_missing');
    if (tpl.requires.includes('card') && !cardLast4) reasons.push('card_missing');
    if (tpl.requires.includes('counterparty') && !counterpartyAccountLast4) reasons.push('counterparty_missing');

    return {
      ok: true,
      event: bbvaEvent(raw, 'email', VERSION, tpl, {
        amountMinor: money.amountMinor, currency: money.currency, occurredAt, merchantRaw, cardLast4, counterpartyAccountLast4,
        bankOperationId: v.operation ?? null, reasons,
      }),
    };
  },
};
