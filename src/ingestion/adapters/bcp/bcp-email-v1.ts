import type { BankAdapter, ParseResult } from '../../bank-adapter';
import type { Direction, NormalizedFinancialEvent, RawFinancialEvent, TransactionType } from '../../../domain/types';
import { parseSpanishLongDate } from '../../lima-time';
import { deriveExternalEventId } from '../../sanitize';
import { BCP_EMAIL_SENDER_DOMAINS, cleanMerchant, last4, parseMoneyExpr } from './common';

const VERSION = 'BCP_EMAIL_V1';

interface Template {
  headline: RegExp;
  type: TransactionType;
  direction: Direction;
  outgoingTransfer?: boolean;
  requires: Array<'merchant' | 'card' | 'counterparty'>;
  /** Fact the template cannot establish on its own; forces review. */
  uncertainty?: string;
}

// Order matters: first match wins.
const TEMPLATES: Template[] = [
  { headline: /Realizaste un consumo con tu Tarjeta de Cr[ée]dito/i, type: 'credit_card_purchase', direction: 'outflow', requires: ['merchant', 'card'] },
  { headline: /Realizaste un consumo con tu Tarjeta de D[ée]bito/i, type: 'expense', direction: 'outflow', requires: ['merchant', 'card'] },
  { headline: /Realizaste un pago de tu Tarjeta de Cr[ée]dito/i, type: 'credit_card_payment', direction: 'outflow', requires: ['card'] },
  { headline: /Se realiz[óo] una devoluci[óo]n/i, type: 'refund', direction: 'inflow', requires: ['merchant', 'card'] },
  { headline: /Se realiz[óo] un extorno/i, type: 'reversal', direction: 'inflow', requires: ['merchant', 'card'] },
  { headline: /Realizaste una transferencia/i, type: 'unknown', direction: 'outflow', outgoingTransfer: true, requires: ['counterparty'] },
  { headline: /Realizaste un retiro/i, type: 'withdrawal', direction: 'outflow', requires: [] },
  { headline: /Recibiste un dep[óo]sito/i, type: 'deposit', direction: 'inflow', requires: [], uncertainty: 'deposit_origin_unknown' },
];

const LABELS = {
  amount: /^Monto(?: total)?:\s*(.+)$/gim,
  date: /^Fecha y hora:\s*(.+)$/gim,
  merchant: /^(?:Empresa|Comercio):\s*(.+)$/gim,
  card: /^N[úu]mero de Tarjeta(?: de Cr[ée]dito| de D[ée]bito)?:\s*(.+)$/gim,
  counterparty: /^Cuenta destino:\s*(.+)$/gim,
  operation: /^N[úu]mero de operaci[óo]n:\s*(\S+)$/gim,
} as const;

type LabelKey = keyof typeof LABELS;

/** Returns the label value, or 'ambiguous' when the label appears more than once. */
function readLabel(text: string, key: LabelKey): string | undefined | 'ambiguous' {
  const matches = [...text.matchAll(LABELS[key])];
  if (matches.length > 1) return 'ambiguous';
  return matches[0]?.[1]?.trim();
}

export const bcpEmailV1: BankAdapter = {
  institution: 'BCP',
  parserVersion: VERSION,

  canHandle(raw: RawFinancialEvent) {
    return raw.channel === 'email' && /\bBCP\b/i.test(`${raw.subject ?? ''}\n${raw.body.slice(0, 4000)}`);
  },

  verifySource(raw: RawFinancialEvent) {
    const domain = /@([a-z0-9.-]+)>?\s*$/i.exec(raw.sender.trim())?.[1]?.toLowerCase();
    return !!domain && BCP_EMAIL_SENDER_DOMAINS.includes(domain);
  },

  parse(raw: RawFinancialEvent, text: string): ParseResult {
    const fail = (reason: 'unknown_template' | 'malformed', detail: string): ParseResult =>
      ({ ok: false, reason, detail, parserVersion: VERSION });

    const haystack = `${raw.subject ?? ''}\n${text}`;
    const tpl = TEMPLATES.find((t) => t.headline.test(haystack));
    if (!tpl) return fail('unknown_template', 'no known BCP headline');

    const values: Partial<Record<LabelKey, string>> = {};
    for (const key of Object.keys(LABELS) as LabelKey[]) {
      const v = readLabel(text, key);
      if (v === 'ambiguous') return fail('malformed', `label "${key}" appears more than once`);
      if (v !== undefined) values[key] = v;
    }

    const money = values.amount ? parseMoneyExpr(values.amount) : null;
    if (!money) return fail('malformed', 'amount/currency not readable');
    const occurredAt = values.date ? parseSpanishLongDate(values.date) : null;
    if (!occurredAt) return fail('malformed', 'date not readable');

    const merchantRaw = cleanMerchant(values.merchant);
    const cardLast4 = last4(values.card);
    const counterpartyAccountLast4 = last4(values.counterparty);

    const reasons: string[] = [];
    if (tpl.requires.includes('merchant') && !merchantRaw) reasons.push('merchant_missing');
    if (tpl.requires.includes('card') && !cardLast4) reasons.push('card_missing');
    if (tpl.requires.includes('counterparty') && !counterpartyAccountLast4) reasons.push('counterparty_missing');
    if (tpl.uncertainty) reasons.push(tpl.uncertainty);
    if (!this.verifySource(raw)) reasons.push('sender_not_verified');

    const event: NormalizedFinancialEvent = {
      institution: 'BCP',
      channel: 'email',
      parserVersion: VERSION,
      externalEventId: deriveExternalEventId(raw),
      type: tpl.type,
      direction: tpl.direction,
      amountMinor: money.amountMinor,
      currency: money.currency,
      occurredAt,
      merchantRaw,
      cardLast4,
      counterpartyAccountLast4,
      isOutgoingTransfer: !!tpl.outgoingTransfer,
      bankOperationId: values.operation ?? null,
      confidence: reasons.length ? 'medium' : 'high',
      confidenceReasons: reasons,
    };
    return { ok: true, event };
  },
};
