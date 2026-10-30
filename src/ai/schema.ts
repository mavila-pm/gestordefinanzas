import type { Currency } from '../domain/money';
import type { ObligationKind } from '../engine/planning';
import { bankIn } from './interpreter';
import { findAmounts, findDays, fold, UNKNOWN, type Amount } from './text';
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

/**
 * { "patches": [...], "bare": {...} } → Interpretation; null when the output is not usable at all. With the person's
 * (sanitized) message, every value is also GROUNDED in it (groundInterpretation): the model reads, it never adds.
 */
export function validateInterpretation(text: string, message?: string): Interpretation | null {
  const o = parseJsonObject(text);
  if (!o || !Array.isArray(o.patches) || o.patches.length > 20) return null;
  const patches = o.patches.map(validatePatch).filter((p): p is Patch => p !== null);
  const b = obj(o.bare);
  const bare: Bare | null = b ? clean({ amountMinor: minor(b.amount), currency: cur(b.currency), approx: bool(b.approx), day: day(b.day), dayMax: day(b.dayMax), unknown: bool(b.unknown),
    frequency: freq(b.frequency) }) : null;
  const read = { patches, bare: bare && Object.keys(bare).length ? bare : null };
  return message === undefined ? read : groundInterpretation(read, message);
}

/**
 * JSON Schema for Gemini structured output on onboarding extraction (responseJsonSchema). One flat patch shape with
 * optional fields (easy to enforce); validatePatch + groundInterpretation still check everything that comes back.
 */
export const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    patches: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          t: { type: 'string', enum: ['income', 'obligation', 'debt', 'account', 'variable', 'balance', 'remove', 'done'] },
          kind: { type: 'string', enum: [...KINDS, 'personal', 'bank'] },
          name: { type: 'string', description: 'Nombre corto tal como lo dijo el usuario, sin números.' },
          amount: { type: 'string', description: 'Monto escrito por el usuario, en decimales ("284.30"). Omitir si no lo dijo.' },
          balance: { type: 'string', description: 'Deuda: lo que debe, escrito por el usuario. Omitir si no lo dijo.' },
          minimum: { type: 'string', description: 'Tarjeta: pago mínimo escrito por el usuario. Omitir si no lo dijo.' },
          currency: { type: 'string', enum: ['PEN', 'USD'] },
          approx: { type: 'boolean' }, unknownAmount: { type: 'boolean' }, unknownBalance: { type: 'boolean' }, unknown: { type: 'boolean' },
          day: { type: 'integer', minimum: 1, maximum: 31 }, dayMax: { type: 'integer', minimum: 1, maximum: 31 }, secondDay: { type: 'integer', minimum: 1, maximum: 31 },
          dueDay: { type: 'integer', minimum: 1, maximum: 31 },
          frequency: { type: 'string', enum: ['monthly', 'semimonthly'] }, isNew: { type: 'boolean' },
          lender: { type: 'string' }, institution: { type: 'string', description: 'Banco mencionado (BCP, BBVA, INTERBANK…).' },
          last4: { type: 'string', description: 'Solo los últimos 4 dígitos, si los dijo.' },
          group: { type: 'string', enum: ['obligations', 'debts'] },
        },
        required: ['t'],
      },
    },
    bare: {
      type: 'object',
      properties: {
        amount: { type: 'string' }, currency: { type: 'string', enum: ['PEN', 'USD'] }, approx: { type: 'boolean' },
        day: { type: 'integer', minimum: 1, maximum: 31 }, dayMax: { type: 'integer', minimum: 1, maximum: 31 }, unknown: { type: 'boolean' },
        frequency: { type: 'string', enum: ['monthly', 'semimonthly'] },
      },
    },
  },
  required: ['patches'],
};

/** What the person's own message lets a model reading contain (folded text; fixed patterns only). */
interface Ground { t: string; amounts: Amount[]; days: Set<number>; digits4: Set<string>; banks: Set<string>; unknown: boolean; dollars: boolean; soles: boolean }
const DOLLARS = /\b(dolar|dolares|usd)\b|us\$|\$/;
const SOLES = /\b(soles?|pen)\b|s\/|\blucas?\b/;
const REMOVAL = /\b(quita|quitalo|quitala|quitar|elimina|eliminalo|eliminar|borra|borralo|borrar|saca|sacalo|ya no|no (pago|tengo|uso|pagamos|tenemos)|cancele|cancelar)\b/;
const CLOSING = /\b(no|nada|ningun|ninguno|ninguna|sin|todo|listo)\b/;
function groundOf(message: string): Ground {
  const t = fold(message);
  const days = findDays(t);
  const daySet = new Set<number>(days.flatMap((d) => [d.day, d.dayMax, d.second].filter((x): x is number => x !== null)));
  // A plain "15 y 30" (no "el") is readable as days too; never a number that is part of an amount ("15 mil", "1,500").
  for (const m of t.matchAll(/(?<![\d.,/$])\b([1-9]|[12]\d|3[01])\b(?![.,]\d|\s*(?:mil|k\b|lucas?|soles?|dolares?|%))/g)) daySet.add(Number(m[1]));
  return { t, amounts: findAmounts(t, days), days: daySet, digits4: new Set(t.match(/(?<!\d)\d{4}(?!\d)/g) ?? []), banks: new Set(bankIn(t)),
    unknown: UNKNOWN.test(t), dollars: DOLLARS.test(t), soles: SOLES.test(t) };
}

