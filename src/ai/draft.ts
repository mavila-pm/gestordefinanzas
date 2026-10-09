import type { Currency } from '../domain/money';
import { formatMoney } from '../domain/money';
import { addDays, incomeOccurrencesBetween, occurrencesBetween, type ExpectedIncome, type Obligation } from '../engine/planning';
import { BANK_LABEL, bankIn, loanName, readLoan } from './interpreter';
import { fold, UNKNOWN } from './text';
import type { Bare, DebtFact, Draft, FactStatus, Patch } from './types';

/**
 * Onboarding draft engine (ADR-0006): merges validated patches into the structured draft, decides the ONE next
 * question that matters, and builds the compact summary. Pure and deterministic: no provider involved.
 */

let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const status = (known: boolean, approx?: boolean): FactStatus => (!known ? 'unknown' : approx ? 'estimated' : 'confirmed');
const same = (a: string, b: string) => fold(a) === fold(b);

export interface Changed { label: string; value: string; /** What it is about (for the short reply). */ ref?: string }
export interface MergeResult { draft: Draft; changed: Changed[] }

export const money = (minor: number | null, currency: Currency) => (minor === null ? 'Por confirmar' : formatMoney({ amountMinor: minor, currency }).replace(/\.00$/, ''));
const dayText = (day: number | null, dayMax: number | null, second?: number | null, st?: FactStatus) =>
  day === null ? 'día por confirmar' : second ? `días ${day} y ${second}` : dayMax ? `${day}–${dayMax} aprox.` : `día ${day}${st === 'estimated' ? ' aprox.' : ''}`;

