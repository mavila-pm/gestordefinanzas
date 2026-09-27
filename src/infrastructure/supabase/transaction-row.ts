import type { Transaction } from '../../domain/types';
import { toLimaIso } from '../../ingestion/lima-time';

/** Row shape returned by `transactions?select=*,category:categories(name),sources:transaction_sources(...)`. */
export interface TransactionRow {
  id: string;
  user_id: string;
  occurred_at: string;
  type: Transaction['type'];
  direction: Transaction['direction'];
  amount_minor: number | string;
  currency: Transaction['currency'];
  institution_code: Transaction['institution'];
  card_last4: string | null;
  merchant_raw: string | null;
  merchant_normalized: string | null;
  status: Transaction['status'];
  confidence: Transaction['confidence'];
  fingerprint: string;
  original_transaction_id: string | null;
  duplicate_of_id: string | null;
  category: { name: string } | null;
  sources: Array<{ channel: Transaction['sources'][number]['channel']; external_event_id: string; parser_version: string; template_verification: Transaction['sources'][number]['templateVerification']; received_at: string }> | null;
}

export const TRANSACTION_SELECT =
  'id,user_id,occurred_at,type,direction,amount_minor,currency,institution_code,card_last4,merchant_raw,merchant_normalized,' +
  'status,confidence,fingerprint,original_transaction_id,duplicate_of_id,category:categories(name),' +
  'sources:transaction_sources(channel,external_event_id,parser_version,template_verification,received_at)';

export function rowToTransaction(r: TransactionRow): Transaction {
  const amountMinor = typeof r.amount_minor === 'string' ? Number(r.amount_minor) : r.amount_minor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error(`invalid amount_minor for ${r.id}`);
  return {
    id: r.id, userId: r.user_id, occurredAt: toLimaIso(new Date(r.occurred_at)), type: r.type, direction: r.direction,
    amountMinor, currency: r.currency, institution: r.institution_code, cardLast4: r.card_last4,
    merchantRaw: r.merchant_raw, merchantNormalized: r.merchant_normalized, category: r.category?.name ?? null,
    status: r.status, confidence: r.confidence, fingerprint: r.fingerprint,
    sources: (r.sources ?? []).map((s) => ({
      channel: s.channel, externalEventId: s.external_event_id, parserVersion: s.parser_version,
      templateVerification: s.template_verification, receivedAt: new Date(s.received_at).toISOString(),
    })),
    originalTransactionId: r.original_transaction_id, duplicateOfId: r.duplicate_of_id,
  };
}
