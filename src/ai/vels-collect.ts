import type { Currency } from '../domain/money';
import { addDays } from '../domain/dates';
import type { Intent, View } from './assistant';
import { money } from './draft';
import { interpret } from './interpreter';
import { fold, UNKNOWN } from './text';

/**
 * Vels asks for what a money question needs, one thing per turn (balance → next income date + amount), instead of
 * listing missing fields. The thread itself is the state: the last Vels message carries `pending` (what the next
 * reply answers), `resume` (the question to answer once the data is there) and `draft` (what was already said).
 * Thread rows are client-insertable, so all three are re-validated here before use. Nothing here computes money:
 * the engine answers once the facts are stored.
 */
export type CollectPending = 'balance' | 'currency' | 'income' | 'income_date' | 'income_amount' | 'income_days';
export const COLLECT_PENDING: readonly CollectPending[] = ['balance', 'currency', 'income', 'income_date', 'income_amount', 'income_days'];

/** Questions that need today's balance and the next income; anything else answers as before. */
export type Resume = { k: 'free' } | { k: 'why_free' } | { k: 'card_limit' } | { k: 'organize' } | { k: 'how' } | { k: 'balance' } | { k: 'next_income' }
  | { k: 'can_spend'; amountMinor: number; currency: Currency };
export interface Draft {
  balanceMinor?: number;
  amountMinor?: number;
  currency?: Currency;
  approx?: boolean;
  day?: number;
  secondDay?: number;
  semimonthly?: boolean;
}
export interface IncomeFact { day: number; secondDay: number | null; amountMinor: number | null; currency: Currency; approx: boolean }

const MAX = 100_000_000_000;
const okMinor = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= MAX;
const okDay = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 31;
const okCur = (c: unknown): c is Currency => c === 'PEN' || c === 'USD';

export function asResume(i: Intent | unknown): Resume | null {
  const x = i as Record<string, unknown> | null;
  if (!x || typeof x !== 'object') return null;
  if (x.k === 'free' || x.k === 'why_free' || x.k === 'card_limit' || x.k === 'organize' || x.k === 'how' || x.k === 'balance' || x.k === 'next_income') return { k: x.k };
  if (x.k === 'can_spend' && okMinor(x.amountMinor) && okCur(x.currency)) return { k: 'can_spend', amountMinor: x.amountMinor as number, currency: x.currency };
  return null;
}

export function asDraft(v: unknown): Draft {
  const x = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d: Draft = {};
  if (okMinor(x.balanceMinor)) d.balanceMinor = x.balanceMinor as number;
  if (okMinor(x.amountMinor)) d.amountMinor = x.amountMinor as number;
  if (okCur(x.currency)) d.currency = x.currency;
  if (x.approx === true) d.approx = true;
  if (okDay(x.day)) d.day = x.day as number;
  if (okDay(x.secondDay)) d.secondDay = x.secondDay as number;
  if (x.semimonthly === true) d.semimonthly = true;
  return d;
}

const plan = (v: View, currency?: Currency) => v.plans.find((p) => p.currency === (currency ?? 'PEN')) ?? v.plans.find((p) => p.base) ?? v.plans[0] ?? null;
const resumeCurrency = (r: Resume | null): Currency => (r?.k === 'can_spend' ? r.currency : 'PEN');

/** The next fact the question needs, in conversational order; null when the engine can answer. */
export function gapFor(v: View, r: Resume | null): 'balance' | 'income' | null {
  const p = plan(v, resumeCurrency(r));
  // "¿Cuánto tengo?" needs only the balance; "¿Cuándo me pagan?" only the income.
  if (r?.k === 'next_income') return v.plans.some((x) => x.nextIncome) ? null : 'income';
  if (!p?.base) return 'balance';
  if (r?.k === 'balance') return null;
  if (!p.nextIncome) return 'income';
  return null;
}

export interface Ask { text: string; pending: CollectPending; replies?: string[] }

