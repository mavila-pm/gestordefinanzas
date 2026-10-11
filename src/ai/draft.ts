import type { Currency } from '../domain/money';
import { matchProvider } from '../domain/subscriptions';
import { formatMoney } from '../domain/money';
import { incomeOccurrencesBetween, occurrencesBetween, type ExpectedIncome, type Obligation } from '../engine/planning';
import { addDays, shortDate } from '../domain/dates';
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
  if (kind === 'income' && id === 'other') {
    // "400" to "¿Tienes algún otro ingreso?": a second income, its source asked by name later if needed.
    if (b.amountMinor === undefined) return;
    const inc = { id: newId('i'), name: 'Otro ingreso', currency: b.currency ?? 'PEN', amountMinor: b.amountMinor, amountStatus: status(true, b.approx), frequency: null,
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
    if (b.day !== undefined && kind === 'obligation') { item.day = b.day; item.dayMax = b.dayMax ?? null; item.dayStatus = 'confirmed'; }
  } else if (field === 'day') {
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
    if (kind === 'income' && item.day !== null && !item.frequency) item.frequency = 'monthly';
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
  const ask = (key: string, text: string, replies: string[] = ['Omitir']): Question | null => (d.asked.includes(key) ? null : { key, text, replies });
  const cards = d.debts.filter((x) => x.kind === 'card');
  const loans = d.debts.filter((x) => x.kind === 'loan');
  const declined = (d.declined ?? []).map(fold);
  const work = d.work ?? null;
  const [main, ...others] = d.incomes;
  const named = (i: { name: string }) => (i.name.toLowerCase() === 'sueldo' ? 'el sueldo' : i.name.toLowerCase());
  // Extra incomes ("aparte de tu sueldo"): how much, how often, when; occasional ones are never given a day.
  const business = (i: { name: string }) => i.name === 'Negocio o servicios';
  const extraIncome = others.flatMap((i) => [
    () => (i.amountMinor === null && i.amountStatus === 'unknown' ? ask(`income:${i.id}:amount`, business(i) ? 'Y por tu negocio o tus servicios, ¿cuánto esperas cobrar en tu próximo cobro?' : `¿Cuánto recibes de ${i.name.toLowerCase()}?`, ['No sé']) : null),
    () => (i.frequency === null ? ask(`income:${i.id}:frequency`, business(i) ? '¿Lo recibes con frecuencia o es un ingreso ocasional?' : '¿Cada cuánto lo recibes?', ['Cada mes', 'Cada quincena', 'Ocasional']) : null),
    () => (i.day === null && i.frequency !== 'occasional' ? ask(`income:${i.id}:day`, business(i) ? '¿Cuándo esperas recibirlo?' : '¿Qué día lo cobras?', ['No sé']) : null),
  ]);
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
      // A day alone does not say it repeats: asked once for an independent income (occasional → never projected).
      () => ask(`income:${main.id}:frequency`, '¿Lo recibes con frecuencia o es un ingreso ocasional?', ['Cada mes', 'Cada quincena', 'Ocasional']),
    ] : []),
    otherQ('¿Tienes algún otro ingreso que debamos considerar?'),
    ...extraIncome,
  ] : [
    () => (!main ? ask('income:new', work === 'employee' ? 'Perfecto. ¿Cuánto recibes de sueldo al mes?' : '¿Cuánto recibes y qué día te pagan?', ['Omitir']) : null),
    ...(main ? [
      () => (main.amountMinor === null && main.amountStatus === 'unknown' ? ask(`income:${main.id}:amount`, work === 'both' ? 'Perfecto, anotamos tus dos ingresos: sueldo y negocio. Empecemos por el sueldo: ¿cuánto recibes al mes?'
        : salaried && main.name === 'Sueldo' ? '¿Cuánto recibes de sueldo al mes?' : `¿Cuánto recibes de ${main.name.toLowerCase()}?`, ['Omitir']) : null),
      () => (main.day === null ? ask(`income:${main.id}:day`, salaried ? 'Entiendo. ¿En qué fechas te pagan?' : `¿Qué día te pagan ${named(main)}?`, ['Quincenal', 'No sé']) : null),
    ] : []),
    // Salary and business: the business income right after the salary (its amount, frequency and date).
    ...(work === 'both' ? extraIncome : []),
    // Without the work type (facts given straight away), today's balance keeps its place right after the income.
    ...(salaried ? [] : [balanceQ]),
    otherQ(work === 'both' ? '¿Tienes algún otro ingreso además de tu sueldo y tu negocio?' : work === 'employee' ? '¿Tienes algún otro ingreso aparte de tu sueldo?' : '¿Tienes algún otro ingreso?'),
    ...extraIncome,
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
      () => (o.day === null && o.dayStatus === 'unknown' ? ask(`obligation:${o.id}:day`, `¿Qué día pagas ${theName(o.name)}?`, ['No sé']) : null),
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
 * Answers to group questions name a bank: "sí, BCP" to "¿Tienes tarjeta de crédito?" is a card at BCP; "BCP" to
 * "¿Con qué banco es el préstamo?" is that loan's entity. Turns the bank mention into the right fact.
 */
function adaptToPending(d: Draft, patches0: readonly Patch[]): Patch[] {
  const pending = d.pending ?? '';
  // A known service ("netflix 44.90 el 15") or any payment named in answer to the subscriptions question is a
  // subscription (same obligation engine, its own kind); a catalogue name is written as the service is called.
  const patches = patches0.map((p): Patch => {
    if (p.t === 'income' && pending === 'income:other') return { ...p, isNew: true, name: p.name && p.name !== 'Sueldo' ? p.name : 'Otro ingreso' };
    if (p.t !== 'obligation') return p;
    // Answering "¿Tienes algún otro ingreso?" with "alquiler de un cuarto 400": an income, not a payment.
    // Only a payment the reader could not classify; "alquiler 1,200" or "luz 120" stay payments whatever was asked.
    if ((pending === 'income:other' || pending === 'income:source') && p.kind === 'other') return { t: 'income', isNew: pending === 'income:other' || d.incomes.length > 0, name: p.name, ...(p.amountMinor !== undefined ? { amountMinor: p.amountMinor, approx: p.approx } : {}), ...(p.currency ? { currency: p.currency } : {}), ...(p.day !== undefined ? { day: p.day, dayMax: p.dayMax } : {}) };
    const known = matchProvider(p.name);
    if (known) return { ...p, kind: 'subscription', name: known.name };
    return pending === 'group:subscriptions' && (p.kind === 'other' || p.kind === 'services') ? { ...p, kind: 'subscription' } : p;
  });
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
  const inc = /^income:([^:]+):(day|frequency)$/.exec(pending);
  if (inc) {
    const draft = structuredClone(d);
    const i = draft.incomes.find((x) => x.id === inc[1]);
    if (!i) return null;
    if (inc[2] === 'frequency') {
      const f = /ocasional|a veces|de vez en cuando|depende|no (es )?fijo|irregular|una vez|variable/.test(t) ? 'occasional'
        : /quincen|cada 15|dos veces al mes/.test(t) ? 'semimonthly' : /mes|mensual|siempre|frecuen|fijo|regular/.test(t) ? 'monthly' : null;
      if (!f) return null;
      i.frequency = f;
      draft.pending = null;
      return { draft, changed: describe(draft, new Set([`income:${i.id}`])) };
    }
    // "15 y 30", "el 15 y el último": two pay dates a month (quincena). One date goes through the normal reading.
    const two = /^(?:los dias |el |los |cada )?(\d{1,2})\s*(?:y|,)\s*(?:el |los )?(\d{1,2}|ultimo( dia)?|fin de mes)\b/.exec(t.replace(/\bde cada mes\b/, '').trim());
    if (!two) return null;
    const a = Number(two[1]);
    const b = /^\d/.test(two[2]!) ? Number(two[2]) : 31;
    if (a < 1 || a > 31 || b < 1 || b > 31 || a >= b) return null;
    Object.assign(i, { day: a, secondDay: b, dayMax: null, dayStatus: 'confirmed', frequency: 'semimonthly' });
    draft.pending = null;
    return { draft, changed: describe(draft, new Set([`income:${i.id}`])) };
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
    { title: 'Ingresos y fechas', items: rows(d.incomes.map((i) => `income:${i.id}`)).map((r) => ({ ...r, value: `${r.value}${r.value.includes('ocasional') ? '' : ' · esperado'}` })) },
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
  if (d.pending === 'income:other') return no ? { patches: [{ t: 'done', group: 'incomes' }], reask: null } : { patches: [], reask: '¿Cuánto recibes, de dónde viene y cada cuánto? Por ejemplo: "clases particulares, 400 cada mes".' };
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
    if (o.day !== null && (justDay || (!amount && !justAmount))) out.push(`Perfecto. ${cap(theName(o.name))} queda para ${dayPhrase(o.day, o.dayMax)}.`);
    else if (amount && o.day !== null && !justAmount) out.push(`Listo: ${o.name.toLowerCase()}, ${amount} ${dayPhrase(o.day, o.dayMax)}.`);
    else if (amount) out.push(`Listo, ${amount} de ${o.name.toLowerCase()}.`);
  } else if (obligations.length > 1) {
    out.push(obligations.every((o) => o.amountMinor !== null) && obligations.every((o) => o.day === null) ? 'Ya tengo esos montos.' : 'Ya tengo esos pagos.');
  }
  if (others.length === 1) {
    const c = others[0]!;
    if (c.ref === 'balance' && d.balance) out.push(d.balance.amountMinor === null ? 'Lo dejamos pendiente.' : `Listo, ${money(d.balance.amountMinor, d.balance.currency)} disponibles hoy.`);
    else if (c.ref?.startsWith('income:')) out.push(incomeAck(d, c));
    else if (c.ref?.startsWith('debt:')) out.push(debtRecap(d, c, answered));
    else if (c.ref?.startsWith('variable:')) out.push(`Listo, ${c.value.toLowerCase()} en ${c.label.toLowerCase()}.`);
    else out.push('Anotado.');
  } else if (others.length > 1) out.push('Ya lo tengo.');
  return out.join(' ').replace(/, \./g, '.').replace(/\s+/g, ' ').trim();
}

/** "Anotado: sueldo de S/ 3,500.", "Entiendo, ingresos de clientes.", "Anotado: sueldo, S/ 3,500, días 15 y 30." */
function incomeAck(d: Draft, c: Changed): string {
  const i = d.incomes.find((x) => `income:${x.id}` === c.ref);
  if (!i) return 'Anotado.';
  const name = i.name.toLowerCase();
  const amount = i.amountMinor === null ? null : `${i.amountStatus === 'estimated' ? 'unos ' : ''}${money(i.amountMinor, i.currency)}`;
  const occasional = i.frequency === 'occasional' ? ', ocasional' : '';
  if (i.day === null) return amount ? `Anotado: ${name} de ${amount}${occasional}.` : `Entiendo, ${name === 'ingresos' ? 'lo vemos con calma' : `ingresos de ${name}`}${occasional}.`;
  return `Anotado: ${name}, ${amount ?? 'monto por confirmar'}, ${dayText(i.day, i.dayMax, i.secondDay, i.dayStatus)}${occasional}.`;
}

/** A card or loan answer: only the fact just given ("Listo, mínimo S/ 450."); a first mention names it with what came. */
function debtRecap(d: Draft, c: Changed, answered: string | null): string {
  const x = d.debts.find((v) => `debt:${v.id}` === c.ref);
  const named = c.label.replace(/^Tarjeta/, 'tarjeta').replace(/^Préstamo/, 'préstamo');
  const field = x && answered?.startsWith(`debt:${x.id}:`) ? answered.slice(`debt:${x.id}:`.length) : null;
  if (x && field === 'balance' && x.balanceMinor !== null) return `Listo, debes ${x.balanceStatus === 'estimated' ? 'unos ' : ''}${money(x.balanceMinor, x.currency)}.`;
  if (x && field === 'minimum' && x.minimumMinor) return `Listo, mínimo ${money(x.minimumMinor, x.currency)}.`;
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


/** "agua el 15, internet el 20 y luz el 25" (chronological, from the engine). */
export function agendaLine(items: readonly UpcomingItem[]): string {
  const parts = items.map((x) => `${x.name.toLowerCase()} el ${Number(x.date.slice(8, 10))}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}` : parts[0] ?? '';
}
