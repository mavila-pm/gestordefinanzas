import type { Currency } from '../domain/money';
import { formatMoney } from '../domain/money';
import { BANK_LABEL } from './interpreter';
import { fold } from './text';
import type { Bare, DebtFact, Draft, FactStatus, Patch } from './types';

/**
 * Onboarding draft engine (ADR-0006): merges validated patches into the structured draft, decides the ONE next
 * question that matters, and builds the compact summary. Pure and deterministic: no provider involved.
 */

let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const status = (known: boolean, approx?: boolean): FactStatus => (!known ? 'unknown' : approx ? 'estimated' : 'confirmed');
const same = (a: string, b: string) => fold(a) === fold(b);

export interface Changed { label: string; value: string }
export interface MergeResult { draft: Draft; changed: Changed[] }

export const money = (minor: number | null, currency: Currency) => (minor === null ? 'Por confirmar' : formatMoney({ amountMinor: minor, currency }).replace(/\.00$/, ''));
const dayText = (day: number | null, dayMax: number | null, second?: number | null, st?: FactStatus) =>
  day === null ? 'día por confirmar' : second ? `días ${day} y ${second}` : dayMax ? `${day}–${dayMax} aprox.` : `día ${day}${st === 'estimated' ? ' aprox.' : ''}`;

