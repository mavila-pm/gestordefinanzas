import type { NormalizedFinancialEvent, RawFinancialEvent, Transaction, TransactionStatus } from '../domain/types';
import type { AdapterRegistry } from '../ingestion/adapter-registry';
import { defaultAdapterRegistry } from '../ingestion/adapter-registry';
import { deriveExternalEventId, isWithinSizeLimit, toPlainText } from '../ingestion/sanitize';
import { categorize, normalizeMerchant, type MerchantRule } from './categorizer';
import { financialFingerprint } from './fingerprint';
import type { EventOutcome, TransactionRepository } from './repository';

/** Cross-source window: email and SMS of the same operation arrive with slightly different times. */
export const STRONG_MATCH_WINDOW_MIN = 10;
export const WEAK_MATCH_WINDOW_MIN = 30;

export interface UserContext {
  userId: string;
  /** Last 4 digits of the user's own accounts, used to prove internal transfers. */
  ownAccountLast4: readonly string[];
  merchantRules: readonly MerchantRule[];
}

export interface IngestResult {
  outcome: EventOutcome;
  transactionId: string | null;
  detail: string | null;
}

const minutes = (n: number) => n * 60_000;
const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

function merchantsCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function isStrongMatch(e: NormalizedFinancialEvent, merchant: string | null, t: Transaction): boolean {
  return t.type === e.type
    && !!e.cardLast4 && t.cardLast4 === e.cardLast4
    && Math.abs(Date.parse(t.occurredAt) - Date.parse(e.occurredAt)) <= minutes(STRONG_MATCH_WINDOW_MIN)
    && merchantsCompatible(t.merchantNormalized, merchant)
    && !t.sources.some((s) => s.channel === e.channel);
}

/**
 * RAW EVENT -> ADAPTER -> NORMALIZED EVENT -> DEDUPE -> CATEGORY -> CONFIDENCE -> REPOSITORY.
 * Never throws for bad input: one invalid event must not stop a sync.
 */
export async function ingestRawEvent(
  raw: RawFinancialEvent,
  ctx: UserContext,
  repo: TransactionRepository,
  registry: AdapterRegistry = defaultAdapterRegistry,
): Promise<IngestResult> {
  const externalEventId = deriveExternalEventId(raw);
  const done = async (outcome: EventOutcome, transactionId: string | null, detail: string | null, parserVersion: string | null) => {
    await repo.recordEvent({ userId: ctx.userId, channel: raw.channel, externalEventId, parserVersion, outcome, detail, transactionId });
    return { outcome, transactionId, detail };
  };

  if (!isWithinSizeLimit(raw)) return done('rejected', null, 'payload exceeds size limit', null);

  // Level 1: exact same source event already processed (idempotency).
  const sameEvent = await repo.findBySource(ctx.userId, raw.channel, externalEventId);
  if (sameEvent) return done('duplicate_same_event', sameEvent.id, null, null);

  const adapter = registry.resolve(raw);
  if (!adapter) return done('not_financial', null, 'no adapter for this message', null);

  const parsed = adapter.parse(raw, toPlainText(raw.body));
  if (!parsed.ok) return done('unresolved', null, `${parsed.reason}: ${parsed.detail}`, parsed.parserVersion);
  const e = parsed.event;

  const source = { channel: e.channel, externalEventId, parserVersion: e.parserVersion, receivedAt: raw.receivedAt };
  const merchantNormalized = normalizeMerchant(e.merchantRaw);
  const category = categorize(e.type, merchantNormalized, ctx.merchantRules);

  // Level 1b: the bank's own operation number identifies the same operation across forwards.
  if (e.bankOperationId) {
    const sameOp = await repo.findByBankOperation(ctx.userId, e.institution, e.bankOperationId);
    if (sameOp && sameOp.amountMinor === e.amountMinor && sameOp.currency === e.currency) {
      if (sameOp.sources.some((s) => s.channel === e.channel)) return done('duplicate_same_event', sameOp.id, 'same bank operation id', e.parserVersion);
      await repo.addSource(sameOp.id, source, {});
      return done('merged_cross_source', sameOp.id, 'same bank operation id', e.parserVersion);
    }
  }

  // Levels 2-3: financial fingerprint and cross-source matching.
  const candidates = await repo.findCandidates({
    userId: ctx.userId, institution: e.institution, amountMinor: e.amountMinor, currency: e.currency,
    from: shift(e.occurredAt, -minutes(WEAK_MATCH_WINDOW_MIN)), to: shift(e.occurredAt, minutes(WEAK_MATCH_WINDOW_MIN)),
  });
  const sameKind = candidates.filter((t) => t.type === e.type || (e.isOutgoingTransfer && t.type === 'internal_transfer'));
  const strong = sameKind.filter((t) => isStrongMatch(e, merchantNormalized, t));
  if (strong.length === 1) {
    const target = strong[0]!;
    const patch = target.merchantRaw ? {} : { merchantRaw: e.merchantRaw, merchantNormalized, category };
    await repo.addSource(target.id, source, patch);
    return done('merged_cross_source', target.id, null, e.parserVersion);
  }

  // Resolve type/status. Uncertainty always goes to review; nothing is invented.
  let type = e.type;
  let direction = e.direction;
  const reasons = [...e.confidenceReasons];
  if (e.isOutgoingTransfer) {
    if (e.counterpartyAccountLast4 && ctx.ownAccountLast4.includes(e.counterpartyAccountLast4)) {
      type = 'internal_transfer';
      direction = 'neutral';
    } else {
      reasons.push('transfer_destination_not_own');
    }
  }

  let originalTransactionId: string | null = null;
  if (type === 'refund' || type === 'reversal') {
    const original = await repo.findRefundOriginal(ctx.userId, {
      institution: e.institution, cardLast4: e.cardLast4, merchantNormalized, amountMinor: e.amountMinor, currency: e.currency, occurredAt: e.occurredAt,
    });
    originalTransactionId = original?.id ?? null;
  }

  const weakMatch = strong.length > 1 ? strong[0]! : sameKind[0];
  let status: TransactionStatus = reasons.length ? 'review_required' : 'confirmed';
  let outcome: EventOutcome = 'created';
  if (weakMatch) {
    status = 'possible_duplicate';
    outcome = 'possible_duplicate';
  }

  const tx = await repo.insert({
    userId: ctx.userId,
    occurredAt: e.occurredAt,
    type,
    direction,
    amountMinor: e.amountMinor,
    currency: e.currency,
    institution: e.institution,
    cardLast4: e.cardLast4,
    merchantRaw: e.merchantRaw,
    merchantNormalized,
    category,
    status,
    confidence: reasons.length ? 'medium' : e.confidence,
    fingerprint: financialFingerprint(ctx.userId, e),
    sources: [source],
    originalTransactionId,
    duplicateOfId: weakMatch?.id ?? null,
  }, e.bankOperationId);
  return done(outcome, tx.id, reasons.join(',') || null, e.parserVersion);
}
