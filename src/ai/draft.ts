import type { Currency } from '../domain/money';
import { matchProvider } from '../domain/subscriptions';
import { formatMoney } from '../domain/money';
import { incomeOccurrencesBetween, occurrencesBetween, type ExpectedIncome, type Obligation } from '../engine/planning';
import { addDays, shortDate } from '../domain/dates';
import { BANK_LABEL, bankIn, loanName, readLoan, subscriptionList } from './interpreter';
import { findAmounts, findDays, fold, UNKNOWN } from './text';
import type { Bare, DebtFact, Draft, FactStatus, Patch } from './types';

/**
 * Onboarding draft engine (ADR-0006): merges validated patches into the structured draft, decides the ONE next
 * question that matters, and builds the compact summary. Pure and deterministic: no provider involved.
 */

let seq = 0;
/** Placeholder names of an income whose source is not known yet (the source answer renames it). */
export const GENERIC_INCOME = new Set(['Otro ingreso', 'Ingreso adicional', 'Ingresos']);
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const status = (known: boolean, approx?: boolean): FactStatus => (!known ? 'unknown' : approx ? 'estimated' : 'confirmed');
const same = (a: string, b: string) => fold(a) === fold(b);

/** "S/ 4,150 (cuentas S/ 4,000 · efectivo S/ 150)"; a part not said is "por confirmar". */
export function balanceText(b: NonNullable<Draft['balance']>): string {
  if (b.bankMinor == null && b.cashMinor == null) return money(b.amountMinor, b.currency);
  const part = (v: number | null | undefined) => (v == null ? 'por confirmar' : money(v, b.currency));
  return `${money(b.amountMinor, b.currency)} (cuentas ${part(b.bankMinor)} · efectivo ${part(b.cashMinor)})`;
}

export interface Changed { label: string; value: string; /** What it is about (for the short reply). */ ref?: string }
export interface MergeResult { draft: Draft; changed: Changed[] }

export const money = (minor: number | null, currency: Currency) => (minor === null ? 'Por confirmar' : formatMoney({ amountMinor: minor, currency }).replace(/\.00$/, ''));
const dayText = (day: number | null, dayMax: number | null, second?: number | null, st?: FactStatus) =>
  day === null ? 'día por confirmar' : second ? `días ${day} y ${second}` : dayMax ? `${day}–${dayMax} aprox.` : `día ${day}${st === 'estimated' ? ' aprox.' : ''}`;