export function mergePatches(draft0: Draft, patches0: readonly Patch[], bare: Bare | null): MergeResult {
  const draft: Draft = structuredClone(draft0);
  draft.declined ??= [];
  const touched = new Set<string>();
  const patches = adaptToPending(draft, patches0);

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
        if (p.day !== undefined) { o.day = p.day; o.dayMax = p.dayMax ?? null; o.dayStatus = status(true, p.approxDay); o.dayHint = null; }
        else if (p.quincena && o.day === null) o.dayHint = 'quincena';
        // Mentioned again on purpose ("sí pago alquiler, 1,200"): it applies again.
        draft.declined = draft.declined!.filter((n) => !same(n, o!.name));
        touched.add(`obligation:${o.id}`);
        break;
      }
      case 'debt': {
        let d = (p.id ? draft.debts.find((x) => x.id === p.id) : undefined)
          ?? draft.debts.find((x) => x.kind === p.kind && (p.kind === 'personal' ? x.lender === (p.lender ?? null) : (x.institution ?? p.institution ?? null) === (p.institution ?? x.institution ?? null)));
        if (!d) {
          d = { id: newId('d'), name: p.name, kind: p.kind, lender: p.lender ?? null, institution: p.institution ?? null, last4: null, currency: p.currency ?? 'PEN', balanceMinor: null, balanceStatus: 'unknown', minimumMinor: null, dueDay: null };
          draft.debts.push(d);
        }
        if (p.institution && !d.institution) { d.institution = p.institution; d.name = d.kind === 'loan' ? loanName(d.loanType, p.institution) : p.name; }
        if (p.loanType) { d.loanType = p.loanType; if (d.kind === 'loan') d.name = loanName(p.loanType, d.institution); }
        if (p.principalMinor !== undefined) d.principalMinor = p.principalMinor;
        if (p.installmentMinor !== undefined) d.installmentMinor = p.installmentMinor;
        if (p.installmentsTotal !== undefined) d.installmentsTotal = p.installmentsTotal;
        if (p.installmentsPaid !== undefined) d.installmentsPaid = p.installmentsPaid;
        if (p.installmentsLeft !== undefined) d.installmentsLeft = p.installmentsLeft;
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
        if (p.declined && !draft.declined!.some((x) => same(x, p.name))) draft.declined!.push(p.name);
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
  // "Eso no lo pago": the payment Vels just asked about does not apply.
  if (b.none && (kind === 'obligation' || kind === 'debt' || kind === 'variable')) {
    const list = kind === 'obligation' ? d.obligations : kind === 'debt' ? d.debts : d.variable;
    const item = (list as Array<{ id: string; name: string }>).find((x) => x.id === id);
    if (item) {
      if (kind === 'obligation') d.obligations = d.obligations.filter((x) => x.id !== id);
      else if (kind === 'debt') d.debts = d.debts.filter((x) => x.id !== id);
      else d.variable = d.variable.filter((x) => x.id !== id);
      d.declined = [...(d.declined ?? []), item.name];
      touched.add(`removed:${item.name}`);
    }
    return;
  }
  if (kind === 'obligation' && field === 'quincena') {
    const o = d.obligations.find((x) => x.id === id);
    if (o && b.day !== undefined) { o.day = b.day; o.dayMax = b.dayMax ?? null; o.dayStatus = 'confirmed'; o.dayHint = null; touched.add(`obligation:${o.id}`); }
    return;
  }
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
    if (b.day !== undefined) { item[dayKey] = b.day; if (kind !== 'debt') { item.dayMax = b.dayMax ?? null; item.dayStatus = b.dayMax ? 'estimated' : 'confirmed'; } if (kind === 'obligation') item.dayHint = null; }
    else if (kind === 'obligation' && b.frequency === 'semimonthly') item.dayHint = 'quincena'; // "en quincena": asked, never assumed
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
  for (const i of d.incomes) if (touched.has(`income:${i.id}`)) out.push({ ref: `income:${i.id}`, label: i.name, value: `${i.amountMinor === null ? 'Monto por confirmar' : money(i.amountMinor, i.currency) + (i.amountStatus === 'estimated' ? ' aprox.' : '')} · ${dayText(i.day, i.dayMax, i.secondDay, i.dayStatus)}` });
  for (const o of d.obligations) if (touched.has(`obligation:${o.id}`)) out.push({ ref: `obligation:${o.id}`, label: o.name, value: `${o.amountMinor === null ? 'Monto por confirmar' : money(o.amountMinor, o.currency) + (o.amountStatus === 'estimated' ? ' aprox.' : '')} · ${dayText(o.day, o.dayMax, null, o.dayStatus)}` });
  for (const x of d.debts) if (touched.has(`debt:${x.id}`)) out.push({ ref: `debt:${x.id}`, label: debtLabel(x), value: debtValue(x) });
  for (const a of d.accounts) if (touched.has(`account:${a.institution}:${a.kind}`)) out.push({ ref: 'account', label: accountLabel(a), value: a.kind === 'card' ? 'Tarjeta' : 'Cuenta' });
  for (const v of d.variable) if (touched.has(`variable:${v.id}`)) out.push({ ref: `variable:${v.id}`, label: v.name, value: v.amountMinor === null ? 'Monto por confirmar' : `${money(v.amountMinor, v.currency)} al mes${v.amountStatus === 'estimated' ? ' aprox.' : ''}` });
  if (touched.has('balance') && d.balance) out.push({ ref: 'balance', label: 'Saldo de hoy', value: money(d.balance.amountMinor, d.balance.currency) });
  for (const k of touched) if (k.startsWith('removed:')) out.push({ ref: 'removed', label: 'Quitado', value: k.slice(8) });
  return out;
}

function debtValue(x: DebtFact): string {
  const parts: string[] = [x.balanceMinor === null ? 'Saldo por confirmar' : `Debes ${money(x.balanceMinor, x.currency)}${x.balanceStatus === 'estimated' ? ' aprox.' : ''}`];
  if (x.minimumMinor) parts.push(`mínimo ${money(x.minimumMinor, x.currency)}`);
  if (x.installmentMinor) parts.push(`cuota ${money(x.installmentMinor, x.currency)}`);
  if (x.installmentsTotal) parts.push(`${x.installmentsPaid ?? (x.installmentsLeft != null ? x.installmentsTotal - x.installmentsLeft : '?')} de ${x.installmentsTotal} cuotas`);
  else if (x.installmentsLeft != null) parts.push(`faltan ${x.installmentsLeft} cuotas`);
  if (x.principalMinor) parts.push(`prestaron ${money(x.principalMinor, x.currency)}`);
  if (x.dueDay) parts.push(`día ${x.dueDay}`);
  return parts.join(' · ');
}