export function mergePatches(draft0: Draft, patches: readonly Patch[], bare: Bare | null): MergeResult {
  const draft: Draft = structuredClone(draft0);
  const touched = new Set<string>();

  for (const p of patches) {
    switch (p.t) {
      case 'income': {
        let inc = p.isNew ? undefined : draft.incomes[0];
        if (!inc) {
          inc = { id: newId('i'), name: p.name ?? 'Sueldo', currency: p.currency ?? 'PEN', amountMinor: null, amountStatus: 'unknown', frequency: null, day: null, dayMax: null, secondDay: null, dayStatus: 'unknown' };
          draft.incomes.push(inc);
        }
        if (p.currency) inc.currency = p.currency;
        if (p.amountMinor !== undefined) { inc.amountMinor = p.amountMinor; inc.amountStatus = status(true, p.approx); }
        else if (p.unknownAmount) { inc.amountMinor = null; inc.amountStatus = 'unknown'; }
        if (p.day !== undefined) { inc.day = p.day; inc.dayMax = p.dayMax ?? null; inc.secondDay = p.secondDay ?? null; inc.dayStatus = status(true, p.approxDay); }
        if (p.frequency) inc.frequency = p.frequency;
        else if (inc.day !== null && !inc.frequency) inc.frequency = inc.secondDay ? 'semimonthly' : 'monthly';
        touched.add(`income:${inc.id}`);
        break;
      }
      case 'obligation': {
        let o = draft.obligations.find((x) => same(x.name, p.name) || (x.kind === p.kind && p.kind !== 'services' && p.kind !== 'subscription' && p.kind !== 'other'));
        if (!o) {
          o = { id: newId('o'), name: p.name, kind: p.kind, currency: p.currency ?? 'PEN', amountMinor: null, amountStatus: 'unknown', day: null, dayMax: null, dayStatus: 'unknown' };
          draft.obligations.push(o);
        }
        if (p.currency) o.currency = p.currency;
        if (p.amountMinor !== undefined) { o.amountMinor = p.amountMinor; o.amountStatus = status(true, p.approx); }
        else if (p.unknownAmount) { o.amountMinor = null; o.amountStatus = 'unknown'; }
        if (p.day !== undefined) { o.day = p.day; o.dayMax = p.dayMax ?? null; o.dayStatus = status(true, p.approxDay); }
        touched.add(`obligation:${o.id}`);
        break;
      }
      case 'debt': {
        let d = draft.debts.find((x) => x.kind === p.kind && (p.kind === 'personal' ? x.lender === (p.lender ?? null) : (x.institution ?? p.institution ?? null) === (p.institution ?? x.institution ?? null)));
        if (!d) {
          d = { id: newId('d'), name: p.name, kind: p.kind, lender: p.lender ?? null, institution: p.institution ?? null, last4: null, currency: p.currency ?? 'PEN', balanceMinor: null, balanceStatus: 'unknown', minimumMinor: null, dueDay: null };
          draft.debts.push(d);
        }
        if (p.institution && !d.institution) { d.institution = p.institution; d.name = p.name; }
        if (p.last4) d.last4 = p.last4;
        if (p.currency) d.currency = p.currency;
        if (p.balanceMinor !== undefined) { d.balanceMinor = p.balanceMinor; d.balanceStatus = status(true, p.approx); }
        else if (p.unknownBalance) { d.balanceMinor = null; d.balanceStatus = 'unknown'; }
        if (p.minimumMinor !== undefined) d.minimumMinor = p.minimumMinor;
        if (p.dueDay !== undefined) d.dueDay = p.dueDay;
        touched.add(`debt:${d.id}`);
        break;
      }
      case 'account': {
        const a = draft.accounts.find((x) => x.institution === p.institution && x.kind === p.kind && (!p.last4 || !x.last4 || x.last4 === p.last4));
        if (a) { if (p.last4) a.last4 = p.last4; }
        else draft.accounts.push({ id: newId('a'), institution: p.institution, kind: p.kind, last4: p.last4 ?? null });
        // A card account also names the card debt, if any, by its last digits.
        if (p.kind === 'card' && p.last4) for (const d of draft.debts) if (d.kind === 'card' && (!d.institution || d.institution === p.institution) && !d.last4) d.last4 = p.last4;
        touched.add(`account:${p.institution}:${p.kind}`);
        break;
      }
      case 'variable': {
        let v = draft.variable.find((x) => same(x.name, p.name));
        if (!v) { v = { id: newId('v'), name: p.name, currency: p.currency ?? 'PEN', amountMinor: null, amountStatus: 'unknown' }; draft.variable.push(v); }
        if (p.amountMinor !== undefined) { v.amountMinor = p.amountMinor; v.amountStatus = status(true, p.approx); }
        else if (p.unknownAmount) { v.amountMinor = null; v.amountStatus = 'unknown'; }
        touched.add(`variable:${v.id}`);
        break;
      }
      case 'balance':
        draft.balance = p.unknown || p.amountMinor === undefined
          ? { currency: p.currency ?? 'PEN', amountMinor: null, status: 'unknown' }
          : { currency: p.currency ?? 'PEN', amountMinor: p.amountMinor, status: 'confirmed' };
        touched.add('balance');
        break;
      case 'remove': {
        const n = fold(p.name);
        const hit = (name: string) => fold(name).includes(n) || n.includes(fold(name));
        draft.obligations = draft.obligations.filter((o) => !hit(o.name));
        draft.variable = draft.variable.filter((v) => !hit(v.name));
        draft.debts = draft.debts.filter((d) => !hit(d.name) && !(d.lender && hit(d.lender)));
        touched.add(`removed:${p.name}`);
        break;
      }
      case 'done':
        if (!draft.done.includes(p.group)) draft.done.push(p.group);
        break;
    }
  }

  if (bare && draft.pending) applyBare(draft, draft.pending, bare, touched);
  // Answered or superseded: the pending question is settled once the person replied anything we could use.
  if (touched.size || bare || patches.length) draft.pending = null;
  return { draft, changed: describe(draft, touched) };
}

