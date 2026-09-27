import type { BankAdapter, ParseResult } from '../../bank-adapter';
import type { CardKind, Direction, NormalizedFinancialEvent, RawFinancialEvent, TransactionType } from '../../../domain/types';
import { limaIso, parseNumericDate, parseSpanishLongDate } from '../../lima-time';
import { deriveExternalEventId } from '../../sanitize';
import { BCP_EMAIL_SENDER_DOMAINS, cleanMerchant, last4, parseMoneyExpr } from './common';

const VERSION = 'BCP_EMAIL_V1';

/**
 * Genuine BCP emails that are not money movements. Backed by a real observed sample
 * (statement email from estadodecuenta@notificacionesbcp.com.pe).
 */
const NON_TRANSACTIONAL: Array<{ test: (raw: RawFinancialEvent) => boolean; kind: string }> = [
  { kind: 'account_statement', test: (r) => /^\s*Estado de Cuenta\b/i.test(r.subject ?? '') || /estadodecuenta@/i.test(r.sender) },
];

interface Template {
  headline: RegExp;
  type: TransactionType;
  direction: Direction;
  cardKind?: CardKind;
  outgoingTransfer?: boolean;
  /** Required value of the "Operación:" label, for generic "operación con tu tarjeta" emails. */
  operation?: RegExp;
  requires: Array<'merchant' | 'card' | 'counterparty'>;
  /** Fact the template cannot establish on its own; forces review. */
  uncertainty?: string;
}

// SYNTHETIC_UNVERIFIED templates. Order matters: first match wins.
const TEMPLATES: Template[] = [
  { headline: /Realizaste un consumo con tu Tarjeta de Cr[ée]dito/i, type: 'credit_card_purchase', direction: 'outflow', cardKind: 'credit', requires: ['merchant', 'card'] },
  { headline: /Realizaste un consumo con tu Tarjeta de D[ée]bito/i, type: 'expense', direction: 'outflow', cardKind: 'debit', requires: ['merchant', 'card'] },
  // Structure proposed by the Product Owner (wording/sender still to be validated with real emails).
  // The email does not say credit or debit: the engine resolves it from the user's registered cards.
  { headline: /Se realiz[óo] una operaci[óo]n con tu tarjeta/i, operation: /^Consumo$/i, type: 'expense', direction: 'outflow', requires: ['merchant', 'card'] },
  { headline: /Realizaste un pago de tu Tarjeta de Cr[ée]dito/i, type: 'credit_card_payment', direction: 'outflow', cardKind: 'credit', requires: ['card'] },
  { headline: /Se realiz[óo] una devoluci[óo]n/i, type: 'refund', direction: 'inflow', requires: ['merchant', 'card'] },
  { headline: /Se realiz[óo] un extorno/i, type: 'reversal', direction: 'inflow', requires: ['merchant', 'card'] },
  { headline: /Realizaste una transferencia/i, type: 'unknown', direction: 'outflow', outgoingTransfer: true, requires: ['counterparty'] },
  { headline: /Realizaste un retiro/i, type: 'withdrawal', direction: 'outflow', requires: [] },
  { headline: /Recibiste un dep[óo]sito/i, type: 'deposit', direction: 'inflow', requires: [], uncertainty: 'deposit_origin_unknown' },
];

const LABELS = {
  amount: /^Monto(?: total)?:\s*(.+)$/gim,
  dateTime: /^Fecha y hora:\s*(.+)$/gim,
  date: /^Fecha:\s*(.+)$/gim,
  time: /^Hora:\s*(.+)$/gim,
  merchant: /^(?:Empresa|Comercio|Establecimiento):\s*(.+)$/gim,
  card: /^N[úu]mero de Tarjeta(?: de Cr[ée]dito| de D[ée]bito)?:\s*(.+)$/gim,
  cardInline: /tarjeta terminada en\s*([*xX•]*\s*\d{4})\b/gim,
  counterparty: /^Cuenta destino:\s*(.+)$/gim,
  operationKind: /^Operaci[óo]n:\s*(.+)$/gim,
  operation: /^N[úu]mero de operaci[óo]n:\s*(\S+)$/gim,
} as const;

type LabelKey = keyof typeof LABELS;

