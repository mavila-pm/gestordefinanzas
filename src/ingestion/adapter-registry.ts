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
 * the same message successfully (or the header names one bank and another bank's adapter reads the body), so the bank
 * cannot be known from the text; nothing is guessed (goes to unresolved).
 */
export type RoutedParse =
  | ParseResult
  | { ok: false; reason: 'ambiguous_institution'; detail: string; parserVersion: null };

/** How strongly an adapter's claim on a message is backed. Lower is stronger. */
const Evidence = { VerifiedSender: 0, NamedInHeader: 1, MentionedInBody: 2 } as const;
type Evidence = (typeof Evidence)[keyof typeof Evidence];

/**
 * When every deciding candidate fails, the most informative failure is reported. `non_transactional` ("no movement,
 * nothing to do") ranks LAST: it is reported only when every deciding adapter says so, because telling the person a
 * real movement is just a notice would lose it; unresolved asks them to register it.
 */
const FAILURE_ORDER: Record<ParseFailureReason, number> = { malformed: 0, unknown_template: 1, non_transactional: 2 };

interface Tried extends Candidate { result: ParseResult }

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
   * - Otherwise, when the sender/subject names a bank, only the named bank(s) can be the result. Another bank's adapter
   *   that only saw its name in the body can never take the message: if it reads it successfully the bank is unclear
   *   -> `ambiguous_institution` (e.g. an Interbank email saying "transferencia a una cuenta BCP").
   * - With no bank in the header, every candidate decides; successful reads from two different banks ->
   *   `ambiguous_institution` (never pick one at random).
   * - All deciding candidates failed -> the most informative failure (see FAILURE_ORDER).
   */
  parse(raw: RawFinancialEvent, text: string): RoutedParse | null {
    const all = this.candidates(raw);
    if (!all.length) return null;
    const run = (c: Candidate): Tried => ({ ...c, result: c.adapter.parse(raw, text) });

    const verified = all.filter((c) => c.evidence === Evidence.VerifiedSender);
    if (verified.length) return decide(verified.map(run));

    const named = new Set(all.filter((c) => c.evidence === Evidence.NamedInHeader).map((c) => c.adapter.institution));
    const tried = all.map(run);
    if (!named.size) return decide(tried);
    const deciding = tried.filter((t) => named.has(t.adapter.institution));
    const bodyOnlyReads = tried.filter((t) => !named.has(t.adapter.institution) && t.result.ok);
    if (bodyOnlyReads.length) return ambiguous([...deciding.filter((t) => t.result.ok), ...bodyOnlyReads]);
    return decide(deciding);
  }
}

function ambiguous(reads: readonly Tried[]): RoutedParse {
  return { ok: false, reason: 'ambiguous_institution', detail: reads.map((t) => t.adapter.parserVersion).join(','), parserVersion: null };
}

/** Candidates are already strongest-evidence first. */
function decide(tried: readonly Tried[]): RoutedParse {
  const oks = tried.filter((t) => t.result.ok);
  if (new Set(oks.map((t) => t.adapter.institution)).size > 1) return ambiguous(oks);
  if (oks.length) return oks[0]!.result;
  const rank = (r: ParseResult) => (r.ok ? -1 : FAILURE_ORDER[r.reason]);
  return [...tried].sort((a, b) => a.evidence - b.evidence || rank(a.result) - rank(b.result) || a.index - b.index)[0]!.result;
}

export const bcpAdapters: readonly BankAdapter[] = [bcpEmailV1, bcpSmsV1];
/** SYNTHETIC_UNVERIFIED templates and empty sender allowlists: every BBVA event goes to review. */
export const bbvaAdapters: readonly BankAdapter[] = [bbvaEmailV1, bbvaSmsV1, bbvaPushV1];

/**
 * Scaffold: claims messages naming Interbank and reads nothing yet. When Interbank is named in the sender/subject,
 * another bank reading the body makes the message ambiguous_institution (unresolved), never that bank's movement.
 */
export const interbankAdapters: readonly BankAdapter[] = [interbankEmailV1, interbankSmsV1];

/** Every adapter the app runs, in registry order. */
export const registeredAdapters: readonly BankAdapter[] = [...bcpAdapters, ...bbvaAdapters, ...interbankAdapters];

export const defaultAdapterRegistry = new AdapterRegistry(registeredAdapters);

const unique = (adapters: readonly BankAdapter[]) => [...new Set(adapters.map((a) => a.institution))];

/**
 * Banks we can say we read: at least one adapter backed by real observed messages (scaffolds excluded), in registry
 * order. Copy is built from this list, never from invented templates.
 */
export function supportedInstitutions(adapters: readonly BankAdapter[] = registeredAdapters): InstitutionCode[] {
  return unique(adapters.filter((a) => !a.scaffold && a.observed));
}

/** Banks read only with invented templates (nothing observed yet): shown as "en prueba", never as supported. */
export function trialInstitutions(adapters: readonly BankAdapter[] = registeredAdapters): InstitutionCode[] {
  const supported = new Set(supportedInstitutions(adapters));
  return unique(adapters.filter((a) => !a.scaffold && !supported.has(a.institution)));
}
