import type { BankAdapter, ParseFailureReason, ParseResult } from './bank-adapter';
import type { RawFinancialEvent } from '../domain/types';
import { bcpEmailV1 } from './adapters/bcp/bcp-email-v1';
import { bcpSmsV1 } from './adapters/bcp/bcp-sms-v1';

/**
 * What routing + parsing produced for one raw event. `ambiguous_institution`: adapters of two different banks read
 * the same message successfully, so the bank cannot be known from the text; nothing is guessed (goes to unresolved).
 */
export type RoutedParse =
  | ParseResult
  | { ok: false; reason: 'ambiguous_institution'; detail: string; parserVersion: null };

/** How strongly an adapter's claim on a message is backed. Lower is stronger. */
const Evidence = { VerifiedSender: 0, NamedInHeader: 1, MentionedInBody: 2 } as const;
type Evidence = (typeof Evidence)[keyof typeof Evidence];

/** When every candidate fails, the most informative failure is reported. */
const FAILURE_ORDER: Record<ParseFailureReason, number> = { non_transactional: 0, malformed: 1, unknown_template: 2 };

export interface Candidate { adapter: BankAdapter; evidence: Evidence; index: number }

/** The only place that knows which banks exist. New banks/versions are registered here. */
export class AdapterRegistry {
  constructor(private readonly adapters: readonly BankAdapter[]) {}

  /**
   * Adapters that claim the event, strongest evidence first:
   * 1. the sender is one of the bank's observed official senders (verifySource);
   * 2. the adapter claims it from the sender/subject alone (the bank is named in the header);
   * 3. the bank is only mentioned in the body (e.g. "transferencia a una cuenta BCP" inside another bank's email).
   */
  candidates(raw: RawFinancialEvent): Candidate[] {
    const header: RawFinancialEvent = { ...raw, body: '' };
    return this.adapters
      .map((adapter, index) => ({ adapter, index }))
      .filter(({ adapter }) => adapter.canHandle(raw))
      .map(({ adapter, index }): Candidate => ({
        adapter,
        index,
        evidence: adapter.verifySource(raw) ? Evidence.VerifiedSender
          : adapter.canHandle(header) ? Evidence.NamedInHeader : Evidence.MentionedInBody,
      }))
      .sort((a, b) => a.evidence - b.evidence || a.index - b.index);
  }

  /**
   * Routes and parses. Returns null when no adapter claims the message (not financial).
   * - A verified sender decides the bank: only that bank's adapters are tried.
   * - Otherwise every candidate is tried (a mention of another bank's name never hijacks the message).
   * - Successful reads from two different banks -> `ambiguous_institution` (never pick one at random).
   * - All failed -> the failure of the best-evidenced adapter (then the most informative reason).
   */
  parse(raw: RawFinancialEvent, text: string): RoutedParse | null {
    const all = this.candidates(raw);
    if (!all.length) return null;
    const verified = all.filter((c) => c.evidence === Evidence.VerifiedSender);
    const tried = (verified.length ? verified : all).map((c) => ({ ...c, result: c.adapter.parse(raw, text) }));

    const oks = tried.filter((t) => t.result.ok);
    const banks = [...new Set(oks.map((t) => t.adapter.institution))];
    if (banks.length > 1) {
      return { ok: false, reason: 'ambiguous_institution', detail: oks.map((t) => t.adapter.parserVersion).join(','), parserVersion: null };
    }
    if (oks.length) return oks[0]!.result;

    const rank = (r: ParseResult) => (r.ok ? -1 : FAILURE_ORDER[r.reason]);
    tried.sort((a, b) => a.evidence - b.evidence || rank(a.result) - rank(b.result) || a.index - b.index);
    return tried[0]!.result;
  }
}

export const bcpAdapters: readonly BankAdapter[] = [bcpEmailV1, bcpSmsV1];

export const defaultAdapterRegistry = new AdapterRegistry([...bcpAdapters]);