/** Returns the label value, or 'ambiguous' when the label appears more than once. */
function readLabel(text: string, key: LabelKey): string | undefined | 'ambiguous' {
  const matches = [...text.matchAll(LABELS[key])];
  if (matches.length > 1) return 'ambiguous';
  return matches[0]?.[1]?.trim();
}

function readDate(v: Partial<Record<LabelKey, string>>): string | null {
  if (v.dateTime) return parseSpanishLongDate(v.dateTime);
  if (v.date && v.time) {
    const t = /^(\d{1,2}):(\d{2})$/.exec(v.time.trim());
    const d = parseNumericDate(`${v.date.trim()} 00:00`);
    if (!t || !d) return null;
    return limaIso(Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10)), Number(t[1]), Number(t[2]));
  }
  return null;
}

export const bcpEmailV1: BankAdapter = {
  institution: 'BCP',
  parserVersion: VERSION,
  templateVerification: 'SYNTHETIC_UNVERIFIED',

  canHandle(raw: RawFinancialEvent) {
    return raw.channel === 'email'
      && (bcpEmailV1.verifySource(raw) || /\bBCP\b/i.test(`${raw.subject ?? ''}\n${raw.body.slice(0, 4000)}`));
  },

  verifySource(raw: RawFinancialEvent) {
    const domain = /@([a-z0-9.-]+)>?\s*$/i.exec(raw.sender.trim())?.[1]?.toLowerCase();
    return !!domain && BCP_EMAIL_SENDER_DOMAINS.includes(domain);
  },

  parse(raw: RawFinancialEvent, text: string): ParseResult {
    const fail = (reason: 'unknown_template' | 'malformed' | 'non_transactional', detail: string): ParseResult =>
      ({ ok: false, reason, detail, parserVersion: VERSION });

    const nonTx = NON_TRANSACTIONAL.find((n) => n.test(raw));
    if (nonTx) return fail('non_transactional', nonTx.kind);

    const values: Partial<Record<LabelKey, string>> = {};
    for (const key of Object.keys(LABELS) as LabelKey[]) {
      const v = readLabel(text, key);
      if (v === 'ambiguous') return fail('malformed', `label "${key}" appears more than once`);
      if (v !== undefined) values[key] = v;
    }

    const haystack = `${raw.subject ?? ''}\n${text}`;
    const tpl = TEMPLATES.find((t) => t.headline.test(haystack) && (!t.operation || t.operation.test(values.operationKind ?? '')));
    if (!tpl) return fail('unknown_template', 'no known BCP headline');

    const money = values.amount ? parseMoneyExpr(values.amount) : null;
    if (!money) return fail('malformed', 'amount/currency not readable');
    const occurredAt = readDate(values);
    if (!occurredAt) return fail('malformed', 'date not readable');

    const merchantRaw = cleanMerchant(values.merchant);
    const cardFromLabel = last4(values.card);
    const cardFromText = last4(values.cardInline);
    if (cardFromLabel && cardFromText && cardFromLabel !== cardFromText) return fail('malformed', 'conflicting card numbers');
    const cardLast4 = cardFromLabel ?? cardFromText;
    const counterpartyAccountLast4 = last4(values.counterparty);

    const reasons: string[] = [];
    if (tpl.requires.includes('merchant') && !merchantRaw) reasons.push('merchant_missing');
    if (tpl.requires.includes('card') && !cardLast4) reasons.push('card_missing');
    if (tpl.requires.includes('counterparty') && !counterpartyAccountLast4) reasons.push('counterparty_missing');
    if (tpl.uncertainty) reasons.push(tpl.uncertainty);
    if (!bcpEmailV1.verifySource(raw)) reasons.push('sender_not_verified');

    const event: NormalizedFinancialEvent = {
      institution: 'BCP',
      channel: 'email',
      parserVersion: VERSION,
      templateVerification: bcpEmailV1.templateVerification,
      externalEventId: deriveExternalEventId(raw),
      type: tpl.type,
      direction: tpl.direction,
      amountMinor: money.amountMinor,
      currency: money.currency,
      occurredAt,
      merchantRaw,
      cardLast4,
      cardKind: tpl.cardKind ?? null,
      counterpartyAccountLast4,
      isOutgoingTransfer: !!tpl.outgoingTransfer,
      bankOperationId: values.operation ?? null,
      confidence: reasons.length ? 'medium' : 'high',
      confidenceReasons: reasons,
    };
    return { ok: true, event };
  },
};