/** A value without subject answers the pending question ("950", "el 10", "no sé"). */
function applyBare(d: Draft, key: string, b: Bare, touched: Set<string>) {
  const [kind, id, field] = key.split(':');
  const markUnknown = b.unknown && b.amountMinor === undefined && b.day === undefined;
  if (kind === 'income' && id === 'new') {
    if (b.amountMinor !== undefined || b.day !== undefined || markUnknown) {
      mergeInto(d, { t: 'income', ...(b.amountMinor !== undefined ? { amountMinor: b.amountMinor, approx: b.approx } : {}), ...(b.currency ? { currency: b.currency } : {}),
        ...(b.day !== undefined ? { day: b.day, dayMax: b.dayMax } : {}), ...(markUnknown ? { unknownAmount: true } : {}), ...(b.frequency ? { frequency: b.frequency } : {}) }, touched);
    }
    return;
  }
  if (kind === 'balance') {
    mergeInto(d, markUnknown ? { t: 'balance', unknown: true } : { t: 'balance', amountMinor: b.amountMinor, currency: b.currency }, touched);
    return;
  }
  if (kind === 'group') {
    if (markUnknown) d.done.push(id as 'obligations');
    return;
  }
  if (kind === 'variable' && id === 'basics') {
    mergeInto(d, { t: 'variable', name: 'Gastos básicos', ...(b.amountMinor !== undefined ? { amountMinor: b.amountMinor, approx: b.approx } : { unknownAmount: true }) }, touched);
    return;
  }
  const list = kind === 'income' ? d.incomes : kind === 'obligation' ? d.obligations : kind === 'debt' ? d.debts : [];
  const item = (list as Array<{ id: string }>).find((x) => x.id === id) as Record<string, unknown> | undefined;
  if (!item) return;
  if (field === 'minimum' && kind === 'debt') {
    // The card's minimum payment (never the total, never the balance). "No sé" keeps it unknown.
    if (b.amountMinor !== undefined) { item.minimumMinor = b.amountMinor; if (b.currency) item.currency = b.currency; }
  } else if (field === 'amount' || field === 'balance') {
    const amountKey = field === 'balance' ? 'balanceMinor' : 'amountMinor';
    const statusKey = field === 'balance' ? 'balanceStatus' : 'amountStatus';
    if (b.amountMinor !== undefined) { item[amountKey] = b.amountMinor; item[statusKey] = b.approx ? 'estimated' : 'confirmed'; if (b.currency) item.currency = b.currency; }
    else if (markUnknown) { item[amountKey] = null; item[statusKey] = 'unknown'; }
    if (b.day !== undefined && kind === 'obligation') { item.day = b.day; item.dayMax = b.dayMax ?? null; item.dayStatus = 'confirmed'; }
  } else if (field === 'day') {
    const dayKey = kind === 'debt' ? 'dueDay' : 'day';
    if (b.day !== undefined) { item[dayKey] = b.day; if (kind !== 'debt') { item.dayMax = b.dayMax ?? null; item.dayStatus = b.dayMax ? 'estimated' : 'confirmed'; } }
    else if (markUnknown && kind !== 'debt') item.dayStatus = 'unknown';
    if (b.amountMinor !== undefined && kind === 'obligation') { item.amountMinor = b.amountMinor; item.amountStatus = b.approx ? 'estimated' : 'confirmed'; }
    if (kind === 'income' && b.frequency) item.frequency = b.frequency;
    if (kind === 'income' && item.day !== null && !item.frequency) item.frequency = 'monthly';
  } else if (field === 'frequency' && b.frequency) item.frequency = b.frequency;
  touched.add(`${kind}:${id}`);
}

function mergeInto(d: Draft, p: Patch, touched: Set<string>) {
  const r = mergePatches({ ...d, pending: null }, [p], null);
  Object.assign(d, r.draft);
  for (const c of r.changed) touched.add(`label:${c.label}`);
  // re-mark what the nested merge touched, by id
  if (p.t === 'income') touched.add(`income:${d.incomes[0]?.id}`);
  if (p.t === 'balance') touched.add('balance');
  if (p.t === 'variable') touched.add(`variable:${d.variable.find((v) => same(v.name, p.name))?.id}`);
}

