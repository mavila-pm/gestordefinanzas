import type { BankAdapter, ParseFailureReason, ParseResult } from './bank-adapter';
import type { InstitutionCode, RawFinancialEvent } from '../domain/types';
import { bcpEmailV1 } from './adapters/bcp/bcp-email-v1';
import { bcpSmsV1 } from './adapters/bcp/bcp-sms-v1';
import { bbvaEmailV1 } from './adapters/bbva/bbva-email-v1';
import { bbvaPushV1 } from './adapters/bbva/bbva-push-v1';
import { bbvaSmsV1 } from './adapters/bbva/bbva-sms-v1';
import { interbankEmailV1, interbankSmsV1 } from './adapters/interbank/interbank-scaffold';

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
/** SYNTHETIC_UNVERIFIED templates and empty sender allowlists: every BBVA event goes to review. */
export const bbvaAdapters: readonly BankAdapter[] = [bbvaEmailV1, bbvaSmsV1, bbvaPushV1];

/** Scaffold: claims messages naming Interbank (so they are never misread by another bank) and reads nothing yet. */
export const interbankAdapters: readonly BankAdapter[] = [interbankEmailV1, interbankSmsV1];

/** Every adapter the app runs, in registry order. */
export const registeredAdapters: readonly BankAdapter[] = [...bcpAdapters, ...bbvaAdapters, ...interbankAdapters];

export const defaultAdapterRegistry = new AdapterRegistry(registeredAdapters);

/** Banks whose messages are actually read (scaffolds excluded), in registry order. Copy is built from this list. */
export function supportedInstitutions(adapters: readonly BankAdapter[] = registeredAdapters): InstitutionCode[] {
  return [...new Set(adapters.filter((a) => !a.scaffold).map((a) => a.institution))];
}