/**
 * The amount must be one the person wrote (decimals included); its currency comes from their words: a currency written
 * next to it wins and a model currency that disagrees drops it; dollars without a marker next to the amount only when
 * the message speaks of dollars and never of soles. Spelled-out amounts are not readable here: never guessed.
 */
function groundAmount(m: number | undefined, c: Currency | undefined, g: Ground): { minor: number; currency?: Currency } | null {
  if (m === undefined) return null;
  const hit = g.amounts.find((a) => a.minor === m && (!c || !a.currency || a.currency === c));
  if (!hit) return null;
  if (hit.currency) return { minor: m, currency: hit.currency };
  if (c === 'USD') return g.dollars && !g.soles ? { minor: m, currency: 'USD' } : null;
  return { minor: m };
}
const groundDay = (d: number | undefined, g: Ground) => (d !== undefined && g.days.has(d) ? d : undefined);
const noDigits = (v: string | undefined) => { const s = v?.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim(); return s && s.length >= 2 ? s : undefined; };
const named = (name: string, g: Ground) => { const n = fold(name); return n.length >= 3 && (g.t.includes(n) || n.split(' ').filter((w) => w.length >= 3).some((w) => g.t.includes(w))); };

/** One validated patch, grounded: unreadable values are dropped (unknown stays unknown); null when nothing usable is left. */
function groundPatch(p: Patch, g: Ground): Patch | null {
  const money = (m: number | undefined, c: Currency | undefined, approx: boolean | undefined) => {
    const a = groundAmount(m, c, g);
    return a ? { minor: a.minor, currency: a.currency, approx: approx ? true as const : undefined } : null;
  };
  switch (p.t) {
    case 'income': {
      const a = money(p.amountMinor, p.currency, p.approx);
      const income = clean({ t: 'income' as const, name: noDigits(p.name), amountMinor: a?.minor, currency: a?.currency, approx: a?.approx,
        unknownAmount: !a && p.unknownAmount && g.unknown ? true : undefined, day: groundDay(p.day, g), dayMax: groundDay(p.dayMax, g), secondDay: groundDay(p.secondDay, g),
        frequency: p.frequency, isNew: p.isNew });
      // Nothing left that the person said: no income is created from it.
      return Object.keys(income).length > 1 ? income : null;
    }
    case 'obligation': {
      const name = noDigits(p.name);
      if (!name) return null;
      const a = money(p.amountMinor, p.currency, p.approx);
      return clean({ t: 'obligation' as const, kind: p.kind, name, amountMinor: a?.minor, currency: a?.currency, approx: a?.approx,
        unknownAmount: !a && p.unknownAmount && g.unknown ? true : undefined, day: groundDay(p.day, g), dayMax: groundDay(p.dayMax, g) });
    }
    case 'debt': {
      const name = noDigits(p.name);
      if (!name) return null;
      const bal = money(p.balanceMinor, p.currency, p.approx);
      const min = groundAmount(p.minimumMinor, bal?.currency ?? p.currency, g);
      // PEN ≠ USD: a minimum in another currency than the balance is not kept.
      const minOk = min && (!bal || (min.currency ?? 'PEN') === (bal.currency ?? 'PEN')) ? min : null;
      return clean({ t: 'debt' as const, kind: p.kind, name, lender: noDigits(p.lender), institution: p.institution && g.banks.has(p.institution) ? p.institution : undefined,
        last4: p.last4 && g.digits4.has(p.last4) ? p.last4 : undefined, currency: bal?.currency ?? minOk?.currency,
        balanceMinor: bal?.minor, approx: bal?.approx, unknownBalance: !bal && p.unknownBalance && g.unknown ? true : undefined,
        minimumMinor: minOk?.minor, dueDay: groundDay(p.dueDay, g) });
    }
    case 'account':
      // An account the person did not name is never added ("uso BCP" → BCP; nothing else).
      return g.banks.has(p.institution) ? clean({ t: 'account' as const, institution: p.institution, kind: p.kind, last4: p.last4 && g.digits4.has(p.last4) ? p.last4 : undefined }) : null;
    case 'variable': {
      const name = noDigits(p.name);
      if (!name) return null;
      const a = money(p.amountMinor, p.currency, p.approx);
      return clean({ t: 'variable' as const, name, amountMinor: a?.minor, currency: a?.currency, approx: a?.approx, unknownAmount: !a && p.unknownAmount && g.unknown ? true : undefined });
    }
    case 'balance': {
      const a = money(p.amountMinor, p.currency, undefined);
      if (!a && !(p.unknown && g.unknown)) return null;
      return clean({ t: 'balance' as const, amountMinor: a?.minor, currency: a?.currency, unknown: !a ? true : undefined });
    }
    case 'remove':
      // Only what the person named, and only when they said to drop it.
      return REMOVAL.test(g.t) && named(p.name, g) ? p : null;
    case 'done':
      return CLOSING.test(g.t) ? p : null;
  }
}