/** The question for a gap, phrased like a person; `opening` = first message after the person's question. */
export function ask(gap: 'balance' | 'income', r: Resume | null, opening: boolean, prefix = ''): Ask {
  const lead = prefix ? `${prefix} ` : '';
  if (gap === 'balance') {
    const text = !opening ? '¿Cuánto tienes disponible hoy?' : r?.k === 'free' ? 'Claro. ¿Cuánto tienes disponible hoy?'
      : r?.k === 'can_spend' ? 'Te lo calculo. ¿Cuánto tienes disponible hoy?' : r?.k === 'balance' ? 'Aún no lo sé. ¿Cuánto tienes disponible hoy?' : 'Sí, lo vemos. ¿Cuánto tienes disponible hoy?';
    return { text: lead + text, pending: 'balance' };
  }
  const opener = prefix ? '' : r?.k === 'next_income' ? 'Aún no lo tengo. ' : opening ? 'Ya tengo tu saldo. ' : '';
  return { text: `${lead}${opener}¿Cuándo vuelves a recibir dinero y de cuánto será?`, pending: 'income' };
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
/** "el próximo viernes", "este lunes", "mañana", "pasado mañana" → a date after today (Lima calendar). */
export function relativeDate(folded: string, today: string): string | null {
  if (/\bpasado manana\b/.test(folded)) return addDays(today, 2);
  if (/\bmanana\b/.test(folded)) return addDays(today, 1);
  const m = /\b(?:el |este |proximo |el proximo |este proximo )?(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/.exec(folded);
  if (!m) return null;
  const target = WEEKDAYS.indexOf(m[1]!);
  const now = new Date(`${today}T00:00:00Z`).getUTCDay();
  const ahead = ((target - now + 7) % 7) || 7;
  return addDays(today, ahead);
}

export type Reply =
  | { kind: 'balance'; minor: number; currency: Currency; approx: boolean }
  | { kind: 'income'; income: IncomeFact; balance?: { minor: number; currency: Currency } }
  | { kind: 'ask'; pending: CollectPending; draft: Draft; text: string; replies?: string[]; balance?: { minor: number; currency: Currency } }
  | { kind: 'none' };

/**
 * Reads the person's answer to a pending question. Deterministic (interpret() + dates); a value is taken only when
 * it is literally there. `usesUsd`: the person has dollar data, so a bare amount needs its currency asked.
 */
export function readReply(pending: CollectPending, draft0: Draft, text: string, today: string, usesUsd: boolean): Reply {
  const t0 = fold(text);
  // "15 y 30", "el 15 y el 30": two pay days (read here; the generic reader would take "15" as an amount).
  const pair = /\b(?:el\s+|los\s+)?([1-9]|[12]\d|3[01])\s*(?:y|,)\s*(?:el\s+)?([1-9]|[12]\d|3[01])\b(?!\s*(?:mil|k\b|soles|dolares|[.,]\d))/.exec(t0);
  const days = pair && Number(pair[2]) > Number(pair[1]) && pending !== 'balance' && pending !== 'currency' ? [Number(pair[1]), Number(pair[2])] as const : null;
  const t = days ? t0.replace(pair![0], ' ') : t0;
  const { patches, bare } = interpret(t);
  const inc = patches.find((p) => p.t === 'income') as Extract<typeof patches[number], { t: 'income' }> | undefined;
  const bal = patches.find((p) => p.t === 'balance') as Extract<typeof patches[number], { t: 'balance' }> | undefined;
  const draft: Draft = { ...draft0 };
  if (days) { draft.day = days[0]; draft.secondDay = days[1]; draft.semimonthly = true; }

  if (pending === 'balance' || pending === 'currency') {
    if (pending === 'currency') {
      const cur: Currency | null = /\b(dolar|dolares|usd|us\$)\b/.test(t) ? 'USD' : /\b(sol|soles|pen)\b/.test(t) ? 'PEN' : null;
      if (cur && draft.balanceMinor) return { kind: 'balance', minor: draft.balanceMinor, currency: cur, approx: !!draft.approx };
      return { kind: 'none' };
    }
    // "me pagan 4500 el 15" while Vels asked the balance: keep the income, ask the balance again.
    if (inc && !bal && bare?.amountMinor === undefined) {
      const income = incomeFrom(draft, inc, null, t, today);
      if (income) return { kind: 'income', income };
    }
    const minor = bal?.amountMinor ?? bare?.amountMinor;
    if (!okMinor(minor)) return { kind: 'none' };
    const currency = bal?.currency ?? bare?.currency ?? null;
    if (!currency && usesUsd) {
      return { kind: 'ask', pending: 'currency', draft: { balanceMinor: minor!, approx: !!bare?.approx }, text: `¿Esos ${money(minor!, 'PEN').replace('S/ ', '')} son soles o dólares?`, replies: ['Soles', 'Dólares'] };
    }
    return { kind: 'balance', minor: minor!, currency: currency ?? 'PEN', approx: !!bare?.approx };
  }

  // Income: date and amount, in any order and over one or two turns.
  if ((UNKNOWN.test(t) || bare?.unknown) && pending === 'income_amount' && draft.day) {
    return { kind: 'income', income: { day: draft.day, secondDay: draft.secondDay ?? null, amountMinor: null, currency: draft.currency ?? 'PEN', approx: false } };
  }
  const income = incomeFrom(draft, inc, bare, t, today);
  if (income) return { kind: 'income', income };
  if (draft.semimonthly && !draft.secondDay) return { kind: 'ask', pending: 'income_days', draft, text: '¿Qué días te pagan?', replies: ['El 15 y el 30'] };
  if (draft.day && !draft.amountMinor) return { kind: 'ask', pending: 'income_amount', draft, text: '¿Y cuánto esperas recibir?', replies: ['No sé todavía'] };
  if (draft.amountMinor && !draft.day) return { kind: 'ask', pending: 'income_date', draft, text: '¿Y qué día te pagan?' };
  return { kind: 'none' };

  /** Merges what this message says into the draft; returns the income once its date is known and the amount answered. */
  function incomeFrom(d: Draft, p: typeof inc, b: typeof bare, raw: string, day0: string): IncomeFact | null {
    const amount = p?.amountMinor ?? b?.amountMinor;
    if (okMinor(amount)) { d.amountMinor = amount; d.currency = p?.currency ?? b?.currency ?? d.currency; d.approx = !!(p?.approx ?? b?.approx); }
    const day = p?.day ?? b?.day;
    if (okDay(day)) d.day = day;
    const second = p?.secondDay;
    if (okDay(second) && second !== d.day) { d.secondDay = second; d.semimonthly = true; }
    if (p?.frequency === 'semimonthly' || /\bquincena\b/.test(raw)) d.semimonthly = true;
    if (!d.day) { const rel = relativeDate(raw, day0); if (rel) d.day = Number(rel.slice(8, 10)); }
    // A quincena without its two days is asked, never guessed.
    if (d.semimonthly && !d.secondDay) return null;
    if (!d.day || !d.amountMinor) return null;
    return { day: d.day, secondDay: d.secondDay ?? null, amountMinor: d.amountMinor, currency: d.currency ?? 'PEN', approx: !!d.approx };
  }
}

/** Short confirmation of what was understood (only facts the person gave; no math). */
/** Varies the lead word by the amount itself (no randomness: the same input always reads the same). */
export const saidBalance = (minor: number, c: Currency) => `${['Listo', 'Lo tengo', 'Perfecto'][Math.floor(minor / 100) % 3]}: ${money(minor, c)} disponibles.`;
export const saidIncome = (i: IncomeFact) =>
  `Anotado: ${i.amountMinor === null ? 'tu ingreso' : `${i.approx ? 'unos ' : ''}${money(i.amountMinor, i.currency)}`} el ${i.day}${i.secondDay ? ` y el ${i.secondDay}` : ''}.`;
