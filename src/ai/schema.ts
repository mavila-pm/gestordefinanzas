import type { Currency } from '../domain/money';
import type { ObligationKind } from '../engine/planning';
import type { Bare, Interpretation, Patch } from './types';

/**
 * Provider output is untrusted input (same rule as bank emails): parse ONE JSON object, keep only known fields with
 * valid types and ranges, drop everything else. A malformed answer yields null (the turn is then asked again).
 */
const KINDS: readonly ObligationKind[] = ['rent', 'car', 'loan', 'card', 'internet', 'phone', 'insurance', 'education', 'services', 'taxes', 'subscription', 'other'];
const MAX_MINOR = 100_000_000_000;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown, max = 60) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);
const bool = (v: unknown) => (v === true ? true : undefined);
const day = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 31 ? v as number : undefined);
const cur = (v: unknown): Currency | undefined => (v === 'PEN' || v === 'USD' ? v : undefined);
/** Amounts arrive as decimal units ("284.30" or 284.3) and become integer minor units via string arithmetic. */
export function minor(v: unknown): number | undefined {
  const s = typeof v === 'number' ? v.toFixed(2) : typeof v === 'string' ? v.trim().replace(/,/g, '') : '';
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const [i = '0', d = ''] = s.split('.');
  const m = Number(i) * 100 + Number(d.padEnd(2, '0'));
  return Number.isSafeInteger(m) && m > 0 && m <= MAX_MINOR ? m : undefined;
}
const freq = (v: unknown): 'monthly' | 'semimonthly' | undefined => (v === 'monthly' || v === 'semimonthly' ? v : undefined);
const clean = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start || end - start > 20_000) return null;
  try { return obj(JSON.parse(text.slice(start, end + 1))); } catch { return null; }
}

export function validatePatch(v: unknown): Patch | null {
  const p = obj(v);
  if (!p) return null;
  switch (p.t) {
    case 'income':
      return clean({ t: 'income' as const, name: str(p.name), amountMinor: minor(p.amount), currency: cur(p.currency), approx: bool(p.approx), unknownAmount: bool(p.unknownAmount),
        day: day(p.day), dayMax: day(p.dayMax), secondDay: day(p.secondDay), frequency: freq(p.frequency), isNew: bool(p.isNew) });
    case 'obligation': {
      const name = str(p.name);
      if (!name) return null;
      return clean({ t: 'obligation' as const, kind: KINDS.includes(p.kind as ObligationKind) ? p.kind as ObligationKind : 'other', name, amountMinor: minor(p.amount), currency: cur(p.currency),
        approx: bool(p.approx), unknownAmount: bool(p.unknownAmount), day: day(p.day), dayMax: day(p.dayMax) });
    }
    case 'debt': {
      const name = str(p.name);
      const kind: 'card' | 'personal' | 'loan' | null = p.kind === 'card' || p.kind === 'personal' || p.kind === 'loan' ? p.kind : null;
      if (!name || !kind) return null;
      return clean({ t: 'debt' as const, kind, name, lender: str(p.lender), institution: str(p.institution, 20)?.toUpperCase(), last4: typeof p.last4 === 'string' && /^\d{4}$/.test(p.last4) ? p.last4 : undefined,
        currency: cur(p.currency), balanceMinor: minor(p.balance), approx: bool(p.approx), unknownBalance: bool(p.unknownBalance), minimumMinor: minor(p.minimum), dueDay: day(p.dueDay) });
    }
    case 'account': {
      const institution = str(p.institution, 20)?.toUpperCase();
      if (!institution || (p.kind !== 'bank' && p.kind !== 'card')) return null;
      return clean({ t: 'account' as const, institution, kind: p.kind as 'bank' | 'card', last4: typeof p.last4 === 'string' && /^\d{4}$/.test(p.last4) ? p.last4 : undefined });
    }
    case 'variable': {
      const name = str(p.name);
      return name ? clean({ t: 'variable' as const, name, amountMinor: minor(p.amount), currency: cur(p.currency), approx: bool(p.approx), unknownAmount: bool(p.unknownAmount) }) : null;
    }
    case 'balance':
      return clean({ t: 'balance' as const, amountMinor: minor(p.amount), currency: cur(p.currency), unknown: bool(p.unknown) });
    case 'remove': { const name = str(p.name); return name ? { t: 'remove', name } : null; }
    case 'done': return p.group === 'obligations' || p.group === 'debts' ? { t: 'done', group: p.group } : null;
    default: return null;
  }
}

/** { "patches": [...], "bare": {...} } → Interpretation; null when the output is not usable at all. */
export function validateInterpretation(text: string): Interpretation | null {
  const o = parseJsonObject(text);
  if (!o || !Array.isArray(o.patches) || o.patches.length > 20) return null;
  const patches = o.patches.map(validatePatch).filter((p): p is Patch => p !== null);
  const b = obj(o.bare);
  const bare: Bare | null = b ? clean({ amountMinor: minor(b.amount), currency: cur(b.currency), approx: bool(b.approx), day: day(b.day), dayMax: day(b.dayMax), unknown: bool(b.unknown),
    frequency: freq(b.frequency) }) : null;
  return { patches, bare: bare && Object.keys(bare).length ? bare : null };
}

// ── Vision extraction contract (§58): structured facts only, the engine decides ─────────────────────────
export type DocumentKind = 'card_statement' | 'loan' | 'bill' | 'receipt' | 'bank_screen' | 'other';
export interface VisionFacts {
  document: DocumentKind;
  institution: string | null; last4: string | null; currency: Currency | null;
  balanceMinor: number | null; paymentMinimumMinor: number | null; paymentTotalMinor: number | null; amountMinor: number | null;
  dueDate: string | null; cutDate: string | null; merchant: string | null;
  confidence: 'high' | 'medium' | 'low'; uncertain: string[];
}
const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);

export function validateVision(text: string): VisionFacts | null {
  const o = parseJsonObject(text);
  if (!o) return null;
  const docs: DocumentKind[] = ['card_statement', 'loan', 'bill', 'receipt', 'bank_screen', 'other'];
  const facts: VisionFacts = {
    document: docs.includes(o.document as DocumentKind) ? o.document as DocumentKind : 'other',
    institution: str(o.institution, 30)?.toUpperCase() ?? null,
    last4: typeof o.last4 === 'string' && /^\d{4}$/.test(o.last4) ? o.last4 : null,
    currency: cur(o.currency) ?? null,
    balanceMinor: minor(o.balance) ?? null, paymentMinimumMinor: minor(o.payment_minimum) ?? null, paymentTotalMinor: minor(o.payment_total) ?? null,
    amountMinor: minor(o.amount) ?? null, dueDate: date(o.due_date), cutDate: date(o.cut_date), merchant: str(o.merchant, 60) ?? null,
    confidence: o.confidence === 'high' || o.confidence === 'medium' ? o.confidence : 'low',
    uncertain: Array.isArray(o.uncertain) ? o.uncertain.filter((x): x is string => typeof x === 'string').slice(0, 10) : [],
  };
  const any = facts.balanceMinor ?? facts.paymentMinimumMinor ?? facts.paymentTotalMinor ?? facts.amountMinor ?? facts.dueDate;
  return any === null ? { ...facts, confidence: 'low' } : facts;
}