/** A model reading checked against the message it read: every amount, day, last 4 and bank must be in it. */
export function groundInterpretation(read: Interpretation, message: string): Interpretation {
  const g = groundOf(message);
  const patches = read.patches.map((p) => groundPatch(p, g)).filter((p): p is Patch => p !== null);
  const b = read.bare;
  let bare: Bare | null = null;
  if (b) {
    const a = groundAmount(b.amountMinor, b.currency, g);
    bare = clean({ amountMinor: a?.minor, currency: a?.currency, approx: a && b.approx ? true : undefined, day: groundDay(b.day, g), dayMax: groundDay(b.dayMax, g),
      unknown: b.unknown && g.unknown ? true : undefined, frequency: b.frequency });
    if (!Object.keys(bare).length) bare = null;
  }
  return { patches, bare };
}

/** Field groups that travel together: a value from one reading is never mixed with the window or state of another. */
const GROUPS: ReadonlyArray<readonly string[]> = [
  ['amountMinor', 'approx', 'unknownAmount', 'currency'], ['day', 'dayMax', 'secondDay', 'approxDay', 'quincena', 'endHint'],
  ['balanceMinor', 'approx', 'unknownBalance', 'currency'], ['minimumMinor', 'currency'], ['dueDay'], ['last4'], ['frequency'],
];
const near = (a: string | undefined, b: string | undefined) => { const x = fold(a ?? ''); const y = fold(b ?? ''); return !!x && !!y && (x.includes(y) || y.includes(x)); };
function sameSubject(a: Patch, b: Patch): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'income': { const o = b as typeof a; return !a.isNew && !o.isNew ? true : near(a.name, o.name); }
    case 'obligation': { const o = b as typeof a; return near(a.name, o.name) || (a.kind === o.kind && !['services', 'subscription', 'other'].includes(a.kind)); }
    case 'debt': {
      const o = b as typeof a;
      if (a.kind !== o.kind) return false;
      return a.kind === 'personal' ? near(a.lender ?? a.name, o.lender ?? o.name) : (a.institution ?? null) === (o.institution ?? null) || near(a.name, o.name);
    }
    case 'account': { const o = b as typeof a; return a.institution === o.institution && a.kind === o.kind; }
    case 'variable': return near(a.name, (b as typeof a).name);
    case 'balance': return true;
    case 'remove': return near(a.name, (b as typeof a).name);
    case 'done': return a.group === (b as typeof a).group;
  }
}

/**
 * A partial rules reading completed by a (grounded) model reading: the model adds what the rules missed; on the same
 * subject the rules' facts win (manual correction > rule > inference), the model only fills a field group the rules
 * left empty. Nothing is duplicated: a model fact about a subject the rules read joins that subject.
 */
export function mergeReadings(local: Interpretation, model: Interpretation): Interpretation {
  const patches = local.patches.map((p) => ({ ...p }));
  const extra: Patch[] = [];
  for (const m of model.patches) {
    const i = patches.findIndex((p) => sameSubject(p, m));
    if (i < 0) {
      // A model "remove X" never undoes something the rules read in the same message.
      if (m.t === 'remove' && local.patches.some((p) => 'name' in p && near(p.name, m.name))) continue;
      extra.push(m);
      continue;
    }
    const target = patches[i] as Record<string, unknown>;
    const add: Record<string, unknown> = { ...m };
    for (const group of GROUPS) if (group.some((k) => target[k] !== undefined)) for (const k of group) delete add[k];
    for (const [k, v] of Object.entries(add)) if (target[k] === undefined) target[k] = v;
  }
  const bare = local.bare ?? model.bare;
  return { patches: [...patches, ...extra], bare };
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