export function mergePatches(draft0: Draft, patches0: readonly Patch[], bare: Bare | null, said?: string): MergeResult {
  const draft: Draft = structuredClone(draft0);
  draft.declined ??= [];
  const touched = new Set<string>();
  const patches = adaptToPending(draft, patches0, said);

  for (const p of patches) {
    switch (p.t) {
      case 'income': {
        // The income this fact belongs to: the one a pending question is about (id), the one with the same name, or
        // — for an unnamed fact — the first one. A new name, or isNew, is a separate income. Never two records for one.
        let inc = p.id ? draft.incomes.find((x) => x.id === p.id)
          : p.isNew ? undefined
          : p.name ? draft.incomes.find((x) => same(x.name, p.name!)) ?? (draft.incomes.length === 1 && draft.incomes[0]!.name === 'Sueldo' && p.name === 'Sueldo' ? draft.incomes[0] : undefined)
          : draft.incomes[0];
        if (!inc) {
          inc = { id: newId('i'), name: p.name ?? 'Sueldo', currency: p.currency ?? 'PEN', amountMinor: null, amountStatus: 'unknown', frequency: null, day: null, dayMax: null, secondDay: null, dayStatus: 'unknown' };
          draft.incomes.push(inc);
        }
        const first = inc === draft.incomes[0];
        if (p.name && p.id && GENERIC_INCOME.has(inc.name)) inc.name = p.name;
        if (p.source) inc.source = p.source;
        if (p.currency) inc.currency = p.currency;
        if (p.amountMinor !== undefined) { inc.amountMinor = p.amountMinor; inc.amountStatus = status(true, p.approx); }
        else if (p.unknownAmount) { inc.amountMinor = null; inc.amountStatus = 'unknown'; }
        if (p.day !== undefined) { inc.day = p.day; inc.dayMax = p.dayMax ?? null; inc.secondDay = p.secondDay ?? null; inc.dayStatus = status(true, p.approxDay); inc.dayHint = null; }
        else if (p.endHint && inc.day === null) inc.dayHint = 'end';
        if (p.frequency) inc.frequency = p.frequency;
        // A pay day says "monthly" only for the main income (a salary); an extra income is asked, never assumed.
        else if (inc.day !== null && !inc.frequency && (first || inc.secondDay)) inc.frequency = inc.secondDay ? 'semimonthly' : 'monthly';
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
        // PEN ≠ USD: amounts in another currency than the ones already given are not merged (never mixed or relabelled).
        const hasMoney = d.balanceMinor !== null || d.minimumMinor !== null || d.installmentMinor != null || d.principalMinor != null;
        const sameMoney = !p.currency || p.currency === d.currency || !hasMoney;
        if (sameMoney && p.currency) d.currency = p.currency;
        if (sameMoney && p.principalMinor !== undefined) d.principalMinor = p.principalMinor;
        if (sameMoney && p.installmentMinor !== undefined) d.installmentMinor = p.installmentMinor;
        if (p.installmentsTotal !== undefined) d.installmentsTotal = p.installmentsTotal;
        if (p.installmentsPaid !== undefined) d.installmentsPaid = p.installmentsPaid;
        if (p.installmentsLeft !== undefined) d.installmentsLeft = p.installmentsLeft;
        if (p.last4) d.last4 = p.last4;
        if (sameMoney && p.balanceMinor !== undefined) { d.balanceMinor = p.balanceMinor; d.balanceStatus = status(true, p.approx); }
        else if (p.unknownBalance) { d.balanceMinor = null; d.balanceStatus = 'unknown'; }
        if (sameMoney && p.minimumMinor !== undefined) d.minimumMinor = p.minimumMinor;
        if (sameMoney && p.usualPaymentMinor !== undefined) d.usualPaymentMinor = p.usualPaymentMinor;
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
      case 'balance': {
        if (p.bankMinor !== undefined || p.cashMinor !== undefined) {
          // A breakdown: each part said replaces that part (a correction of one keeps the other); the total is
          // their sum when both are known, else the part known (shown with what is missing). Never only the last amount.
          const cur = draft.balance && draft.balance.currency === (p.currency ?? draft.balance.currency) ? draft.balance : null;
          const bank = p.bankMinor !== undefined ? p.bankMinor : cur?.bankMinor ?? null;
          const cash = p.cashMinor !== undefined ? p.cashMinor : cur?.cashMinor ?? null;
          draft.balance = { currency: p.currency ?? cur?.currency ?? 'PEN', amountMinor: (bank ?? 0) + (cash ?? 0), status: 'confirmed', bankMinor: bank, cashMinor: cash };
        } else {
          draft.balance = p.unknown || p.amountMinor === undefined
            ? { currency: p.currency ?? 'PEN', amountMinor: null, status: 'unknown' }
            : { currency: p.currency ?? 'PEN', amountMinor: p.amountMinor, status: 'confirmed' };
        }
        touched.add('balance');
        break;
      }
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
  // A correction or a fact about something else ("en realidad tengo 4,200 en cuentas" while fixed payments were
  // asked) does NOT answer the pending question: it is asked again after the reply, never skipped.
  if (draft.pending && !bare && (touched.size || patches.length) && !answersPending(draft.pending, touched, patches)) {
    draft.asked = draft.asked.filter((k) => k !== draft.pending);
  }
  // Answered or superseded: the pending question is settled once the person replied anything we could use.
  if (touched.size || bare || patches.length) draft.pending = null;
  return { draft, changed: describe(draft, touched) };
}

/** Whether what this turn changed is about the pending question's subject (else the question stays open). */
function answersPending(pending: string, touched: Set<string>, patches: readonly Patch[]): boolean {
  const keys = [...touched];
  const has = (prefix: string) => keys.some((k) => k.startsWith(prefix));
  const done = (g: string) => patches.some((p) => p.t === 'done' && p.group === g);
  const [kind, id] = pending.split(':');
  if (pending === 'balance') return has('balance');
  if (pending === 'work') return true; // the work question has its own handling (never re-asked here)
  if (kind === 'income') return has('income:') || done('incomes');
  if (pending.startsWith('group:obligations')) return has('obligation:') || has('variable:') || has('removed:') || done('obligations');
  if (pending === 'group:subscriptions') return has('obligation:') || done('subscriptions');
  if (pending === 'group:loans') return has('debt:') || done('loans') || done('debts');
  if (pending === 'group:cards') return has('debt:') || has('account:') || done('cards');
  if (kind === 'obligation' || kind === 'debt' || kind === 'variable') return has(`${kind}:${id}`) || has('removed:') || (kind === 'variable' && has('variable:'));
  if (pending === 'savings:goal') return has('savings');
  return true;
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
  if (kind === 'income' && id === 'other') {
    // "400" to "¿Tienes algún otro ingreso?": a second income, its source asked by name later if needed.
    if (b.amountMinor === undefined) return;
    const inc = { id: newId('i'), name: 'Otro ingreso', currency: b.currency ?? 'PEN', amountMinor: b.amountMinor, amountStatus: status(true, b.approx), frequency: b.frequency ?? null,
      day: b.day ?? null, dayMax: b.dayMax ?? null, secondDay: null, dayStatus: status(b.day !== undefined) } as Draft['incomes'][number];
    d.incomes.push(inc);
    touched.add(`income:${inc.id}`);
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
  if (kind === 'savings' && id === 'goal') {
    if (b.amountMinor !== undefined) d.savings = { currency: b.currency ?? 'PEN', amountMinor: b.amountMinor, status: b.approx ? 'estimated' : 'confirmed' };
    else if (markUnknown) d.savings = { currency: 'PEN', amountMinor: null, status: 'unknown' };
    else return;
    touched.add('savings');
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
    // Everything said in the answer belongs to this item: "300 el 5 de cada mes" fills amount, day and frequency.
    if (b.day !== undefined && (kind === 'obligation' || kind === 'income')) { item.day = b.day; item.dayMax = b.dayMax ?? null; item.dayStatus = 'confirmed'; }
    if (kind === 'income' && b.frequency) item.frequency = b.frequency;
  } else if (field === 'day' || field === 'days' || field === 'dayexact') {
    // A whole number 1–31 without currency, when a day was asked, is that day ("30"), never S/ 30.
    if (b.day === undefined && b.amountMinor !== undefined && !b.currency && !b.approx && b.amountMinor % 100 === 0 && b.amountMinor >= 100 && b.amountMinor <= 3100) {
      b = { ...b, day: b.amountMinor / 100, amountMinor: undefined };
    }
    const dayKey = kind === 'debt' ? 'dueDay' : 'day';
    if (b.day !== undefined) { item[dayKey] = b.day; if (kind !== 'debt') { item.dayMax = b.dayMax ?? null; item.dayStatus = b.dayMax ? 'estimated' : 'confirmed'; } if (kind === 'obligation') item.dayHint = null; }
    else if (kind === 'obligation' && b.frequency === 'semimonthly') item.dayHint = 'quincena'; // "en quincena": asked, never assumed
    else if (markUnknown && kind !== 'debt') item.dayStatus = 'unknown';
    // An amount while the day was asked corrects the amount ("no, es 3,800"); it is never read as a day.
    if (b.amountMinor !== undefined && (kind === 'obligation' || kind === 'income')) { item.amountMinor = b.amountMinor; item.amountStatus = b.approx ? 'estimated' : 'confirmed'; }
    if (kind === 'income' && b.frequency) item.frequency = b.frequency;
    // Monthly is assumed only for the main income (a salary); an extra income's frequency is asked.
    if (kind === 'income' && item.day !== null && !item.frequency && d.incomes[0]?.id === id) item.frequency = 'monthly';
  } else if (field === 'source' && kind === 'income') {
    // "¿De dónde viene?" answered with numbers ("clases particulares 400"): the numbers are this income's.
    if (b.amountMinor !== undefined) { item.amountMinor = b.amountMinor; item.amountStatus = b.approx ? 'estimated' : 'confirmed'; if (b.currency) item.currency = b.currency; }
    if (b.day !== undefined) { item.day = b.day; item.dayMax = b.dayMax ?? null; item.dayStatus = 'confirmed'; }
    if (b.frequency) item.frequency = b.frequency;
  } else if (field === 'frequency' && b.frequency) item.frequency = b.frequency;
  else if (field === 'cut' && kind === 'debt') { if (b.day !== undefined) item.cutDay = b.day; else return; }
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
  for (const i of d.incomes) if (touched.has(`income:${i.id}`)) out.push({ ref: `income:${i.id}`, label: i.name, value: `${i.amountMinor === null ? 'Monto por confirmar' : money(i.amountMinor, i.currency) + (i.amountStatus === 'estimated' ? ' aprox.' : '')} · ${dayText(i.day, i.dayMax, i.secondDay, i.dayStatus)}${i.frequency === 'occasional' ? ' · ocasional' : ''}` });
  for (const o of d.obligations) if (touched.has(`obligation:${o.id}`)) out.push({ ref: `obligation:${o.id}`, label: o.name, value: `${o.amountMinor === null ? 'Monto por confirmar' : money(o.amountMinor, o.currency) + (o.amountStatus === 'estimated' ? ' aprox.' : '')} · ${dayText(o.day, o.dayMax, null, o.dayStatus)}` });
  for (const x of d.debts) if (touched.has(`debt:${x.id}`)) out.push({ ref: `debt:${x.id}`, label: debtLabel(x), value: debtValue(x) });
  if (d.savings && touched.has('savings')) out.push({ ref: 'savings', label: 'Meta de ahorro', value: d.savings.amountMinor === null ? 'Por definir' : `${money(d.savings.amountMinor, d.savings.currency)} al mes` });
  for (const a of d.accounts) if (touched.has(`account:${a.institution}:${a.kind}`)) out.push({ ref: 'account', label: accountLabel(a), value: a.kind === 'card' ? 'Tarjeta' : 'Cuenta' });
  for (const v of d.variable) if (touched.has(`variable:${v.id}`)) out.push({ ref: `variable:${v.id}`, label: v.name, value: v.amountMinor === null ? 'Monto por confirmar' : `${money(v.amountMinor, v.currency)} al mes${v.amountStatus === 'estimated' ? ' aprox.' : ''}` });
  if (touched.has('balance') && d.balance) out.push({ ref: 'balance', label: 'Saldo de hoy', value: balanceText(d.balance) });
  for (const k of touched) if (k.startsWith('removed:')) out.push({ ref: 'removed', label: 'Quitado', value: k.slice(8) });
  return out;
}

function debtValue(x: DebtFact): string {
  const parts: string[] = [x.balanceMinor === null ? 'Saldo por confirmar' : `Debes ${money(x.balanceMinor, x.currency)}${x.balanceStatus === 'estimated' ? ' aprox.' : ''}`];
  if (x.minimumMinor) parts.push(`mínimo ${money(x.minimumMinor, x.currency)}`);
  if (x.usualPaymentMinor) parts.push(`pagas ${money(x.usualPaymentMinor, x.currency)} al mes`);
  if (x.installmentMinor) parts.push(`cuota ${money(x.installmentMinor, x.currency)}`);
  if (x.installmentsTotal) {
    const paid = x.installmentsPaid ?? (x.installmentsLeft != null ? x.installmentsTotal - x.installmentsLeft : null);
    parts.push(paid === null ? `${x.installmentsTotal} cuotas` : `${paid} de ${x.installmentsTotal} cuotas`);
  }
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
  const ask = (key: string, text: string, replies: string[] = ['Omitir']): Question | null => (d.asked.includes(key) ? null : { key, text, replies });
  const cards = d.debts.filter((x) => x.kind === 'card');
  const loans = d.debts.filter((x) => x.kind === 'loan');
  const declined = (d.declined ?? []).map(fold);
  const work = d.work ?? null;
  const [main, ...others] = d.incomes;
  const named = (i: { name: string }) => (i.name.toLowerCase() === 'sueldo' ? 'el sueldo' : i.name.toLowerCase());
  // Extra incomes ("aparte de tu sueldo"): how much, how often, when; occasional ones are never given a day.
  const business = (i: { name: string }) => i.name === 'Negocio o servicios';
  // Exact dates: "quincenal" asks the two days; "a fin de mes" asks whether it is the last day; never a guess.
  const dateQs = (i: Draft['incomes'][number]) => [
    () => (i.day === null && i.dayHint === 'end' ? ask(`income:${i.id}:end`, '¿Te refieres al último día de cada mes?', ['Sí, el último día', 'Otro día']) : null),
    () => (i.day === null && i.dayHint === 'ask' ? ask(`income:${i.id}:dayexact`, '¿Qué día exactamente?', ['No sé']) : null),
    () => (i.frequency === 'semimonthly' && (i.day === null || i.secondDay === null) ? ask(`income:${i.id}:days`, '¿Qué días exactos cobras? Por ejemplo, 15 y 30.', ['No sé']) : null),
  ];
  // Each extra income on its own, one question at a time, only what is still unknown: where it comes from, how
  // much, which day, how often. Facts given together are kept and never asked again.
  const extraIncome = others.flatMap((i) => business(i) ? [
    () => (i.amountMinor === null && i.amountStatus === 'unknown' ? ask(`income:${i.id}:amount`, 'Y por tu negocio o tus servicios, ¿cuánto esperas cobrar en tu próximo cobro?', ['No sé']) : null),
    () => (i.frequency === null ? ask(`income:${i.id}:frequency`, '¿Lo recibes con frecuencia o es un ingreso ocasional?', ['Cada mes', 'Cada quincena', 'Ocasional']) : null),
    () => (i.day === null && i.frequency !== 'occasional' ? ask(`income:${i.id}:day`, '¿Cuándo esperas recibirlo?', ['No sé']) : null),
    ...dateQs(i),
  ] : [
    () => (GENERIC_INCOME.has(i.name) ? ask(`income:${i.id}:source`, '¿De dónde viene ese ingreso adicional?', ['Omitir']) : null),
    () => (i.amountMinor === null && i.amountStatus === 'unknown' ? ask(`income:${i.id}:amount`, '¿Cuánto recibes?', ['No sé']) : null),
    () => (i.day === null && i.frequency !== 'occasional' && !i.dayHint ? ask(`income:${i.id}:day`, '¿Qué día lo cobras?', ['No sé']) : null),
    ...dateQs(i),
    () => (i.frequency === null ? ask(`income:${i.id}:frequency`, '¿Lo recibes todos los meses o con otra frecuencia?', ['Todos los meses', 'Cada quincena', 'Ocasional']) : null),
  ]);
  // After each extra income is complete: "¿Tienes algún otro ingreso?" again (until "no").
  const moreQ = () => (others.length && !d.done.includes('incomes') ? ask(`income:other:${others.length}`, '¿Tienes algún otro ingreso?', ['No', 'Sí']) : null);
  const salaried = work === 'employee' || work === 'both';
  const balanceQ = () => (d.balance === null ? ask('balance', work === 'independent' ? 'Perfecto. ¿Cuánto dinero tienes actualmente en tus cuentas?'
    : salaried ? '¿Cuánto dinero tienes hoy entre tus cuentas y efectivo?' : '¿Cuánto dinero tienes disponible hoy?', ['No sé']) : null);
  const otherQ = (text: string) => () => (d.done.includes('incomes') ? null : ask('income:other', text, ['No', 'Sí']));
  // Income first, in the order that fits how the person earns (§ dependiente / independiente).
  const incomeFlow: Array<() => Question | null> = work === 'independent' ? [
    balanceQ,
    () => (!main ? ask('income:source', '¿De dónde provienen normalmente tus ingresos?') : null),
    ...(main ? [
      () => (main.amountMinor === null && main.amountStatus === 'unknown' ? ask(`income:${main.id}:amount`, '¿Cuál es tu próximo cobro?', ['No sé']) : null),
      () => (main.day === null ? ask(`income:${main.id}:day`, '¿Cuándo esperas recibirlo?', ['No sé']) : null),
      ...dateQs(main),
      // A day alone does not say it repeats: asked once for an independent income (occasional → never projected).
      () => ask(`income:${main.id}:frequency`, '¿Lo recibes con frecuencia o es un ingreso ocasional?', ['Cada mes', 'Cada quincena', 'Ocasional']),
    ] : []),
    otherQ('¿Tienes algún otro ingreso que debamos considerar?'),
    ...extraIncome,
    moreQ,
  ] : [
    () => (!main ? ask('income:new', work === 'employee' ? 'Perfecto. ¿Cuánto recibes de sueldo al mes?' : '¿Cuánto recibes y qué día te pagan?', ['Omitir']) : null),
    ...(main ? [
      () => (main.amountMinor === null && main.amountStatus === 'unknown' ? ask(`income:${main.id}:amount`, work === 'both' ? 'Perfecto, anotamos tus dos ingresos: sueldo y negocio. Empecemos por el sueldo: ¿cuánto recibes al mes?'
        : salaried && main.name === 'Sueldo' ? '¿Cuánto recibes de sueldo al mes?' : `¿Cuánto recibes de ${main.name.toLowerCase()}?`, ['Omitir']) : null),
      () => (main.day === null ? ask(`income:${main.id}:day`, salaried ? 'Entiendo. ¿En qué fechas te pagan?' : `¿Qué día te pagan ${named(main)}?`) : null),
      ...dateQs(main),
    ] : []),
    // Salary and business: the business income right after the salary (its amount, frequency and date).
    ...(work === 'both' ? extraIncome : []),
    // Without the work type (facts given straight away), today's balance keeps its place right after the income.
    ...(salaried ? [] : [balanceQ]),
    otherQ(work === 'both' ? '¿Tienes algún otro ingreso además de tu sueldo y tu negocio?' : work === 'employee' ? '¿Tienes algún otro ingreso aparte de tu sueldo?' : '¿Tienes algún otro ingreso?'),
    ...extraIncome,
    ...(work === 'both' ? [] : [moreQ]),
    balanceQ,
  ];
  const candidates: Array<() => Question | null> = [
    // Asked first; someone who already told their income ("me pagan 5,700 el 5") is not asked how they earn.
    () => (work === null && !d.incomes.length ? ask('work', 'Antes de empezar, ¿trabajas como dependiente o independiente?', ['Dependiente', 'Independiente']) : null),
    ...incomeFlow,
    // One payment at a time: its amount, then its day, before the next payment.
    ...d.obligations.filter((o) => o.kind !== 'subscription').flatMap((o) => [
      () => (o.amountMinor === null && o.amountStatus === 'unknown' ? ask(`obligation:${o.id}:amount`, `¿Cuánto pagas de ${o.name.toLowerCase()}?`, ['No sé', 'Tomar foto']) : null),
      () => (o.day === null && o.dayHint === 'quincena' ? ask(`obligation:${o.id}:quincena`, '¿Te refieres al 15 de cada mes?', ['Sí, el 15', 'Otro día']) : null),
      () => (o.day === null && o.dayStatus === 'unknown' && !o.dayHint ? ask(`obligation:${o.id}:day`, `¿Qué día pagas ${theName(o.name)}?`, ['No sé']) : null),
      () => (o.day === null && o.dayHint === 'end' ? ask(`obligation:${o.id}:end`, '¿Te refieres al último día de cada mes?', ['Sí, el último día', 'Otro día']) : null),
      () => (o.day === null && o.dayHint === 'ask' ? ask(`obligation:${o.id}:dayexact`, `¿Qué día exactamente pagas ${theName(o.name)}?`, ['No sé']) : null),
    ]),
    // "¿Qué pagos fijos tienes?" first; once there are payments, "¿Tienes algún otro?" is its own (once) question.
    () => (d.done.includes('obligations') ? null : d.obligations.some((o) => o.kind !== 'subscription') || d.variable.length
      ? ask('group:obligations:more', '¿Tienes algún otro pago fijo?', ['No tengo más'])
      : ask('group:obligations', `¿Qué pagos fijos tienes cada mes? ${['Alquiler', 'luz', 'internet'].filter((x) => !declined.includes(fold(x))).join(', ')}…`, ['No tengo más'])),
    // Debts and loans: "no tengo deudas" closes the topic at once.
    () => (!loans.length && !d.debts.some((x) => x.kind === 'personal') && !d.done.includes('loans') && !d.done.includes('debts')
      ? ask('group:loans', '¿Tienes deudas o préstamos? Por ejemplo, con un banco o con una persona.', ['No tengo']) : null),
    ...loans.flatMap((x) => [
      () => (!x.institution ? ask(`debt:${x.id}:institution`, '¿Con qué banco o entidad es el préstamo?', ['No sé']) : null),
      () => (!x.loanType ? ask(`debt:${x.id}:type`, '¿Qué tipo de préstamo es?', ['Personal', 'Vehicular', 'Hipotecario', 'Estudios', 'Otro']) : null),
      () => (x.balanceMinor === null && x.balanceStatus === 'unknown' ? ask(`debt:${x.id}:balance`, '¿Cuánto te falta pagar?', ['No sé']) : null),
      () => (!x.installmentMinor ? ask(`debt:${x.id}:installment`, '¿Cuánto pagas cada mes?', ['No sé']) : null),
      () => (x.dueDay === null ? ask(`debt:${x.id}:day`, '¿Qué día pagas la cuota?', ['No sé']) : null),
      () => (!x.installmentsTotal ? ask(`debt:${x.id}:installments`, '¿De cuántas cuotas es y cuántas llevas pagadas?', ['No sé']) : null),
    ]),
    ...d.debts.filter((x) => x.kind === 'personal').flatMap((x) => [
      () => (x.balanceMinor === null ? ask(`debt:${x.id}:balance`, `¿Cuánto le debes a ${x.lender}?`, ['No sé']) : null),
    ]),
    () => (!cards.length && !d.accounts.some((a) => a.kind === 'card') && !d.done.includes('cards') ? ask('group:cards', '¿Tienes tarjeta de crédito?', ['No tengo']) : null),
    ...cards.flatMap((x) => [
      () => (x.balanceMinor === null && x.balanceStatus === 'unknown' ? ask(`debt:${x.id}:balance`, `¿Cuánto debes ahora en ${cardRef(x)}?`, ['No sé', 'Tomar foto']) : null),
      () => (x.minimumMinor === null ? ask(`debt:${x.id}:minimum`, `¿Cuál es el pago mínimo de ${cardRef(x)}?`, ['No sé', 'Tomar foto']) : null),
      () => (x.dueDay === null ? ask(`debt:${x.id}:day`, `¿Qué día vence el pago de ${cardRef(x)}?`, ['No sé']) : null),
      // The cut-off day is stored on the registered card, which needs its last 4 digits: asked only then.
      () => (x.last4 && x.cutDay == null ? ask(`debt:${x.id}:cut`, `¿Qué día es el corte de ${cardRef(x)}?`, ['No sé']) : null),
    ]),
    // Subscriptions and memberships are payments too (same engine); asked apart because people forget them.
    () => (d.done.includes('subscriptions') ? null : ask('group:subscriptions', '¿Pagas alguna suscripción o membresía, como Netflix, Spotify o el gimnasio? Dime cuál, cuánto y qué día.', ['No tengo'])),
    ...d.obligations.filter((o) => o.kind === 'subscription').flatMap((o) => [
      () => (o.amountMinor === null && o.amountStatus === 'unknown' ? ask(`obligation:${o.id}:amount`, `¿Cuánto pagas de ${o.name}?`, ['No sé']) : null),
      () => (o.day === null && o.dayStatus === 'unknown' ? ask(`obligation:${o.id}:day`, `¿Qué día te cobran ${o.name}?`, ['No sé']) : null),
    ]),
    () => (d.variable.length === 0 ? ask('variable:basics', '¿Cuánto gastas al mes en lo básico, como comida y transporte?', ['No sé']) : null),
    () => (d.savings == null ? ask('savings:goal', '¿Cuánto te gustaría ahorrar cada mes?', ['Todavía no sé']) : null),
  ];
  for (const c of candidates) { const q = c(); if (q) return q; }
  return null;
}

/**
 * Where an income comes from, in the person's words: "Hago diseños de arte digital y recibo S/ 300 cada 5" →
 * "Diseños de arte digital" (own work). Only the words before the amount/date; null when nothing usable is left.
 */
export function incomeSource(said: string): { name: string; source: 'independent' | 'rental' | 'other' } | null {
  const f = fold(said);
  // "me pagan como diseñador 500", "trabajo como fotógrafo": the role is the source ("como" here is not "about").
  const role = /\b(?:trabajo|me pagan|cobro|gano|soy|hago trabajos)\s+(?:como|de)\s+([\p{L} ]{3,40}?)(?=\s+(?:s\/|us\$|\d|y\s|por\s|cada\s|al\s|en\s)|\s*[,.]|\s*$)/u.exec(said.toLowerCase());
  if (role && !/\b(que|eso|esto)\b/.test(role[1]!)) {
    const r = role[1]!.trim();
    return { name: r.charAt(0).toUpperCase() + r.slice(1), source: 'independent' };
  }
  let s = said.split(/\s*(?:\b(?:y )?(?:recibo|cobro|gano|me pagan|me dan|me deja|me depositan|saco)\b|\bs\/|\bus\$|\$|\d|,|\.|\bcada\b|\bal mes\b|\btodos los\b)/i)[0] ?? '';
  s = s.replace(/^\s*(?:s[ií],?\s*)?(?:(?:yo|tambien|también)\s+)*(?:hago|doy|vendo|ofrezco|tengo|trabajo(?:\s+(?:como|en|haciendo|de))?|alquilo|recibo(?:\s+(?:ingresos|plata|dinero))?(?:\s+(?:de|por))?|viene(?:n)?\s+de|de|por)\s+/i, '')
    .replace(/^(?:un|una|unos|unas|mis|mi|los|las|el|la)\s+/i, '').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (s.replace(/\s/g, '').length < 3 || UNKNOWN.test(fold(s)) || /\b(que|dije|conte|eso|esto|ya|si|no)\b/.test(fold(s))) return null;
  const name = s.charAt(0).toUpperCase() + s.slice(1, 40);
  const source = /alquil|renta|inquilin/.test(f) ? 'rental' : /\b(hago|doy|vendo|ofrezco|diseno|disenos|clases|servicios?|freelance|proyectos?|trabajos?|asesor|consult|venta|ventas|negocio|cliente)/.test(f) ? 'independent' : 'other';
  return { name: source === 'rental' && !/alquiler/i.test(name) ? `Alquiler: ${name.toLowerCase()}` : name, source };
}

/**
 * Answers to group questions name a bank: "sí, BCP" to "¿Tienes tarjeta de crédito?" is a card at BCP; "BCP" to
 * "¿Con qué banco es el préstamo?" is that loan's entity. Turns the bank mention into the right fact.
 */
function adaptToPending(d: Draft, patches0: readonly Patch[], said?: string): Patch[] {
  const pending = d.pending ?? '';
  // "A fin de mes" is not a day yet: the day the reader guessed (30/31) is dropped and the person is asked.
  const endOfMonth = !!said && /\b(a )?(fin|fines|finales) de(l)? mes\b/.test(fold(said)) && !/\bultimo\b/.test(fold(said));
  const unend = <T extends Patch>(p: T): T => (endOfMonth && (p.t === 'income' || p.t === 'obligation') && (p.day === 30 || p.day === 31) ? { ...p, day: undefined, dayMax: undefined, endHint: true } : p);
  const named = said ? incomeSource(said) : null;
  // A question about ONE income (its source, amount, day, frequency…): every income fact in the answer is that
  // income's, however many were given at once ("diseños, S/ 300 cada 5 de cada mes" fills them all, once).
  const target = /^income:([^:]+):(\w+)$/.exec(pending);
  const targetId = target && target[1] !== 'other' && target[1] !== 'new' ? target[1] : null;
  if (targetId) {
    const inc = d.incomes.find((x) => x.id === targetId);
    patches0 = patches0.map((p): Patch => {
      // Only an income fact, or a payment the reader could not classify answering about an EXTRA income ("diseños
      // 300"); "internet 90 el 20" stays a payment whatever was asked.
      // While asking where an extra income comes from or how much it is, what the person names IS that income
      // ("clases particulares 400"), whatever kind the reader guessed.
      const aboutIncome = !!inc && inc !== d.incomes[0] && (p.t === 'obligation' || p.t === 'variable')
        && (target![2] === 'source' || target![2] === 'amount' || (p.t === 'obligation' && p.kind === 'other'));
      if (p.t === 'income' || aboutIncome) {
        const rename = inc && GENERIC_INCOME.has(inc.name) && named ? { name: named.name, source: named.source } : {};
        return unend({ t: 'income', id: targetId, ...rename, ...(p.amountMinor !== undefined ? { amountMinor: p.amountMinor, approx: p.approx } : {}), ...(p.currency ? { currency: p.currency } : {}),
          ...(p.t !== 'variable' && p.day !== undefined ? { day: p.day, dayMax: p.dayMax } : {}), ...(p.t === 'income' && p.secondDay !== undefined ? { secondDay: p.secondDay } : {}), ...(p.t === 'income' && p.frequency ? { frequency: p.frequency } : {}) });
      }
      return p;
    });
    if (inc && GENERIC_INCOME.has(inc.name) && named && !patches0.some((p) => p.t === 'income')) patches0 = [...patches0, { t: 'income', id: targetId, name: named.name, source: named.source }];
  }
  patches0 = patches0.map((p) => unend(p));
  // "No tengo más" closes the group being asked (other incomes, subscriptions, loans, cards), not fixed payments.
  const closes: Record<string, 'incomes' | 'subscriptions' | 'loans' | 'cards'> = { 'group:subscriptions': 'subscriptions', 'group:loans': 'loans', 'group:cards': 'cards' };
  const asked = pending.startsWith('income:other') ? 'incomes' : closes[pending];
  if (asked) patches0 = patches0.map((p): Patch => (p.t === 'done' && p.group === 'obligations' ? { t: 'done', group: asked } : p));
  // A known service ("netflix 44.90 el 15") or any payment named in answer to the subscriptions question is a
  // subscription (same obligation engine, its own kind); a catalogue name is written as the service is called.
  const patches = patches0.map((p): Patch => {
    // "¿Tienes algún otro ingreso?" answered with the income itself: ONE new income with everything said, named
    // after its source ("Diseños de arte digital"), never "Otro ingreso" + a second one for the date.
    if (p.t === 'income' && pending.startsWith('income:other') && !p.id) return { ...p, isNew: true, name: named?.name ?? (p.name && p.name !== 'Sueldo' ? p.name : 'Otro ingreso'), ...(named ? { source: named.source } : {}) };
    if (p.t !== 'obligation') return p;
    // Answering "¿Tienes algún otro ingreso?" with "alquiler de un cuarto 400": an income, not a payment.
    // Only a payment the reader could not classify; "alquiler 1,200" or "luz 120" stay payments whatever was asked.
    if ((pending.startsWith('income:other') || pending === 'income:source') && p.kind === 'other') return { t: 'income', isNew: pending.startsWith('income:other') || d.incomes.length > 0, name: named?.name ?? p.name, ...(named ? { source: named.source } : {}), ...(p.amountMinor !== undefined ? { amountMinor: p.amountMinor, approx: p.approx } : {}), ...(p.currency ? { currency: p.currency } : {}), ...(p.day !== undefined ? { day: p.day, dayMax: p.dayMax } : {}) };
    const known = matchProvider(p.name);
    if (known) return { ...p, kind: 'subscription', name: known.name };
    return pending === 'group:subscriptions' && (p.kind === 'other' || p.kind === 'services') ? { ...p, kind: 'subscription' } : p;
  });
  // One answer to "¿Tienes algún otro ingreso?" is ONE income: pieces read apart (amount in one, date in another —
  // e.g. from the provider) are combined, never stored as two records.
  if (pending.startsWith('income:other')) {
    const pieces = patches.filter((p): p is Extract<Patch, { t: 'income' }> => p.t === 'income' && !!p.isNew);
    if (pieces.length > 1) {
      const one = pieces.reduce<Extract<Patch, { t: 'income' }>>((acc, p) => ({ ...p, ...Object.fromEntries(Object.entries(acc).filter(([, v]) => v !== undefined)) } as Extract<Patch, { t: 'income' }>), { t: 'income' });
      const named = pieces.find((p) => p.name && !GENERIC_INCOME.has(p.name))?.name;
      return [...patches.filter((p) => !pieces.includes(p as Extract<Patch, { t: 'income' }>)), { ...one, isNew: true, ...(named ? { name: named } : {}) }];
    }
  }
  const banks = patches.filter((p): p is Extract<Patch, { t: 'account' }> => p.t === 'account');
  if (!banks.length) return [...patches];
  const rest = patches.filter((p) => p.t !== 'account');
  if (pending === 'group:cards') return [...rest, ...banks.map((b): Patch => ({ t: 'debt', kind: 'card', name: `Tarjeta${b.institution !== 'OTRO' ? ` ${BANK_LABEL[b.institution] ?? b.institution}` : ''}`, ...(b.institution !== 'OTRO' ? { institution: b.institution } : {}), ...(b.last4 ? { last4: b.last4 } : {}) }))];
  if (pending === 'group:loans') return [...rest, ...banks.slice(0, 1).map((b): Patch => ({ t: 'debt', kind: 'loan', name: loanName(null, b.institution), institution: b.institution }))];
  const loanInst = /^debt:([^:]+):institution$/.exec(pending);
  if (loanInst) return [...rest, { t: 'debt', kind: 'loan', id: loanInst[1], name: 'Préstamo', institution: banks[0]!.institution }];
  return [...patches];
}

/** "Dependiente", "en planilla", "soy independiente", "trabajo por mi cuenta". Checked before "dependiente". */
export function workIn(folded: string): 'employee' | 'independent' | 'both' | null {
  if (isDoubt(folded)) return null; // "¿qué es dependiente?" names the word but answers nothing
  const indep = /\b(independiente|freelance|freelancer|por mi cuenta|negocio propio|mi propio negocio|tengo (un|mi) negocio|mi negocio|emprend\w*|recibos? por honorarios|por honorarios|cuenta propia|vendo|mis clientes)\b/.test(folded);
  const dep = /\b(dependiente|en planilla|planilla|empleado|empleada|trabajo en una empresa|trabajo para una empresa|asalariad\w*|me pagan sueldo|tengo sueldo)\b/.test(folded.replace(/\bindependiente\b/g, ''));
  if (/\b(ambos|ambas|las dos|los dos|hago (las )?dos|de los dos|un poco de los dos)\b/.test(folded) || (indep && dep)) return 'both';
  return indep ? 'independent' : dep ? 'employee' : null;
}

/** "¿Qué es…?", "no entiendo", "¿a qué te refieres?": a doubt about the question, never an answer to it. */
export function isDoubt(folded: string): boolean {
  const t = folded.replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(que es|que son|que significa|que quiere decir|que seria|a que te refieres|como asi|cual es la diferencia|que diferencia|explica|explicame|no entiendo|no entendi|no se que es|que es eso)\b/.test(t)
    || /\b(que es|que significa|no entiendo|a que te refieres|cual es la diferencia)\b/.test(t) && !/\d/.test(t);
}

export const WORK_HELP = 'Dependiente: trabajas para una empresa y recibes un sueldo.\nIndependiente: trabajas por tu cuenta, tienes un negocio o recibes ingresos por tus servicios.\n¿Con cuál te identificas más?';
const BUSINESS = 'Negocio o servicios';

/** The work type is kept; "ambos" registers both sources (salary + business), each asked for its own data later. */
export function setWork(d: Draft, w: 'employee' | 'independent' | 'both'): void {
  d.work = w;
  if (w !== 'both') return;
  const blank = (name: string) => ({ id: newId('i'), name, currency: 'PEN' as const, amountMinor: null, amountStatus: 'unknown' as const, frequency: null, day: null, dayMax: null, secondDay: null, dayStatus: 'unknown' as const });
  if (!d.incomes.some((i) => i.name === 'Sueldo')) d.incomes.unshift(blank('Sueldo'));
  if (!d.incomes.some((i) => i.name === BUSINESS)) d.incomes.push(blank(BUSINESS));
}

/**
 * A question about what the person already told ("¿cuánto tengo digital y cuánto en efectivo?", "¿cuánto gano?",
 * "¿qué llevas anotado?"): answered from the draft (the facts, never a model), then the pending question again
 * with its options. null = not such a question.
 */
export function answerFromDraft(d: Draft, text: string): Question | null {
  const t = fold(text).replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const question = /[¿?]/.test(text) || /^(cuanto|cuantos|cuantas|que|cual|cuales|dime|recuerdame)\b/.test(t);
  if (!question || /\d/.test(t)) return null;
  let answer: string | null = null;
  if (/\bcuanto\b.*\b(tengo|hay|me queda|me quedan|dinero|plata|efectivo|digital|cuentas?|banco)\b/.test(t) && !/\b(gano|cobro|recibo|debo|pago|gasto)\b/.test(t)) {
    const b = d.balance;
    const m = (v: number) => money(v, b?.currency ?? 'PEN');
    if (!b || b.amountMinor === null) answer = 'Todavía no me dijiste cuánto tienes hoy.';
    else if (b.bankMinor != null && b.cashMinor != null) answer = `En tus cuentas tienes ${m(b.bankMinor)} y en efectivo ${m(b.cashMinor)}.\nEn total tienes ${m(b.amountMinor)}.`;
    else if (b.bankMinor != null) answer = `En tus cuentas tienes ${m(b.bankMinor)}.\nEl efectivo no me lo dijiste todavía.`;
    else if (b.cashMinor != null) answer = `En efectivo tienes ${m(b.cashMinor)}.\nLo de tus cuentas no me lo dijiste todavía.`;
    else answer = /\b(efectivo|digital|cuentas?|banco)\b/.test(t)
      ? `Me dijiste que hoy tienes ${m(b.amountMinor)} en total.\nNo me dijiste cuánto es en cuentas y cuánto en efectivo.`
      : `Hoy tienes ${m(b.amountMinor)}.`;
  } else if (/\b(cuanto|que)\b.*\b(gano|cobro|recibo|me pagan|sueldo|ingresos?)\b/.test(t)) {
    const rows = describe(d, new Set(d.incomes.map((i) => `income:${i.id}`)));
    answer = rows.length ? rows.map((r) => `${r.label}: ${r.value}.`).join('\n') : 'Todavía no me dijiste tus ingresos.';
  } else if (/\b(que|cuales)\b.*\b(pagos|gastos)\b.*\b(tengo|anotaste|registraste|dije)\b/.test(t)) {
    const rows = describe(d, new Set(d.obligations.map((o) => `obligation:${o.id}`)));
    answer = rows.length ? rows.map((r) => `${r.label}: ${r.value}.`).join('\n') : 'Todavía no me dijiste pagos fijos.';
  } else if (/\b(que|cuanto)\b.*\b(debo|deudas?)\b/.test(t)) {
    const rows = describe(d, new Set(d.debts.map((x) => `debt:${x.id}`)));
    answer = rows.length ? rows.map((r) => `${r.label}: ${r.value}.`).join('\n') : 'Todavía no me dijiste deudas.';
  } else if (/\b(que (llevas|tienes|anotaste|registraste|te dije)|que me falta)\b/.test(t)) {
    const s = summarize(d);
    answer = [...s.groups.map((g) => `${g.title}: ${g.items.map((i) => `${i.label.toLowerCase()} ${i.value}`).join('; ')}.`), s.pending.length ? `Falta: ${s.pending.slice(0, 4).join(', ').toLowerCase()}.` : ''].filter(Boolean).join('\n') || 'Todavía no me contaste nada.';
  }
  if (!answer) return null;
  const pending = d.pending;
  const q = pending ? nextQuestion({ ...d, asked: d.asked.filter((k) => k !== pending) }) : nextQuestion(d);
  const again = q && (!pending || q.key === pending) ? q : null;
  return { key: again?.key ?? pending ?? '', text: again ? `${answer}\n\n${again.text}` : answer, replies: again?.replies ?? [] };
}

const HELP: Array<[RegExp, string]> = [
  [/^balance$/, 'Es el dinero que tienes hoy en tus cuentas y en efectivo. No cuentes la línea de tu tarjeta: eso es deuda, no dinero tuyo.'],
  [/^income:other$/, 'Por ejemplo: un trabajo extra, clases, un alquiler o ventas. Si no tienes, dime "no".'],
  [/^income:source$/, 'Por ejemplo: clientes, ventas de tu negocio, comisiones o servicios.'],
  [/^income:[^:]+:frequency$/, 'Con frecuencia: lo recibes cada mes o cada quincena. Ocasional: llega de vez en cuando, sin fecha fija.'],
  [/^income:[^:]+:day$/, 'Es el día del mes en que te depositan. Si te pagan dos veces, dime ambos días, por ejemplo "15 y 30".'],
  [/^group:obligations/, 'Son pagos que se repiten cada mes: alquiler, luz, agua, internet, colegio.'],
  [/^group:loans$/, 'Cualquier dinero que debas devolver: un préstamo del banco, una caja, una financiera o una persona.'],
  [/^debt:[^:]+:minimum$/, 'Es lo menos que el banco te pide pagar este mes para estar al día. Aparece en tu estado de cuenta.'],
  [/^debt:[^:]+:cut$/, 'Es el día en que el banco cierra el mes de tu tarjeta: lo que compras después entra en el siguiente estado de cuenta.'],
  [/^group:subscriptions$/, 'Servicios que te cobran solos cada mes: streaming, música, gimnasio, apps o almacenamiento.'],
  [/^variable:basics$/, 'Lo que gastas en el día a día y cambia cada mes: comida, transporte, salidas.'],
  [/^savings:goal$/, 'Es lo que quieres separar cada mes para ti. Puede ser poco; lo importante es que sea constante.'],
];

/**
 * A doubt about the pending question ("¿qué es dependiente?", "no entiendo"): explained in one line and the SAME
 * question asked again, with its options. It never counts as an answer: the pending question stays.
 * For the work question, "no sé" is a doubt too (there is nothing to skip: it orders the next questions).
 */
export function clarify(d: Draft, text: string): Question | null {
  const pending = d.pending;
  if (!pending) return null;
  const t = fold(text).replace(/[.!¡¿?]/g, '').trim();
  // A question back without numbers ("¿qué cuenta como dinero?", "¿cuál pongo?") is a doubt too.
  const askedBack = /[¿?]/.test(text) && !/\d/.test(t) && /^(que|como|cual|cuales|cuanto cuenta|a que|por que|para que|quien|eso)\b/.test(t);
  const doubt = isDoubt(t) || askedBack || (pending === 'work' && UNKNOWN.test(t) && !workIn(t));
  if (!doubt) return null;
  if (pending === 'work') return { key: 'work', text: WORK_HELP, replies: ['Dependiente', 'Independiente'] };
  const q = nextQuestion({ ...d, asked: d.asked.filter((k) => k !== pending) });
  if (!q || q.key !== pending) return null;
  const help = HELP.find(([re]) => re.test(pending))?.[1] ?? 'Te lo pregunto para calcular cuánto puedes usar sin afectar tus pagos.';
  return { key: pending, text: `${help}\n${q.text}`, replies: q.replies };
}

/** "De mis clientes de diseño" → "Clientes de diseño" (≤ 40 chars, letters only); null when nothing usable. */
function sourceName(raw: string): string | null {
  const s = raw.replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(normalmente |principalmente |sobre todo )?(vienen |provienen |viene )?(de |del )?(mis |mi |los |las |el |la )?/i, '').trim();
  if (s.length < 2) return null;
  const v = s.slice(0, 40);
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/**
 * Replies that only make sense against the pending question and that the generic reader cannot place:
 * "sí / el 15 / otro día" to "¿Te refieres al 15?", a loan's entity or type in words, and loan numbers
 * ("36, llevo 10"; "850"). null = let the normal reading handle the message.
 */
export function pendingReply(d: Draft, text: string): MergeResult | null {
  const pending = d.pending ?? '';
  const t = fold(text).replace(/[.!¡¿?]/g, '').trim();
  if (pending === 'work') {
    const work = workIn(t);
    if (!work || /\d/.test(t)) return null; // facts in the same message: the normal reading keeps them
    const draft = structuredClone(d);
    setWork(draft, work);
    draft.pending = null;
    return { draft, changed: [] };
  }
  if (pending === 'income:source' && !/\d/.test(t)) {
    // "De mis clientes de diseño" → the income is named after its source; amount and date are asked next.
    const unknownSource = UNKNOWN.test(t) || /^(omitir|varios|de todo un poco)$/.test(t);
    const name = unknownSource ? 'Ingresos' : sourceName(text);
    if (!name) return null;
    return mergePatches({ ...d, pending: null }, [{ t: 'income', name }], null);
  }
  const END = /\b(a )?(fin|fines|finales) de(l)? mes\b/;
  const LAST = /^(si|claro|exacto|correcto|asi es)?,? ?(el )?ultimo( dia)?( del mes| de cada mes)?$|^(si|claro|exacto|correcto|asi es)$/;
  const dayIn = /\b(?:el|cada|los|dia)\s+(\d{1,2})\b/.exec(t) ?? /^(\d{1,2})$/.exec(t);
  const inc = /^income:([^:]+):(day|days|dayexact|frequency|end|source)$/.exec(pending);
  if (inc && inc[1] !== 'other' && inc[1] !== 'new') {
    const draft = structuredClone(d);
    const i = draft.incomes.find((x) => x.id === inc[1]);
    if (!i) return null;
    const field = inc[2];
    const done = (): MergeResult => { draft.pending = null; return { draft, changed: describe(draft, new Set([`income:${i.id}`])) }; };
    const setDay = (n: number) => { if (n < 1 || n > 31) return false; Object.assign(i, { day: n, dayMax: null, dayStatus: 'confirmed', dayHint: null }); return true; };
    if (field === 'source') {
      if (/\d/.test(t)) return null; // amount or date too: the normal reading fills THIS income (adaptToPending)
      if (UNKNOWN.test(t)) { draft.pending = null; return { draft, changed: [] }; }
      const n = incomeSource(text) ?? (sourceName(text) ? { name: sourceName(text)!, source: 'other' as const } : null);
      if (!n) return null;
      i.name = n.name;
      i.source = n.source;
      return done();
    }
    if (field === 'frequency') {
      const f = /ocasional|a veces|de vez en cuando|depende|no (es )?fijo|irregular|una vez|variable/.test(t) ? 'occasional'
        : /quincen|cada 15|dos veces al mes/.test(t) ? 'semimonthly' : /mes|mensual|siempre|frecuen|fijo|regular/.test(t) ? 'monthly' : null;
      if (!f) return null;
      i.frequency = f;
      // "Cada 5 de cada mes" answers the frequency AND the day: both are kept (never asked again).
      if (dayIn && i.day === null && f !== 'occasional') setDay(Number(dayIn[1]));
      return done();
    }
    if (field === 'end') {
      if (LAST.test(t)) { setDay(31); return done(); }
      if (dayIn && setDay(Number(dayIn[1]))) return done();
      if (/^(no|otro|otro dia|no exactamente)$/.test(t)) { i.dayHint = 'ask'; draft.pending = null; return { draft, changed: [] }; }
      return null;
    }
    // A date question (day / days / dayexact). "15 y 30", "el 15 y el último": two pay dates a month (quincena).
    const two = /^(?:los dias |el |los |cada )?(\d{1,2})\s*(?:y|,)\s*(?:el |los )?(\d{1,2}|ultimo( dia)?|fin de mes)\b/.exec(t.replace(/\bde cada mes\b/, '').trim());
    if (two) {
      const a = Number(two[1]);
      const b = /^\d/.test(two[2]!) ? Number(two[2]) : 31;
      if (a < 1 || a > 31 || b < 1 || b > 31 || a >= b) return null;
      Object.assign(i, { day: a, secondDay: b, dayMax: null, dayStatus: 'confirmed', frequency: 'semimonthly', dayHint: null });
      return done();
    }
    // "A fin de mes": asked ("¿el último día de cada mes?") before any day is stored; "el último día" is day 31.
    if (END.test(t) && !/ultimo/.test(t)) { i.dayHint = 'end'; draft.pending = null; return { draft, changed: [] }; }
    if (/\bultimo dia\b|^el ultimo$/.test(t)) { setDay(31); return done(); }
    return null;
  }
  // "notion 24 dólares mensual y faceit 5 dólares": every subscription named, each with its own price and currency.
  if (pending === 'group:subscriptions' && /\d/.test(t)) {
    const subs = subscriptionList(fold(text));
    if (subs.length) return mergePatches({ ...d, pending: 'group:subscriptions' }, subs, null);
  }
  const ob = /^obligation:([^:]+):(day|end|dayexact)$/.exec(pending);
  if (ob) {
    const draft = structuredClone(d);
    const o = draft.obligations.find((x) => x.id === ob[1]);
    if (!o) return null;
    const setDay = (n: number) => { if (n < 1 || n > 31) return false; Object.assign(o, { day: n, dayMax: null, dayStatus: 'confirmed', dayHint: null }); return true; };
    const done = (): MergeResult => { draft.pending = null; return { draft, changed: describe(draft, new Set([`obligation:${o.id}`])) }; };
    if (ob[2] === 'end') {
      if (LAST.test(t)) { setDay(31); return done(); }
      if (dayIn && setDay(Number(dayIn[1]))) return done();
      if (/^(no|otro|otro dia|no exactamente)$/.test(t)) { o.dayHint = 'ask'; draft.pending = null; return { draft, changed: [] }; }
      return null;
    }
    if (END.test(t) && !/ultimo/.test(t) && !/\d/.test(t)) { o.dayHint = 'end'; draft.pending = null; return { draft, changed: [] }; }
  }
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
  // Card minimum vs what the person usually pays ("10 soles pero mi pago mensual es de 100"): two different facts.
  if (kind === 'debt' && debt?.kind === 'card' && field === 'minimum' && /\d/.test(t)) {
    const amounts = findAmounts(t, findDays(t));
    if (!amounts.length) return null;
    const usualIdx = amounts.findIndex((a) => /\b(pago (mensual|habitual|normal|de siempre)|normalmente pago|siempre pago|suelo pagar|yo pago|pago al mes|pago cada mes)\b[^\d]{0,12}$/.test(t.slice(Math.max(0, a.index - 40), a.index)) || /^\s*(soles\s+)?(al mes|cada mes|mensual)/.test(t.slice(a.end, a.end + 16)) && amounts.length > 1);
    const usual = usualIdx >= 0 ? amounts[usualIdx] : undefined;
    const min = amounts.find((_, i) => i !== usualIdx);
    if (!min && !usual) return null;
    return mergePatches({ ...d, pending: null }, [{ t: 'debt', kind: 'card', id, name: debt.name, ...(min ? { minimumMinor: min.minor } : {}), ...(usual ? { usualPaymentMinor: usual.minor } : {}) }], null);
  }
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
    const nums = (t.match(/\d+/g) ?? []).map(Number).filter((n) => n <= 600);
    const total = f.installmentsTotal ?? (f.installmentsLeft === undefined ? nums[0] : undefined);
    const paid = f.installmentsPaid ?? (nums.length > 1 && f.installmentsLeft === undefined ? nums[1] : undefined);
    if (total === undefined && paid === undefined && f.installmentsLeft === undefined) return null;
    return loanPatch({ ...(total ? { installmentsTotal: total } : {}), ...(paid !== undefined ? { installmentsPaid: paid } : {}), ...(f.installmentsLeft !== undefined ? { installmentsLeft: f.installmentsLeft } : {}) });
  }
  if (!facts && f.principalMinor === undefined && !f.institution) return null;
  const base: Partial<Extract<Patch, { t: 'debt' }>> = {
    ...(f.currency ? { currency: f.currency } : {}), ...(f.institution ? { institution: f.institution } : {}), ...(f.loanType ? { loanType: f.loanType } : {}),
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
 * partial ("gasto 200 en carro y 100 en comida" read as one item): Gemini, when configured, reads it instead.
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
    ...d.accounts.map((a) => `account:${a.institution}:${a.kind}`), ...d.variable.map((v) => `variable:${v.id}`), ...(d.balance ? ['balance'] : []), ...(d.savings ? ['savings'] : [])]);
  const rows = describe(d, all);
  const pick = (labels: string[]) => rows.filter((r) => labels.includes(r.label));
  const groups = [
    { title: 'Ingresos', items: [...pick(d.incomes.map((i) => i.name)), ...pick(d.balance ? ['Saldo de hoy'] : [])] },
    { title: 'Cuentas', items: pick(d.accounts.map(accountLabel)) },
    { title: 'Pagos', items: [...pick(d.obligations.map((o) => o.name)), ...pick(d.variable.map((v) => v.name))] },
    { title: 'Deudas', items: pick(d.debts.map(debtLabel)) },
    { title: 'Ahorro', items: pick(d.savings ? ['Meta de ahorro'] : []) },
  ].filter((g) => g.items.length);
  const pending: string[] = [];
  for (const i of d.incomes) { if (i.amountMinor === null) pending.push(`Monto de ${i.name.toLowerCase()}`); if (i.day === null) pending.push(`Día de ${i.name.toLowerCase()}`); }
  if (!d.balance || d.balance.amountMinor === null) pending.push('Saldo de hoy');
  for (const o of d.obligations) { if (o.amountMinor === null) pending.push(`Monto de ${o.name.toLowerCase()}`); if (o.day === null) pending.push(`Día de ${o.name.toLowerCase()}`); }
  for (const x of d.debts) if (x.balanceMinor === null) pending.push(`Saldo de ${debtLabel(x).toLowerCase()}`);
  for (const v of d.variable) if (v.amountMinor === null) pending.push(`${v.name}: monto`);
  return { groups, pending };
}

/**
 * The closing summary the person reviews before anything is written: incomes (expected, with their dates), money
 * today, fixed payments, debts and cards, subscriptions, the next payments (planning engine, until the next income)
 * and savings. Every value keeps its state: "aprox." (estimated), "Por confirmar" (unknown); nothing is filled in.
 */
export function finalSummary(d: Draft, today: string): Summary {
  const rows = (keys: string[]) => describe(d, new Set(keys));
  const subs = d.obligations.filter((o) => o.kind === 'subscription');
  const fixed = d.obligations.filter((o) => o.kind !== 'subscription');
  const up = upcomingFromDraft(d, today);
  const groups: Summary['groups'] = [
    { title: 'Ingresos y fechas', items: rows(d.incomes.map((i) => `income:${i.id}`)).map((r) => {
      const i = d.incomes.find((x) => `income:${x.id}` === r.ref);
      const type = i?.source === 'independent' ? ' · trabajo independiente' : i?.source === 'rental' ? ' · alquiler' : '';
      return { ...r, value: `${r.value}${type}${r.value.includes('ocasional') ? '' : ' · esperado'}` };
    }) },
    { title: 'Dinero actual', items: rows(d.balance ? ['balance'] : []) },
    { title: 'Gastos fijos', items: rows(fixed.map((o) => `obligation:${o.id}`)) },
    { title: 'Gastos variables', items: rows(d.variable.map((v) => `variable:${v.id}`)) },
    { title: 'Deudas y tarjetas', items: rows(d.debts.map((x) => `debt:${x.id}`)) },
    { title: 'Suscripciones y membresías', items: rows(subs.map((o) => `obligation:${o.id}`)) },
    { title: 'Próximos pagos', items: up.items.slice(0, 6).map((x) => ({ label: x.name, value: `${shortDate(x.date)} · ${x.amountMinor === null ? 'monto por confirmar' : money(x.amountMinor, x.currency)}${x.estimated ? ' aprox.' : ''}` })) },
    { title: 'Ahorro', items: rows(d.savings ? ['savings'] : []) },
  ].filter((g) => g.items.length);
  return { groups, pending: summarize(d).pending };
}

/** Compact text of the draft for the Gemini prompt (§23): facts, not transcript. */
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
  // "Sí": a new extra income is opened and its data asked one question at a time (source first).
  if (d.pending?.startsWith('income:other')) return no ? { patches: [{ t: 'done', group: 'incomes' }], reask: null } : { patches: [{ t: 'income', isNew: true, name: 'Ingreso adicional' }], reask: null };
  if (d.pending === 'group:subscriptions') return no ? { patches: [{ t: 'done', group: 'subscriptions' }], reask: null } : { patches: [], reask: '¿Cuál? Dime el servicio, cuánto pagas y qué día, por ejemplo "Netflix 44.90 el 15".' };
  if (d.pending === 'group:cards') return no ? { patches: [{ t: 'done', group: 'cards' }], reask: null } : { patches: [], reask: '¿De qué banco es?' };
  if (d.pending === 'group:loans') return no ? { patches: [{ t: 'done', group: 'loans' }, { t: 'done', group: 'debts' }], reask: null } : { patches: [], reask: '¿Con quién es? Dime el banco o la persona y cuánto debes.' };
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
    if (justDay && o.day === null) out.push(`Listo, el día de ${o.kind === 'subscription' ? o.name : theName(o.name)} queda por confirmar.`);
    else if (o.day !== null && (justDay || (!amount && !justAmount))) out.push(`Perfecto. ${cap(theName(o.name))} queda para ${dayPhrase(o.day, o.dayMax)}.`);
    else if (amount && o.day !== null && !justAmount) out.push(`Listo: ${o.name.toLowerCase()}, ${amount} ${dayPhrase(o.day, o.dayMax)}.`);
    else if (amount) out.push(`Listo, ${amount} de ${o.name.toLowerCase()}.`);
  } else if (obligations.length > 1) {
    // Each payment said back with its own amount, so a mix-up is visible at once ("luz S/ 100, agua S/ 100 y alquiler S/ 1,000").
    if (obligations.every((o) => o.amountMinor === null)) { out.push('Ya tengo esos pagos.'); return [...out].join(' '); }
    const items = obligations.map((o) => `${o.kind === 'subscription' ? o.name : o.name.toLowerCase()} ${o.amountMinor === null ? '(monto por confirmar)' : money(o.amountMinor, o.currency)}`);
    const list = items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items.at(-1)}` : items[0];
    const days = [...new Set(obligations.map((o) => o.day))];
    const when = days.length === 1 && days[0] !== null ? `, ${obligations.length === 2 ? 'ambos' : 'todos'} ${dayPhrase(days[0]!, null)}` : '';
    out.push(`Listo: ${list}${when}.`);
  }
  if (others.length === 1) {
    const c = others[0]!;
    if (c.ref === 'balance' && d.balance) out.push(d.balance.amountMinor === null ? 'Lo dejamos pendiente.' : balanceSentence(d.balance));
    else if (c.ref?.startsWith('income:')) out.push(incomeAck(d, c));
    else if (c.ref?.startsWith('debt:')) out.push(debtRecap(d, c, answered));
    else if (c.ref?.startsWith('variable:')) out.push(`Listo, ${c.value.toLowerCase()} en ${c.label.toLowerCase()}.`);
    else out.push('Anotado.');
  } else if (others.length > 1) {
    // Several facts of one kind are said back one by one (no "ya lo tengo" that hides a mix-up).
    if (others.every((c) => c.ref?.startsWith('debt:'))) out.push(`Anotado: ${others.map((c) => `${c.label.replace(/^Préstamo/, 'préstamo').replace(/^Deuda/, 'deuda')} (${c.value.charAt(0).toLowerCase()}${c.value.slice(1)})`).join('; ')}.`);
    else if (others.every((c) => c.ref?.startsWith('variable:'))) out.push(`Listo: ${others.map((c) => `${c.label.toLowerCase()} ${c.value.replace(/ al mes/, '')}`).join(' y ')} al mes.`);
    else out.push('Ya lo tengo.');
  }
  return out.join(' ').replace(/, \./g, '.').replace(/\s+/g, ' ').trim();
}

/** "Listo: en tus cuentas tienes S/ 4,000 y en efectivo S/ 150. En total, S/ 4,150." (or the plain total). */
export function balanceSentence(b: NonNullable<Draft['balance']>): string {
  const m = (v: number) => money(v, b.currency);
  if (b.bankMinor != null && b.cashMinor != null) return `Listo: en tus cuentas tienes ${m(b.bankMinor)} y en efectivo ${m(b.cashMinor)}. En total, ${m(b.amountMinor!)}.`;
  if (b.bankMinor != null) return `Listo: en tus cuentas tienes ${m(b.bankMinor)}. El efectivo queda por confirmar.`;
  if (b.cashMinor != null) return `Listo: en efectivo tienes ${m(b.cashMinor)}. Lo de tus cuentas queda por confirmar.`;
  return `Listo, ${m(b.amountMinor!)} disponibles hoy.`;
}

/** "Anotado: sueldo de S/ 3,500.", "Entiendo, ingresos de clientes.", "Anotado: sueldo, S/ 3,500, días 15 y 30." */
function incomeAck(d: Draft, c: Changed): string {
  const i = d.incomes.find((x) => `income:${x.id}` === c.ref);
  if (!i) return 'Anotado.';
  const name = i.name.toLowerCase();
  if (i !== d.incomes[0]) return extraAck(i);
  const amount = i.amountMinor === null ? null : `${i.amountStatus === 'estimated' ? 'unos ' : ''}${money(i.amountMinor, i.currency)}`;
  const occasional = i.frequency === 'occasional' ? ', ocasional' : '';
  if (i.day === null) return amount ? `Anotado: ${name} de ${amount}${occasional}.` : `Entiendo, ${name === 'ingresos' ? 'lo vemos con calma' : `ingresos de ${name}`}${occasional}.`;
  return `Anotado: ${name}, ${amount ?? 'monto por confirmar'}, ${dayText(i.day, i.dayMax, i.secondDay, i.dayStatus)}${occasional}.`;
}

/** An extra income in one natural line, with only what is known: "Perfecto. Recibes S/ 300 por diseños de arte digital el día 5 de cada mes." */
function extraAck(i: Draft['incomes'][number]): string {
  const generic = GENERIC_INCOME.has(i.name);
  const lower = `${i.name.charAt(0).toLowerCase()}${i.name.slice(1)}`;
  // A role ("Diseñador") reads as "por tu trabajo como diseñador"; a thing ("Diseños de arte digital") as "por …".
  const by = generic ? '' : i.source === 'independent' && !/\s/.test(i.name) ? ` por tu trabajo como ${lower}` : ` por ${lower}`;
  const amount = i.amountMinor === null ? null : `${i.amountStatus === 'estimated' ? 'unos ' : ''}${money(i.amountMinor, i.currency)}`;
  const when = i.frequency === 'occasional' ? ' de forma ocasional'
    : i.day !== null && i.secondDay ? ` los días ${i.day} y ${i.secondDay === 31 ? 'último' : i.secondDay} de cada mes`
    : i.day !== null && i.frequency === 'monthly' ? ` el día ${i.day === 31 ? 'último' : i.day} de cada mes`
    : i.day !== null ? ` el día ${i.day}` : '';
  if (amount && (when || by)) return `Perfecto. Recibes ${amount}${by}${when}.`;
  if (amount) return `Anotado: ${amount}.`;
  if (when) return `Anotado: lo cobras${when}.`;
  return generic ? '' : `Entiendo, ingresos${by}.`;
}

/** A card or loan answer: only the fact just given ("Listo, mínimo S/ 450."); a first mention names it with what came. */
function debtRecap(d: Draft, c: Changed, answered: string | null): string {
  const x = d.debts.find((v) => `debt:${v.id}` === c.ref);
  const named = c.label.replace(/^Tarjeta/, 'tarjeta').replace(/^Préstamo/, 'préstamo');
  const field = x && answered?.startsWith(`debt:${x.id}:`) ? answered.slice(`debt:${x.id}:`.length) : null;
  if (x && field === 'balance' && x.balanceMinor !== null) return `Listo, debes ${x.balanceStatus === 'estimated' ? 'unos ' : ''}${money(x.balanceMinor, x.currency)}.`;
  if (x && field === 'minimum' && x.minimumMinor) return x.usualPaymentMinor ? `Listo: el mínimo es ${money(x.minimumMinor, x.currency)} y sueles pagar ${money(x.usualPaymentMinor, x.currency)} al mes.` : `Listo, mínimo ${money(x.minimumMinor, x.currency)}.`;
  if (x && field === 'installment' && x.installmentMinor) return `Listo, cuota de ${money(x.installmentMinor, x.currency)}.`;
  if (x && field === 'cut' && x.cutDay) return `Perfecto. El corte es el ${x.cutDay}.`;
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
  const income = d.incomes.filter((i) => i.day !== null && i.frequency !== 'occasional').map((i): ExpectedIncome => ({
    id: i.id, name: i.name, currency: i.currency, amountMinor: i.amountMinor, amountStatus: i.amountStatus,
    frequency: i.frequency === 'semimonthly' && i.secondDay ? 'semimonthly' : 'monthly', dayOfMonth: i.day, dayMax: i.dayMax, secondDay: i.secondDay, anchorDate: null,
  })).flatMap((i) => incomeOccurrencesBetween(i, addDays(today, 1), addDays(today, 62))).sort((a, b) => a.date.localeCompare(b.date))[0];
  const until = income ? (income.dateMax ?? income.date) : null;
  const to = until ?? addDays(today, 31);
  const plans: Obligation[] = [
    ...d.obligations.filter((o) => o.day !== null).map((o): Obligation => ({ id: o.id, source: 'obligation', name: o.name, kind: o.kind, currency: o.currency, amountMinor: o.amountMinor,
      amountStatus: o.amountStatus, frequency: 'monthly', anchorMonth: null, dueDay: o.day, dueDayMax: o.dayMax, targetDay: null, since: today })),
    ...d.debts.filter((x) => x.dueDay !== null && (x.kind === 'card' ? (x.usualPaymentMinor ?? x.minimumMinor) != null : !!x.installmentMinor)).map((x): Obligation => ({ id: x.id, source: 'debt', name: x.name,
      // The card's planned payment is what the person usually pays (the minimum when that is all we know) — as written.
      kind: x.kind === 'card' ? 'card' : 'loan', currency: x.currency, amountMinor: x.kind === 'card' ? x.usualPaymentMinor ?? x.minimumMinor : x.installmentMinor ?? null, amountStatus: 'confirmed',
      frequency: 'monthly', anchorMonth: null, dueDay: x.dueDay, dueDayMax: null, targetDay: null, since: today })),
  ];
  const items = plans.flatMap((o) => {
    const next = occurrencesBetween(o, today, addDays(today, 62)).find((x) => x.dueDate !== null && (x.dueDateMax ?? x.dueDate) >= today);
    return next && next.dueDate! <= to ? [{ name: o.name, date: next.dueDate!, dateMax: next.dueDateMax, amountMinor: next.amountMinor, currency: o.currency, estimated: next.amountStatus !== 'confirmed' || !!next.dueDateMax }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return { until, items };
}


/** "agua el 15, internet el 20 y luz el 25" (chronological, from the engine). */
export function agendaLine(items: readonly UpcomingItem[]): string {
  const parts = items.map((x) => `${x.name.toLowerCase()} el ${Number(x.date.slice(8, 10))}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}` : parts[0] ?? '';
}