function describe(d: Draft, touched: Set<string>): Changed[] {
  const out: Changed[] = [];
  for (const i of d.incomes) if (touched.has(`income:${i.id}`)) out.push({ label: i.name, value: `${i.amountMinor === null ? 'Monto por confirmar' : money(i.amountMinor, i.currency) + (i.amountStatus === 'estimated' ? ' aprox.' : '')} · ${dayText(i.day, i.dayMax, i.secondDay, i.dayStatus)}` });
  for (const o of d.obligations) if (touched.has(`obligation:${o.id}`)) out.push({ label: o.name, value: `${o.amountMinor === null ? 'Monto por confirmar' : money(o.amountMinor, o.currency) + (o.amountStatus === 'estimated' ? ' aprox.' : '')} · ${dayText(o.day, o.dayMax, null, o.dayStatus)}` });
  for (const x of d.debts) if (touched.has(`debt:${x.id}`)) out.push({ label: debtLabel(x), value: x.balanceMinor === null ? 'Saldo pendiente' : `Debes ${money(x.balanceMinor, x.currency)}${x.balanceStatus === 'estimated' ? ' aprox.' : ''}${x.minimumMinor ? ` · mínimo ${money(x.minimumMinor, x.currency)}` : ''}` });
  for (const a of d.accounts) if (touched.has(`account:${a.institution}:${a.kind}`)) out.push({ label: accountLabel(a), value: a.kind === 'card' ? 'Tarjeta' : 'Cuenta' });
  for (const v of d.variable) if (touched.has(`variable:${v.id}`)) out.push({ label: v.name, value: v.amountMinor === null ? 'Monto por confirmar' : `${money(v.amountMinor, v.currency)} al mes${v.amountStatus === 'estimated' ? ' aprox.' : ''}` });
  if (touched.has('balance') && d.balance) out.push({ label: 'Saldo de hoy', value: money(d.balance.amountMinor, d.balance.currency) });
  for (const k of touched) if (k.startsWith('removed:')) out.push({ label: 'Quitado', value: k.slice(8) });
  return out;
}

export const debtLabel = (x: Draft['debts'][number]) => `${x.name}${x.last4 ? ` •••• ${x.last4}` : ''}`;
export const accountLabel = (a: Draft['accounts'][number]) => `${BANK_LABEL[a.institution] ?? (a.institution === 'OTRO' ? 'Tarjeta' : a.institution)}${a.last4 ? ` •••• ${a.last4}` : ''}`;

// ── The one next question (§5-§8) ──────────────────────────────────────────────────────────────────────
export interface Question { key: string; text: string; replies: string[] }

export function nextQuestion(d: Draft): Question | null {
  const ask = (key: string, text: string, replies: string[] = ['Después']): Question | null => (d.asked.includes(key) ? null : { key, text, replies });
  // Ordered by impact (ADR-0008): what blocks "Dinero libre" (income, today's balance) → payment dates → payment
  // amounts → card minimum → debt balances → completeness. A debt balance never blocks the free-money figure.
  const cards = d.debts.filter((x) => x.kind === 'card');
  const cardName = (x: DebtFact) => x.name.toLowerCase();
  const candidates: Array<() => Question | null> = [
    () => (d.incomes.length === 0 ? ask('income:new', '¿Cuánto recibes y qué día te pagan?', ['Después']) : null),
    ...d.incomes.map((i) => () => (i.amountMinor === null && i.amountStatus === 'unknown' ? ask(`income:${i.id}:amount`, `¿Cuánto recibes de ${i.name.toLowerCase()}?`) : null)),
    ...d.incomes.map((i) => () => (i.day === null ? ask(`income:${i.id}:day`, `¿Qué día te pagan ${i.name.toLowerCase() === 'sueldo' ? 'el sueldo' : i.name.toLowerCase()}?`, ['Quincenal', 'Después']) : null)),
    () => (d.balance === null ? ask('balance', '¿Cuánto tienes hoy en tu cuenta, más o menos?') : null),
    ...d.obligations.map((o) => () => (o.day === null && o.dayStatus === 'unknown' ? ask(`obligation:${o.id}:day`, `¿Qué día pagas ${o.name.toLowerCase()}?`) : null)),
    ...cards.map((x) => () => (x.dueDay === null ? ask(`debt:${x.id}:day`, `¿Qué día vence la ${cardName(x)}?`) : null)),
    ...d.obligations.map((o) => () => (o.amountMinor === null && o.amountStatus === 'unknown' ? ask(`obligation:${o.id}:amount`, `¿Cuánto pagas de ${o.name.toLowerCase()}?`, ['No sé', 'Tomar foto']) : null)),
    ...cards.map((x) => () => (x.minimumMinor === null ? ask(`debt:${x.id}:minimum`, `¿Cuál es el pago mínimo de la ${cardName(x)}?`, ['No sé', 'Tomar foto']) : null)),
    ...cards.map((x) => () => (x.balanceMinor === null ? ask(`debt:${x.id}:balance`, `¿Cuánto debes en la ${cardName(x)}?`, ['No sé', 'Tomar foto']) : null)),
    ...d.debts.filter((x) => x.kind !== 'card').map((x) => () => (x.balanceMinor === null ? ask(`debt:${x.id}:balance`, x.kind === 'personal' ? `¿Cuánto le debes a ${x.lender}?` : `¿Cuánto te falta pagar del ${x.name.toLowerCase()}?`) : null)),
    () => (!d.done.includes('obligations') ? ask('group:obligations', d.obligations.length ? '¿Algún otro pago fijo? Alquiler, luz, internet…' : '¿Qué pagos fijos tienes cada mes? Alquiler, luz, internet…', ['No tengo más']) : null),
    () => (d.variable.length === 0 ? ask('variable:basics', '¿Cuánto gastas al mes en lo básico, como comida y transporte?', ['No sé']) : null),
  ];
  for (const c of candidates) { const q = c(); if (q) return q; }
  return null;
}

