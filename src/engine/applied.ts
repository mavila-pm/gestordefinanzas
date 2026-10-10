import type { Currency } from '../domain/money';
import type { LineKind, Plan } from './planning';

/**
 * "Aplicar plan" (ADR-0013): a saved snapshot of the plan the person saw. Pure. Applying never pays, moves money or
 * marks anything paid: a line is `realized` only when a real settlement exists for its obligation and period.
 * Six things stay apart: saldo (base) · comprometido (payments/debts still pending) · reservado (basics, reserves,
 * cushion) · realizado (paid, from real movements) · por confirmar (unknown amounts, never 0) · libre.
 */
export interface AppliedLine { kind: LineKind; label: string; amountMinor: number | null; date: string | null; obligationId: string | null; period: string | null }
export interface AppliedPlan {
  id: string; currency: Currency; status: 'active' | 'superseded' | 'cancelled'; baseKind: 'balance' | 'income'; baseMinor: number;
  fromDate: string; untilDate: string; reservedMinor: number; freeMinor: number; planStatus: 'confirmed' | 'partial';
  lines: AppliedLine[]; createdAt: string; closedAt: string | null;
}
export type LineState = 'realized' | 'pending' | 'late' | 'reserved';
export interface Reconciled {
  plan: AppliedPlan;
  lines: Array<AppliedLine & { state: LineState }>;
  committedMinor: number;
  reservedMinor: number;
  realizedMinor: number;
  unknownCount: number;
  /** Its horizon ended: the next income came (or should have); it stays as history. */
  expired: boolean;
}

const KINDS = new Set<LineKind>(['overdue', 'payment', 'essentials', 'debt', 'reserve', 'cushion']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMITTED = new Set<LineKind>(['overdue', 'payment', 'debt']);

/** Lines to store from a computed plan (server-side; the client never sends amounts). */
export function linesToApply(p: Plan): AppliedLine[] {
  return p.lines.slice(0, 60).map((l) => ({
    kind: l.kind, label: l.label.slice(0, 60), amountMinor: l.amountMinor, date: l.date,
    obligationId: l.obligationId ?? null, period: l.period ?? null,
  }));
}

/** Rows read back are re-validated (defense in depth); anything odd is dropped, never guessed. */
export function validAppliedLines(input: unknown): AppliedLine[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 60).flatMap((x): AppliedLine[] => {
    if (!x || typeof x !== 'object') return [];
    const l = x as Record<string, unknown>;
    if (!KINDS.has(l.kind as LineKind) || typeof l.label !== 'string') return [];
    const amount = l.amountMinor === null ? null : typeof l.amountMinor === 'number' && Number.isSafeInteger(l.amountMinor) && l.amountMinor >= 0 ? l.amountMinor : undefined;
    if (amount === undefined) return [];
    return [{
      kind: l.kind as LineKind, label: l.label.slice(0, 60), amountMinor: amount,
      date: typeof l.date === 'string' && DATE.test(l.date) ? l.date : null,
      obligationId: typeof l.obligationId === 'string' && UUID.test(l.obligationId) ? l.obligationId : null,
      period: typeof l.period === 'string' && PERIOD.test(l.period) ? l.period : null,
    }];
  });
}

export function reconcile(plan: AppliedPlan, today: string, settled: ReadonlyMap<string, ReadonlySet<string>>): Reconciled {
  let committedMinor = 0, reservedMinor = 0, realizedMinor = 0, unknownCount = 0;
  const lines = plan.lines.map((l) => {
    let state: LineState;
    if (!COMMITTED.has(l.kind)) state = 'reserved';
    else if (l.obligationId && l.period && settled.get(l.obligationId)?.has(l.period)) state = 'realized';
    else state = l.kind === 'overdue' || (l.date !== null && l.date < today) ? 'late' : 'pending';
    if (l.amountMinor === null) unknownCount++;
    else if (state === 'realized') realizedMinor += l.amountMinor;
    else if (state === 'reserved') reservedMinor += l.amountMinor;
    else committedMinor += l.amountMinor;
    return { ...l, state };
  });
  return { plan, lines, committedMinor, reservedMinor, realizedMinor, unknownCount, expired: plan.untilDate < today };
}

/** What the person saw vs what the server computes now: apply only the same plan (a stale tab must re-check). */
export const sameAsSeen = (p: Plan, seenFreeMinor: number | null, seenReservedMinor: number | null) =>
  p.freeMinor !== null && p.freeMinor === seenFreeMinor && p.reservedMinor === seenReservedMinor;
