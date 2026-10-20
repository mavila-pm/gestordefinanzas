import { INSTITUTION_CODES, type CardKind, type Direction, type NormalizedFinancialEvent, type RawFinancialEvent, type SourceChannel, type Transaction, type TransactionSource, type TransactionStatus, type TransactionType } from '../domain/types';
import type { AdapterRegistry } from '../ingestion/adapter-registry';
import { defaultAdapterRegistry } from '../ingestion/adapter-registry';
import { deriveExternalEventId, isWithinSizeLimit, toPlainText } from '../ingestion/sanitize';
import { categorize, normalizeMerchant, type MerchantRule } from './categorizer';
import { financialFingerprint } from './fingerprint';
import { DuplicateSourceError, PlanLimitError, type EventOutcome, type TransactionRepository } from './repository';

/** Cross-source window: email and SMS of the same operation arrive with slightly different times. */
export const STRONG_MATCH_WINDOW_MIN = 10;
export const WEAK_MATCH_WINDOW_MIN = 30;
/** A deposit this close (either side) to a transfer sent from another bank may be the person's own money. */
export const OWN_TRANSFER_WINDOW_MIN = 30;

export interface UserCard {
  last4: string;
  kind: CardKind;
  /** Bank of the card; absent = matches any bank. */
  institution?: string;
}

export interface UserContext {
  userId: string;
  /** Last 4 digits of the user's own accounts, used to prove internal transfers. */
  ownAccountLast4: readonly string[];
  /** Cards registered by the user (alias/last4/kind only, never the full number). */
  cards: readonly UserCard[];
  merchantRules: readonly MerchantRule[];
}

/**
 * What happened to one raw event. `plan_limit`: read fine, but the plan allows no more automatic movements (or no
 * other bank) this month; nothing was created and the trace is stored as 'rejected' with the limit code as detail.
 */
export type IngestOutcome = EventOutcome | 'plan_limit';

export interface IngestResult {
  outcome: IngestOutcome;
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
    // Same rule as public.card_for_event: a card without institution matches any bank.
    const matches = ctx.cards.filter((c) => c.last4 === e.cardLast4 && (!c.institution || c.institution === e.institution));
    const kinds = new Set(matches.map((c) => c.kind));
    if (!matches.length) r.reasons.push('card_not_registered');
    else if (kinds.size > 1) r.reasons.push('card_ambiguous');
    else if (kinds.has('credit')) r.type = 'credit_card_purchase';
  }
  return r;
}

/**
 * What makes two sources "the same kind" for cross-source matching. A pasted SMS and a pasted email are different
 * kinds (distinct parser families) even though both are persisted as channel 'import'.
 */
export function sourceKind(s: Pick<TransactionSource, 'channel' | 'parserVersion'>): string {
  return s.channel === 'import' ? `import:${s.parserVersion}` : s.channel;
}

/**
 * Possible own transfer across banks (suggestion only): money that arrives at one bank while the same amount, in the
 * same currency (PEN never matches USD), left another bank as an outgoing or internal transfer within
 * ±OWN_TRANSFER_WINDOW_MIN. Uses only the existing findCandidates port (one query per other institution), so the
 * in-memory, PostgreSQL and Supabase import repositories all support it. Never changes the type: the person decides.
 */
async function sentFromAnotherBank(userId: string, e: NormalizedFinancialEvent, repo: TransactionRepository): Promise<boolean> {
  const from = shift(e.occurredAt, -minutes(OWN_TRANSFER_WINDOW_MIN));
  const to = shift(e.occurredAt, minutes(OWN_TRANSFER_WINDOW_MIN));
  for (const institution of INSTITUTION_CODES) {
    if (institution === e.institution) continue;
    const found = await repo.findCandidates({ userId, institution, amountMinor: e.amountMinor, currency: e.currency, from, to });
    if (found.some((t) => t.institution === institution && t.currency === e.currency && t.status !== 'ignored'
      && (t.type === 'internal_transfer' || (t.type === 'unknown' && t.direction === 'outflow')))) return true;
  }
  return false;
}

function isStrongMatch(kind: string, e: NormalizedFinancialEvent, type: TransactionType, merchant: string | null, t: Transaction): boolean {
  return t.type === type
    && !!e.cardLast4 && t.cardLast4 === e.cardLast4
    && Math.abs(Date.parse(t.occurredAt) - Date.parse(e.occurredAt)) <= minutes(STRONG_MATCH_WINDOW_MIN)
    && merchantsCompatible(t.merchantNormalized, merchant)
    && !t.sources.some((s) => sourceKind(s) === kind);
}