export const debtLabel = (x: Draft['debts'][number]) => `${x.name}${x.last4 ? ` •••• ${x.last4}` : ''}`;
export const accountLabel = (a: Draft['accounts'][number]) => `${BANK_LABEL[a.institution] ?? (a.institution === 'OTRO' ? 'Tarjeta' : a.institution)}${a.last4 ? ` •••• ${a.last4}` : ''}`;

// ── The one next question (§5-§8) ──────────────────────────────────────────────────────────────────────
export interface Question { key: string; text: string; replies: string[] }

/** "el agua", "la luz", "el alquiler", "internet": how a person names the payment in a question. */
const FEMININE = new Set(['luz', 'educacion', 'pension', 'mensualidad', 'cuota', 'tarjeta']);
const BARE = new Set(['internet', 'netflix', 'spotify', 'cable', 'gimnasio', 'streaming']);
export function theName(name: string): string {
  const n = name.toLowerCase();
  const first = fold(n).split(' ')[0]!;
  return BARE.has(first) ? n : `${FEMININE.has(first) ? 'la' : 'el'} ${n}`;
}
const cardRef = (x: DebtFact) => `la ${x.name.replace(/^Tarjeta/, 'tarjeta')}`;

/**
 * The ONE next question. Order (§5-§8, ADR-0008): income → today's balance → each fixed payment completed before the
 * next (amount, then day; "quincena" is clarified) → other payments? → credit cards (owed, minimum, due day) →
 * loans (entity, type, owed, installment, day, installments) → personal debts → basics. Every key is asked once.
 */
