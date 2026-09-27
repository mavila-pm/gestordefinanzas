import type { CardKind, Direction, NormalizedFinancialEvent, RawFinancialEvent, Transaction, TransactionStatus, TransactionType } from '../domain/types';
import type { AdapterRegistry } from '../ingestion/adapter-registry';
import { defaultAdapterRegistry } from '../ingestion/adapter-registry';
import { deriveExternalEventId, isWithinSizeLimit, toPlainText } from '../ingestion/sanitize';
import { categorize, normalizeMerchant, type MerchantRule } from './categorizer';
import { financialFingerprint } from './fingerprint';
import type { EventOutcome, TransactionRepository } from './repository';

/** Cross-source window: email and SMS of the same operation arrive with slightly different times. */
export const STRONG_MATCH_WINDOW_MIN = 10;
export const WEAK_MATCH_WINDOW_MIN = 30;

export interface UserCard {
  last4: string;
  kind: CardKind;
}

export interface UserContext {
  userId: string;
  /** Last 4 digits of the user's own accounts, used to prove internal transfers. */
  ownAccountLast4: readonly string[];
  /** Cards registered by the user (alias/last4/kind only, never the full number). */
  cards: readonly UserCard[];
  merchantRules: readonly MerchantRule[];
}

export interface IngestResult {
  outcome: EventOutcome;
  transactionId: string | null;
  detail: string | null;
}

interface Resolved {
  type: TransactionType;
  direction: Direction;
  reasons: string[];
}

const minutes = (n: number) => n * 60_000;
const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

function merchantsCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** Facts the adapter cannot know (user's own accounts and cards) are resolved here. */
function resolveWithUserContext(e: NormalizedFinancialEvent, ctx: UserContext): Resolved {
  const r: Resolved = { type: e.type, direction: e.direction, reasons: [...e.confidenceReasons] };
  if (e.isOutgoingTransfer) {
    if (e.counterpartyAccountLast4 && ctx.ownAccountLast4.includes(e.counterpartyAccountLast4)) {
      r.type = 'internal_transfer';
      r.direction = 'neutral';
    } else {
      r.reasons.push('transfer_destination_not_own');
    }
  }
  if (e.type === 'expense' && e.cardKind === null && e.cardLast4) {
    const card = ctx.cards.find((c) => c.last4 === e.cardLast4);
    if (card?.kind === 'credit') r.type = 'credit_card_purchase';
    else if (!card) r.reasons.push('card_not_registered');
  }
  return r;
}

function isStrongMatch(e: NormalizedFinancialEvent, type: TransactionType, merchant: string | null, t: Transaction): boolean {
  return t.type === type
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
  if (!parsed.ok) {
    const outcome = parsed.reason === 'non_transactional' ? 'non_transactional' : 'unresolved';
    return done(outcome, null, `${parsed.reason}: ${parsed.detail}`, parsed.parserVersion);
  }
  const e = parsed.event;

  const source = {
    channel: e.channel, externalEventId, parserVersion: e.parserVersion,
    templateVerification: e.templateVerification, receivedAt: raw.receivedAt,
  };
  const merchantNormalized = normalizeMerchant(e.merchantRaw);
  const { type, direction, reasons } = resolveWithUserContext(e, ctx);
  const category = categorize(type, merchantNormalized, ctx.merchantRules);

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
  const sameKind = candidates.filter((t) => t.type === type);
  const strong = sameKind.filter((t) => isStrongMatch(e, type, merchantNormalized, t));
  if (strong.length === 1) {
    const target = strong[0]!;
    const patch = target.merchantRaw ? {} : { merchantRaw: e.merchantRaw, merchantNormalized, category };
    await repo.addSource(target.id, source, patch);
    return done('merged_cross_source', target.id, null, e.parserVersion);
  }

  let originalTransactionId: string | null = null;
  if (type === 'refund' || type === 'reversal') {
    const original = await repo.findRefundOriginal(ctx.userId, {
      institution: e.institution, cardLast4: e.cardLast4, merchantNormalized, amountMinor: e.amountMinor, currency: e.currency, occurredAt: e.occurredAt,
    });
    originalTransactionId = original?.id ?? null;
  }

  // Uncertainty always goes to review; weak similarity is flagged, never dropped.
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
    fingerprint: financialFingerprint(ctx.userId, { ...e, type }),
    sources: [source],
    originalTransactionId,
    duplicateOfId: weakMatch?.id ?? null,
  }, e.bankOperationId);
  return done(outcome, tx.id, reasons.join(',') || null, e.parserVersion);
}