/** "Con esto ya podemos empezar": an income (even partial) and the balance question answered or asked. */
export const canStart = (d: Draft) => d.incomes.length > 0 && (d.balance !== null || d.asked.includes('balance'));
export const hasFacts = (d: Draft) => d.incomes.length + d.obligations.length + d.debts.length + d.accounts.length + d.variable.length > 0 || d.balance !== null;

// ── Summary (§64): only the main groups + what is still pending ───────────────────────────────────────
export interface Summary { groups: Array<{ title: string; items: Changed[] }>; pending: string[] }

export function summarize(d: Draft): Summary {
  const all = new Set<string>([...d.incomes.map((i) => `income:${i.id}`), ...d.obligations.map((o) => `obligation:${o.id}`), ...d.debts.map((x) => `debt:${x.id}`),
    ...d.accounts.map((a) => `account:${a.institution}:${a.kind}`), ...d.variable.map((v) => `variable:${v.id}`), ...(d.balance ? ['balance'] : [])]);
  const rows = describe(d, all);
  const pick = (labels: string[]) => rows.filter((r) => labels.includes(r.label));
  const groups = [
    { title: 'Ingresos', items: [...pick(d.incomes.map((i) => i.name)), ...pick(d.balance ? ['Saldo de hoy'] : [])] },
    { title: 'Cuentas', items: pick(d.accounts.map(accountLabel)) },
    { title: 'Pagos', items: [...pick(d.obligations.map((o) => o.name)), ...pick(d.variable.map((v) => v.name))] },
    { title: 'Deudas', items: pick(d.debts.map(debtLabel)) },
  ].filter((g) => g.items.length);
  const pending: string[] = [];
  for (const i of d.incomes) { if (i.amountMinor === null) pending.push(`Monto de ${i.name.toLowerCase()}`); if (i.day === null) pending.push(`Día de ${i.name.toLowerCase()}`); }
  if (!d.balance || d.balance.amountMinor === null) pending.push('Saldo de hoy');
  for (const o of d.obligations) { if (o.amountMinor === null) pending.push(`Monto de ${o.name.toLowerCase()}`); if (o.day === null) pending.push(`Día de ${o.name.toLowerCase()}`); }
  for (const x of d.debts) if (x.balanceMinor === null) pending.push(`Saldo de ${debtLabel(x).toLowerCase()}`);
  for (const v of d.variable) if (v.amountMinor === null) pending.push(`${v.name}: monto`);
  return { groups, pending };
}

/** Compact text of the draft for a provider prompt (§23): facts, not transcript. */
export function compactState(d: Draft): string {
  const s = summarize(d);
  const lines = s.groups.flatMap((g) => g.items.map((i) => `${g.title}: ${i.label} = ${i.value}`));
  return [...lines, s.pending.length ? `Por confirmar: ${s.pending.join('; ')}` : ''].filter(Boolean).join('\n').slice(0, 2000);
}