export function nextQuestion(d: Draft): Question | null {
  const ask = (key: string, text: string, replies: string[] = ['Después']): Question | null => (d.asked.includes(key) ? null : { key, text, replies });
  const cards = d.debts.filter((x) => x.kind === 'card');
  const loans = d.debts.filter((x) => x.kind === 'loan');
  const declined = (d.declined ?? []).map(fold);
  const candidates: Array<() => Question | null> = [
    () => (d.incomes.length === 0 ? ask('income:new', '¿Cuánto recibes y qué día te pagan?', ['Después']) : null),
    ...d.incomes.map((i) => () => (i.amountMinor === null && i.amountStatus === 'unknown' ? ask(`income:${i.id}:amount`, `¿Cuánto recibes de ${i.name.toLowerCase()}?`) : null)),
    ...d.incomes.map((i) => () => (i.day === null ? ask(`income:${i.id}:day`, `¿Qué día te pagan ${i.name.toLowerCase() === 'sueldo' ? 'el sueldo' : i.name.toLowerCase()}?`, ['Quincenal', 'Después']) : null)),
    () => (d.balance === null ? ask('balance', '¿Cuánto dinero tienes disponible hoy?') : null),
    // One payment at a time: its amount, then its day, before the next payment.
    ...d.obligations.flatMap((o) => [
      () => (o.amountMinor === null && o.amountStatus === 'unknown' ? ask(`obligation:${o.id}:amount`, `¿Cuánto pagas de ${o.name.toLowerCase()}?`, ['No sé', 'Tomar foto']) : null),
      () => (o.day === null && o.dayHint === 'quincena' ? ask(`obligation:${o.id}:quincena`, '¿Te refieres al 15 de cada mes?', ['Sí, el 15', 'Otro día']) : null),
      () => (o.day === null && o.dayStatus === 'unknown' ? ask(`obligation:${o.id}:day`, `¿Qué día pagas ${theName(o.name)}?`, ['No sé']) : null),
    ]),
    // "¿Qué pagos fijos tienes?" first; once there are payments, "¿Tienes algún otro?" is its own (once) question.
    () => (d.done.includes('obligations') ? null : d.obligations.length + d.variable.length
      ? ask('group:obligations:more', '¿Tienes algún otro pago fijo?', ['No tengo más'])
      : ask('group:obligations', `¿Qué pagos fijos tienes cada mes? ${['Alquiler', 'luz', 'internet'].filter((x) => !declined.includes(fold(x))).join(', ')}…`, ['No tengo más'])),
    () => (!cards.length && !d.accounts.some((a) => a.kind === 'card') && !d.done.includes('cards') ? ask('group:cards', '¿Tienes tarjeta de crédito?', ['No tengo']) : null),
    ...cards.flatMap((x) => [
      () => (x.balanceMinor === null && x.balanceStatus === 'unknown' ? ask(`debt:${x.id}:balance`, `¿Cuánto debes ahora en ${cardRef(x)}?`, ['No sé', 'Tomar foto']) : null),
      () => (x.minimumMinor === null ? ask(`debt:${x.id}:minimum`, `¿Cuál es el pago mínimo de ${cardRef(x)}?`, ['No sé', 'Tomar foto']) : null),
      () => (x.dueDay === null ? ask(`debt:${x.id}:day`, `¿Qué día vence el pago de ${cardRef(x)}?`, ['No sé']) : null),
    ]),
    () => (!loans.length && !d.done.includes('loans') && !d.done.includes('debts') ? ask('group:loans', '¿Tienes algún préstamo?', ['No tengo']) : null),
    ...loans.flatMap((x) => [
      () => (!x.institution ? ask(`debt:${x.id}:institution`, '¿Con qué banco o entidad es el préstamo?', ['No sé']) : null),
      () => (!x.loanType ? ask(`debt:${x.id}:type`, '¿Qué tipo de préstamo es?', ['Personal', 'Vehicular', 'Hipotecario', 'Estudios', 'Otro']) : null),
      () => (x.balanceMinor === null && x.balanceStatus === 'unknown' ? ask(`debt:${x.id}:balance`, '¿Cuánto te falta pagar?', ['No sé']) : null),
      () => (!x.installmentMinor ? ask(`debt:${x.id}:installment`, '¿Cuánto pagas cada mes?', ['No sé']) : null),
      () => (x.dueDay === null ? ask(`debt:${x.id}:day`, '¿Qué día pagas la cuota?', ['No sé']) : null),
      () => (!x.installmentsTotal ? ask(`debt:${x.id}:installments`, '¿De cuántas cuotas es y cuántas llevas pagadas?', ['No sé']) : null),
    ]),
    ...d.debts.filter((x) => x.kind === 'personal').map((x) => () => (x.balanceMinor === null ? ask(`debt:${x.id}:balance`, `¿Cuánto le debes a ${x.lender}?`) : null)),
    () => (d.variable.length === 0 ? ask('variable:basics', '¿Cuánto gastas al mes en lo básico, como comida y transporte?', ['No sé']) : null),
  ];
  for (const c of candidates) { const q = c(); if (q) return q; }
  return null;
}

/**
 * Answers to group questions name a bank: "sí, BCP" to "¿Tienes tarjeta de crédito?" is a card at BCP; "BCP" to
 * "¿Con qué banco es el préstamo?" is that loan's entity. Turns the bank mention into the right fact.
 */
function adaptToPending(d: Draft, patches: readonly Patch[]): Patch[] {
  const pending = d.pending ?? '';
  const banks = patches.filter((p): p is Extract<Patch, { t: 'account' }> => p.t === 'account');
  if (!banks.length) return [...patches];
  const rest = patches.filter((p) => p.t !== 'account');
  if (pending === 'group:cards') return [...rest, ...banks.map((b): Patch => ({ t: 'debt', kind: 'card', name: `Tarjeta${b.institution !== 'OTRO' ? ` ${BANK_LABEL[b.institution] ?? b.institution}` : ''}`, ...(b.institution !== 'OTRO' ? { institution: b.institution } : {}), ...(b.last4 ? { last4: b.last4 } : {}) }))];
  if (pending === 'group:loans') return [...rest, ...banks.slice(0, 1).map((b): Patch => ({ t: 'debt', kind: 'loan', name: loanName(null, b.institution), institution: b.institution }))];
  const loanInst = /^debt:([^:]+):institution$/.exec(pending);
  if (loanInst) return [...rest, { t: 'debt', kind: 'loan', id: loanInst[1], name: 'Préstamo', institution: banks[0]!.institution }];
  return [...patches];
}