export interface IngestOptions {
  /** Persist the source as a user import (pasted text) instead of a delivered bank notification. */
  persistAs?: 'import';
  /**
   * Delivered bank notifications (Email Bridge, Android SMS): a template not yet calibrated on real samples
   * (SYNTHETIC_UNVERIFIED) is read but never auto-confirmed ('template_unverified' -> review_required).
   */
  requireVerifiedTemplate?: boolean;
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
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const externalEventId = deriveExternalEventId(raw);
  const channel: Exclude<SourceChannel, 'manual'> = opts.persistAs ?? raw.channel;
  const done = async (outcome: EventOutcome, transactionId: string | null, detail: string | null, parserVersion: string | null) => {
    await repo.recordEvent({ userId: ctx.userId, channel, externalEventId, parserVersion, outcome, detail, transactionId });
    return { outcome, transactionId, detail };
  };

  if (!isWithinSizeLimit(raw)) return done('rejected', null, 'payload exceeds size limit', null);

  // Level 1: exact same source event already processed (idempotency).
  const sameEvent = await repo.findBySource(ctx.userId, channel, externalEventId);
  if (sameEvent) return done('duplicate_same_event', sameEvent.id, null, null);

  // Every adapter that claims the message is tried (verified senders first); two banks reading it -> unresolved.
  const parsed = registry.parse(raw, toPlainText(raw.body));
  if (!parsed) return done('not_financial', null, 'no adapter for this message', null);
  if (!parsed.ok) {
    const outcome = parsed.reason === 'non_transactional' ? 'non_transactional' : 'unresolved';
    return done(outcome, null, `${parsed.reason}: ${parsed.detail}`, parsed.parserVersion);
  }
  const e = parsed.event;
  try {
    return await persist(raw, e, externalEventId, channel, ctx, repo, done, opts);
  } catch (err) {
    if (err instanceof PlanLimitError) {
      await done('rejected', null, err.code, e.parserVersion);
      return { outcome: 'plan_limit', transactionId: null, detail: err.code };
    }
    // A concurrent delivery of the same event won the race: still exactly one transaction.
    if (!(err instanceof DuplicateSourceError)) throw err;
    const winner = await repo.findBySource(ctx.userId, channel, externalEventId);
    return done('duplicate_same_event', winner?.id ?? null, 'concurrent duplicate', e.parserVersion);
  }
}

type Done = (outcome: EventOutcome, transactionId: string | null, detail: string | null, parserVersion: string | null) => Promise<IngestResult>;

async function persist(
  raw: RawFinancialEvent,
  e: NormalizedFinancialEvent,
  externalEventId: string,
  channel: Exclude<SourceChannel, 'manual'>,
  ctx: UserContext,
  repo: TransactionRepository,
  done: Done,
  opts: IngestOptions,
): Promise<IngestResult> {

  const source: TransactionSource = {
    channel, externalEventId, parserVersion: e.parserVersion,
    templateVerification: e.templateVerification, receivedAt: raw.receivedAt,
  };
  const kind = sourceKind(source);
  const merchantNormalized = normalizeMerchant(e.merchantRaw);
  const { type, direction, reasons } = resolveWithUserContext(e, ctx);
  // Pasted text cannot prove it came from the bank: an import is always reviewed by the user, never auto-confirmed.
  if (channel === 'import' && !reasons.includes('user_import')) reasons.push('user_import');
  if (opts.requireVerifiedTemplate && e.templateVerification !== 'VERIFIED' && !reasons.includes('template_unverified')) {
    reasons.push('template_unverified');
  }
  const category = categorize(type, merchantNormalized, ctx.merchantRules);

  // Level 1b: the bank's own operation number identifies the same operation across forwards.
  if (e.bankOperationId) {
    const sameOp = await repo.findByBankOperation(ctx.userId, e.institution, e.bankOperationId);
    if (sameOp && sameOp.amountMinor === e.amountMinor && sameOp.currency === e.currency) {
      if (sameOp.sources.some((s) => sourceKind(s) === kind)) return done('duplicate_same_event', sameOp.id, 'same bank operation id', e.parserVersion);
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
  const strong = sameKind.filter((t) => isStrongMatch(kind, e, type, merchantNormalized, t));
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

  if (type === 'deposit' && direction === 'inflow' && await sentFromAnotherBank(ctx.userId, e, repo)) reasons.push('possible_own_transfer');

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