/**
 * Replies that only make sense against the pending question and that the generic reader cannot place:
 * "sí / el 15 / otro día" to "¿Te refieres al 15?", a loan's entity or type in words, and loan numbers
 * ("36, llevo 10"; "850"). null = let the normal reading handle the message.
 */
export function pendingReply(d: Draft, text: string): MergeResult | null {
  const pending = d.pending ?? '';
  const t = fold(text).replace(/[.!¡¿?]/g, '').trim();
  const m = /^(obligation|debt):([^:]+):(\w+)$/.exec(pending);
  if (!m) return null;
  const [, kind, id, field] = m;
  const unknown = UNKNOWN.test(t) || /^(no se|otro)$/.test(t);
  if (kind === 'obligation' && field === 'quincena') {
    if (/^(si|claro|exacto|correcto|asi es|si el 15|el 15|15|si, el 15)$/.test(t.replace(/,/g, ''))) return mergePatches(d, [], { day: 15 });
    if (/^(no|otro dia|no exactamente)$/.test(t)) {
      const draft = structuredClone(d);
      const o = draft.obligations.find((x) => x.id === id);
      if (o) o.dayHint = null; // ask the actual day next
      draft.pending = null;
      return { draft, changed: [] };
    }
    return null;
  }
  const debt = d.debts.find((x) => x.id === id);
  if (kind !== 'debt' || !debt || debt.kind !== 'loan') return null;
  if (unknown && t.split(' ').length <= 4) { const draft = structuredClone(d); draft.pending = null; return { draft, changed: [] }; }
  const loanPatch = (f: Partial<Extract<Patch, { t: 'debt' }>>): MergeResult => mergePatches({ ...d, pending: null }, [{ t: 'debt', kind: 'loan', id, name: debt.name, ...f }], null);
  const rich = /\d/.test(t); // several facts at once ("BCP, 20 mil, 36 cuotas…"): read them all below
  if (field === 'institution' && !rich) {
    const bank = bankIn(t)[0];
    if (bank) return loanPatch({ institution: bank });
    if (/^[a-z ]{2,30}$/.test(t) && t.split(' ').length <= 4) return loanPatch({ institution: t.replace(/\b\w/g, (c) => c.toUpperCase()) });
    return null;
  }
  if (field === 'type' && !rich) {
    const f = readLoan(t);
    return loanPatch({ loanType: f.loanType ?? (/^otro/.test(t) ? 'otro' : 'otro') });
  }
  // Numbers: several facts at once are read for what each one is; a single bare number answers the question asked.
  const f = readLoan(t);
  const facts = [f.balanceMinor, f.installmentMinor, f.installmentsTotal, f.installmentsPaid, f.installmentsLeft, f.dueDay].filter((x) => x !== undefined).length;
  const single = facts === 0 && f.principalMinor !== undefined;
  if (field === 'installments') {
    const nums = (t.match(/\d{1,3}/g) ?? []).map(Number);
    const total = f.installmentsTotal ?? (f.installmentsLeft === undefined ? nums[0] : undefined);
    const paid = f.installmentsPaid ?? (nums.length > 1 && f.installmentsLeft === undefined ? nums[1] : undefined);
    if (total === undefined && paid === undefined && f.installmentsLeft === undefined) return null;
    return loanPatch({ ...(total ? { installmentsTotal: total } : {}), ...(paid !== undefined ? { installmentsPaid: paid } : {}), ...(f.installmentsLeft !== undefined ? { installmentsLeft: f.installmentsLeft } : {}) });
  }
  if (!facts && f.principalMinor === undefined && !f.institution) return null;
  const base: Partial<Extract<Patch, { t: 'debt' }>> = {
    ...(f.institution ? { institution: f.institution } : {}), ...(f.loanType ? { loanType: f.loanType } : {}),
    ...(f.balanceMinor !== undefined ? { balanceMinor: f.balanceMinor } : {}), ...(f.installmentMinor !== undefined ? { installmentMinor: f.installmentMinor } : {}),
    ...(f.installmentsTotal !== undefined ? { installmentsTotal: f.installmentsTotal } : {}), ...(f.installmentsPaid !== undefined ? { installmentsPaid: f.installmentsPaid } : {}),
    ...(f.installmentsLeft !== undefined ? { installmentsLeft: f.installmentsLeft } : {}), ...(f.dueDay !== undefined ? { dueDay: f.dueDay } : {}),
  };
  if (single) {
    // "850" to "¿Cuánto pagas cada mes?" is the installment; "12 mil" to "¿Cuánto te falta pagar?" is the balance.
    const v = f.principalMinor!;
    if (field === 'balance') return loanPatch({ ...base, balanceMinor: v, ...(f.approx ? { approx: true } : {}) });
    if (field === 'installment') return loanPatch({ ...base, installmentMinor: v });
  }
  return loanPatch({ ...base, ...(f.principalMinor !== undefined ? { principalMinor: f.principalMinor } : {}) });
}

/**
 * How many numbers in the message the deterministic reading did NOT use (amounts and days). Above 0 the reading is
 * partial ("gasto 200 en carro y 100 en comida" read as one item): the provider, when enabled, reads it instead.
 */
export function unreadNumbers(folded: string, read: { patches: readonly Patch[]; bare: Bare | null }): number {
  const numbers = (folded.match(/\d+(?:[.,]\d+)*/g) ?? []).length;
  let used = 0;
  const count = (...v: Array<unknown>) => { for (const x of v) if (x !== undefined && x !== null) used++; };
  for (const p of read.patches) {
    if (p.t === 'income') count(p.amountMinor, p.day, p.dayMax, p.secondDay);
    else if (p.t === 'obligation') count(p.amountMinor, p.day, p.dayMax);
    else if (p.t === 'debt') count(p.balanceMinor, p.minimumMinor, p.dueDay, p.last4);
    else if (p.t === 'variable' || p.t === 'balance') count(p.amountMinor);
    else if (p.t === 'account') count(p.last4);
  }
  if (read.bare) count(read.bare.amountMinor, read.bare.day, read.bare.dayMax);
  return Math.max(0, numbers - used);
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

/**
 * "Sí" / "No" read against the pending question, never as data: "no" to "¿algún otro pago fijo?" closes that group;
 * "sí" (or a yes/no to a question that needs a value) asks for the value again. null = not a yes/no reply.
 */
export function yesNoReply(d: Draft, text: string): { patches: Patch[]; reask: string | null } | null {
  const t = fold(text).replace(/[.!¡¿?]/g, '').trim();
  const yes = /^(si|claro|correcto|asi es|exacto|ok si|si claro)$/.test(t);
  const no = /^(no|nop|nada|ninguno|ninguna|no tengo|no hay)$/.test(t);
  if (!yes && !no) return null;
  if (d.pending === 'group:obligations' || d.pending === 'group:obligations:more') {
    return no ? { patches: [{ t: 'done', group: 'obligations' }], reask: null } : { patches: [], reask: '¿Cuál es? Dime el nombre y cuánto pagas, por ejemplo "internet 90".' };
  }
  if (d.pending === 'group:cards') return no ? { patches: [{ t: 'done', group: 'cards' }], reask: null } : { patches: [], reask: '¿De qué banco es?' };
  if (d.pending === 'group:loans') return no ? { patches: [{ t: 'done', group: 'loans' }], reask: null } : { patches: [], reask: '¿Con qué banco o entidad?' };
  if (!d.pending) return { patches: [], reask: null };
  const q = nextQuestion({ ...d, asked: d.asked.filter((k) => k !== d.pending) });
  return { patches: [], reask: q && q.key === d.pending ? `Me falta ese dato. ${q.text}` : null };
}

/** One natural sentence with everything understood in this turn (all rows, nothing dropped). */
export function recap(changed: readonly Changed[]): string {
  const parts = changed.map((c) => `${c.label.toLowerCase()}: ${c.value}`);
  if (!parts.length) return '';
  return `Entendí ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join('; ')} y ${parts.at(-1)}`}.`;
}

// ── Short replies (personality: brief, calm) and the upcoming payments, from the engine ──────────────────
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const dayPhrase = (day: number, dayMax: number | null | undefined) => (dayMax ? `entre el ${day} y el ${dayMax}` : day === 31 ? 'el último día del mes' : `el ${day}`);

/**
 * One or two short sentences about what this turn changed (never a field dump): "Listo, S/ 120 de agua.",
 * "Perfecto. El agua queda para el 15.", "Listo, entonces no contamos alquiler.". Several items → one line.
 */
export function shortReply(d: Draft, changed: readonly Changed[], answered: string | null = null): string {
  const removed = changed.filter((c) => c.ref === 'removed').map((c) => c.value.toLowerCase());
  const obligations = changed.filter((c) => c.ref?.startsWith('obligation:')).map((c) => d.obligations.find((o) => `obligation:${o.id}` === c.ref)).filter((o) => !!o);
  const others = changed.filter((c) => c.ref !== 'removed' && !c.ref?.startsWith('obligation:'));
  const out: string[] = [];
  if (removed.length) out.push(`Listo, entonces no contamos ${removed.join(' ni ')}.`);
  // Many facts at once: one line; the card under the message lists them.
  if (obligations.length + others.length > 2 && others.length > 0) return [...out, 'Ya lo tengo.'].join(' ');
  if (obligations.length === 1) {
    const o = obligations[0]!;
    const amount = o.amountMinor !== null ? money(o.amountMinor, o.currency) : null;
    // What was just answered decides the sentence: the day ("queda para el 15") or the amount ("S/ 120 de agua").
    const justDay = !!answered && answered.startsWith(`obligation:${o.id}:`) && /:(day|quincena)$/.test(answered);
    const justAmount = !!answered && answered === `obligation:${o.id}:amount`;
    if (o.day !== null && (justDay || (!amount && !justAmount))) out.push(`Perfecto. ${cap(theName(o.name))} queda para ${dayPhrase(o.day, o.dayMax)}.`);
    else if (amount && o.day !== null && !justAmount) out.push(`Listo: ${o.name.toLowerCase()}, ${amount} ${dayPhrase(o.day, o.dayMax)}.`);
    else if (amount) out.push(`Listo, ${amount} de ${o.name.toLowerCase()}.`);
  } else if (obligations.length > 1) {
    out.push(obligations.every((o) => o.amountMinor !== null) && obligations.every((o) => o.day === null) ? 'Ya tengo esos montos.' : 'Ya tengo esos pagos.');
  }
  if (others.length === 1) {
    const c = others[0]!;
    if (c.ref === 'balance' && d.balance) out.push(d.balance.amountMinor === null ? 'Lo dejamos pendiente.' : `Listo, ${money(d.balance.amountMinor, d.balance.currency)} disponibles hoy.`);
    else if (c.ref?.startsWith('income:')) out.push(`Anotado: ${c.label.toLowerCase()}, ${c.value.replace(' · ', ', ')}.`);
    else if (c.ref?.startsWith('debt:')) out.push(debtRecap(d, c, answered));
    else if (c.ref?.startsWith('variable:')) out.push(`Listo, ${c.value.toLowerCase()} en ${c.label.toLowerCase()}.`);
    else out.push('Anotado.');
  } else if (others.length > 1) out.push('Ya lo tengo.');
  return out.join(' ').replace(/, \./g, '.').replace(/\s+/g, ' ').trim();
}

/** A card or loan answer: only the fact just given ("Listo, mínimo S/ 450."); a first mention names it with what came. */
function debtRecap(d: Draft, c: Changed, answered: string | null): string {
  const x = d.debts.find((v) => `debt:${v.id}` === c.ref);
  const named = c.label.replace(/^Tarjeta/, 'tarjeta').replace(/^Préstamo/, 'préstamo');
  const field = x && answered?.startsWith(`debt:${x.id}:`) ? answered.slice(`debt:${x.id}:`.length) : null;
  if (x && field === 'balance' && x.balanceMinor !== null) return `Listo, debes ${x.balanceStatus === 'estimated' ? 'unos ' : ''}${money(x.balanceMinor, x.currency)}.`;
  if (x && field === 'minimum' && x.minimumMinor) return `Listo, mínimo ${money(x.minimumMinor, x.currency)}.`;
  if (x && field === 'installment' && x.installmentMinor) return `Listo, cuota de ${money(x.installmentMinor, x.currency)}.`;
  if (x && field === 'day' && x.dueDay) return x.kind === 'card' ? `Perfecto. Vence el ${x.dueDay}.` : `Perfecto. La cuota queda para el ${x.dueDay}.`;
  if (x && field === 'installments' && x.installmentsTotal) {
    const paid = x.installmentsPaid ?? (x.installmentsLeft != null ? x.installmentsTotal - x.installmentsLeft : null);
    return paid === null ? `Listo, ${x.installmentsTotal} cuotas.` : `Listo, llevas ${paid} de ${x.installmentsTotal} cuotas.`;
  }
  if (field === 'institution' || field === 'type') return `Anotado: ${named}.`;
  const rest = c.value.replace('Saldo por confirmar · ', '').replace('Saldo por confirmar', '').replace(/ · /g, ', ');
  return `Anotado: ${named}${rest ? `, ${rest.replace(/^Debes/, 'debes')}` : ''}.`;
}

export interface UpcomingItem { name: string; date: string; dateMax: string | null; amountMinor: number | null; currency: Currency; estimated: boolean }

/**
 * What comes next, from the facts in the draft and today's Lima date, through the planning engine's own
 * recurrence (monthly due day, clamped to 28/29/30/31; a passed day moves to next month). Nothing is stored per
 * month; a payment without a day is not given one. Horizon: the next income (or 31 days).
 */
export function upcomingFromDraft(d: Draft, today: string): { until: string | null; items: UpcomingItem[] } {
  const income = d.incomes.filter((i) => i.day !== null).map((i): ExpectedIncome => ({
    id: i.id, name: i.name, currency: i.currency, amountMinor: i.amountMinor, amountStatus: i.amountStatus,
    frequency: i.frequency === 'semimonthly' && i.secondDay ? 'semimonthly' : 'monthly', dayOfMonth: i.day, dayMax: i.dayMax, secondDay: i.secondDay, anchorDate: null,
  })).flatMap((i) => incomeOccurrencesBetween(i, addDays(today, 1), addDays(today, 62))).sort((a, b) => a.date.localeCompare(b.date))[0];
  const until = income ? (income.dateMax ?? income.date) : null;
  const to = until ?? addDays(today, 31);
  const plans: Obligation[] = [
    ...d.obligations.filter((o) => o.day !== null).map((o): Obligation => ({ id: o.id, source: 'obligation', name: o.name, kind: o.kind, currency: o.currency, amountMinor: o.amountMinor,
      amountStatus: o.amountStatus, frequency: 'monthly', anchorMonth: null, dueDay: o.day, dueDayMax: o.dayMax, targetDay: null, since: today })),
    ...d.debts.filter((x) => x.dueDay !== null && (x.kind === 'card' ? x.minimumMinor !== null : !!x.installmentMinor)).map((x): Obligation => ({ id: x.id, source: 'debt', name: x.name,
      kind: x.kind === 'card' ? 'card' : 'loan', currency: x.currency, amountMinor: x.kind === 'card' ? x.minimumMinor : x.installmentMinor ?? null, amountStatus: 'confirmed',
      frequency: 'monthly', anchorMonth: null, dueDay: x.dueDay, dueDayMax: null, targetDay: null, since: today })),
  ];
  const items = plans.flatMap((o) => {
    const next = occurrencesBetween(o, today, addDays(today, 62)).find((x) => x.dueDate !== null && (x.dueDateMax ?? x.dueDate) >= today);
    return next && next.dueDate! <= to ? [{ name: o.name, date: next.dueDate!, dateMax: next.dueDateMax, amountMinor: next.amountMinor, currency: o.currency, estimated: next.amountStatus !== 'confirmed' || !!next.dueDateMax }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return { until, items };
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
export const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

/** "agua el 15, internet el 20 y luz el 25" (chronological, from the engine). */
export function agendaLine(items: readonly UpcomingItem[]): string {
  const parts = items.map((x) => `${x.name.toLowerCase()} el ${Number(x.date.slice(8, 10))}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}` : parts[0] ?? '';
}
