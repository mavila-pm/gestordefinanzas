import type { ObligationKind } from '../engine/planning';
import type { Currency } from '../domain/money';
import { APPROX, findAmounts, findDays, fold, LAST4, UNKNOWN, type Amount } from './text';
import type { Bare, DebtKind, Interpretation, Patch } from './types';

/**
 * Deterministic Spanish interpreter (no provider, no cost): reads messy messages like
 * "Me pagan 5,700 el 5, uso BCP, pago el carro como el 10, debo en la tarjeta y le debo plata a mi pareja".
 * It only extracts what is literally there; anything it cannot read is left for a provider (if enabled) or asked.
 */

export const BANKS: Array<[RegExp, string]> = [
  [/\b(bcp|banco de credito|yape)\b/, 'BCP'], [/\b(bbva|continental)\b/, 'BBVA'], [/\b(interbank|ibk|plin)\b/, 'INTERBANK'],
  [/\bscotia(bank)?\b/, 'SCOTIABANK'], [/\bbanbif\b/, 'BANBIF'], [/\bpichincha\b/, 'PICHINCHA'], [/\bfalabella\b/, 'FALABELLA'],
  [/\bripley\b/, 'RIPLEY'], [/\b(caja arequipa|caja huancayo|caja piura|caja cusco)\b/, 'CAJA'], [/\bmibanco\b/, 'MIBANCO'],
];
export const BANK_LABEL: Record<string, string> = {
  BCP: 'BCP', BBVA: 'BBVA', INTERBANK: 'Interbank', SCOTIABANK: 'Scotiabank', BANBIF: 'BanBif', PICHINCHA: 'Pichincha',
  FALABELLA: 'Falabella', RIPLEY: 'Ripley', CAJA: 'Caja', MIBANCO: 'Mibanco',
};

const OBLIGATIONS: Array<[RegExp, ObligationKind, string]> = [
  [/\b(alquiler|renta|arriendo|departamento|depa)\b/, 'rent', 'Alquiler'],
  [/\b(carro|auto|vehicular|camioneta|moto)\b/, 'car', 'Carro'],
  [/\b(internet|wifi|fibra)\b/, 'internet', 'Internet'],
  [/\b(celular|telefono|movil|linea)\b/, 'phone', 'Celular'],
  [/\bluz\b/, 'services', 'Luz'], [/\bagua\b/, 'services', 'Agua'], [/\bgas\b/, 'services', 'Gas'], [/\bcable\b/, 'services', 'Cable'],
  [/\bmantenimiento\b/, 'services', 'Mantenimiento'],
  [/\bseguro\b/, 'insurance', 'Seguro'],
  [/\b(colegio|pension escolar|universidad|matricula|academia|curso|maestria)\b/, 'education', 'Educación'],
  [/\bnetflix\b/, 'subscription', 'Netflix'], [/\bspotify\b/, 'subscription', 'Spotify'], [/\b(disney|hbo|max|prime video|youtube premium)\b/, 'subscription', 'Streaming'],
  [/\b(gimnasio|gym)\b/, 'subscription', 'Gimnasio'],
];
const VARIABLE: Array<[RegExp, string]> = [
  [/\b(comida|mercado|supermercado|alimentacion|menu|almuerzos?)\b/, 'Comida'],
  [/\b(transporte|pasajes?|taxi|uber|gasolina|combustible)\b/, 'Transporte'],
  [/\b(salidas|diversion|ocio)\b/, 'Salidas'],
];
const LENDERS: Array<[RegExp, string]> = [
  [/\b(pareja|enamorad[oa]|espos[oa]|novi[oa])\b/, 'tu pareja'], [/\b(mama|madre|vieja)\b/, 'tu mamá'], [/\b(papa|padre|viejo)\b/, 'tu papá'],
  [/\bherman[oa]\b/, 'tu hermano(a)'], [/\b(amig[oa]|pata|compadre)\b/, 'un amigo'], [/\b(tio|tia|prim[oa]|familia|familiar|suegr[oa])\b/, 'un familiar'],
];

const INCOME = /\b(me pagan|pagan|sueldo|salario|cobro|gano|recibo|ingreso|ingresos|me depositan|me cae|honorarios|remuneracion)\b/;
const DEBT = /\b(debo|deuda|deudas|adeudo|me presto|me prestaron|prestamo)\b/;
const BALANCE = /\b(saldo|tengo ahorrado|me queda|me quedan|tengo (hoy|ahora)|tengo .{0,25}en (la |mi )?(cuenta|banco)|en (la |mi )?cuenta tengo|disponible)\b/;
const CARD = /\b(tarjeta|visa|mastercard|amex|tc)\b/;
const REMOVE = /\b(quita|quitalo|elimina|borra|saca|ya no (tengo|pago|debo))\b/;
const DONE_OBLIGATIONS = /\b(no tengo (mas|otros) (pagos|gastos)|no tengo mas|eso es todo|nada mas|es todo|ningun otro|ninguno mas)\b/;
const NO_DEBTS = /\b(no (tengo|debo) (deudas|nada)|sin deudas|no debo)\b/;
const SEMIMONTHLY = /\b(quincenal|cada quincena|quincena|cada 15 dias|dos veces al mes)\b/;
const MONTHLY = /\b(mensual|al mes|cada mes|mensualmente)\b/;
const NEW_INCOME = /\b(otro ingreso|tambien (cobro|gano|recibo)|extra|freelance|cachuelo|negocio|alquilo)\b/;
const MINIMUM = /\b(minimo|pago minimo)\b/;
/**
 * "No pago alquiler", "yo no pago agua", "alquiler no pago", "no tengo alquiler", "ya no pago luz": the payment does
 * not apply. Only read inside a clause that names a payment, and never for "todavía/aún no pago" (not paid YET) or
 * "no pago el total/mínimo" (how a card is paid): those are not "this payment does not exist".
 */
const NOT_MINE = /\b(no|ya no|nunca)\s+(lo |la |los |las )?(pago|pagamos|tengo|tenemos|uso|usamos)\b/;
const NOT_YET = /\b(todavia|aun|este mes|hoy|total|minimo|completo|a tiempo|todo)\b/;
/** "Eso no lo pago", "no lo tengo", "no aplica": about the payment Vels just asked for (the pending question). */
const NOT_THIS = /^(eso |ese gasto |ese pago |esa |ese )?(no|ya no|nunca)\s+(lo|la|los|las)\s+(pago|tengo|pagamos|tenemos|uso)$|^no aplica$|^no (pago|tengo) (eso|ese|esa)( gasto| pago)?$|^(eso|ese gasto|ese pago) no (lo |la )?(pago|tengo|aplica)$/;
const QUINCENA = /\b(en (la )?quincena|cada quincena|a la quincena|de quincena)\b/;
const LOAN = /\b(prestamo|prestamos|me prestaron|credito (personal|vehicular|hipotecario|de consumo))\b/;
const LOAN_TYPES: Array<[RegExp, string]> = [
  [/\b(vehicular|carro|auto|camioneta|moto)\b/, 'vehicular'], [/\b(hipotecario|hipoteca|casa|depa|departamento|vivienda)\b/, 'hipotecario'],
  [/\b(estudios|universidad|educativo|maestria)\b/, 'de estudios'], [/\b(personal|consumo|libre disponibilidad)\b/, 'personal'],
];

/**
 * Loan facts in plain words: "Me prestaron 20 mil en BCP, pago 850 al mes, son 36 cuotas y ya pagué 10".
 * Each number is read for what it is said to be: installment ("pago/cuota … al mes"), count of installments
 * ("36 cuotas"), installments paid ("llevo/pagué 10"), balance ("me falta/debo"), original amount ("me prestaron",
 * or the remaining amount when the rest is already read). The balance is never computed from the others.
 */
export interface LoanFacts { institution?: string; loanType?: string; principalMinor?: number; balanceMinor?: number; installmentMinor?: number;
  installmentsTotal?: number; installmentsPaid?: number; installmentsLeft?: number; dueDay?: number; approx?: boolean; currency?: Currency }
export function readLoan(t: string): LoanFacts {
  const f: LoanFacts = {};
  const bank = bankIn(t)[0];
  if (bank) f.institution = bank;
  const type = LOAN_TYPES.find(([re]) => re.test(t));
  if (type) f.loanType = type[1];
  const spans: Array<{ index: number; end: number }> = [];
  const total = /\b(?:de |son |a |en )?(\d{1,3})\s*(cuotas|meses)\b/.exec(t);
  if (total && !/\b(faltan?|quedan?)\s+$/.test(t.slice(0, total.index))) { f.installmentsTotal = Number(total[1]); spans.push({ index: total.index, end: total.index + total[0].length }); }
  const left = /\b(?:me )?(?:faltan|quedan)\s+(\d{1,3})(\s*cuotas)?\b/.exec(t);
  if (left) { f.installmentsLeft = Number(left[1]); spans.push({ index: left.index, end: left.index + left[0].length }); if (total && total.index > left.index) delete f.installmentsTotal; }
  const paid = /\b(?:llevo|lleve|pague|he pagado|ya pague|van|tengo pagadas)\s+(\d{1,3})(\s*cuotas)?\b(?!\s*(mil|k\b|soles|dolares|[.,]\d))/.exec(t);
  if (paid) { f.installmentsPaid = Number(paid[1]); spans.push({ index: paid.index, end: paid.index + paid[0].length }); }
  const days = findDays(t);
  if (days[0]) { f.dueDay = days[0].day; spans.push(...days); }
  const amounts = findAmounts(t, spans);
  // PEN ≠ USD: one currency for the loan; soles and dollars in one sentence → no amounts (asked again, never mixed).
  const currencies = new Set(amounts.map((a) => a.currency).filter((c) => c !== null));
  if (currencies.size > 1) return f;
  if (currencies.has('USD')) f.currency = 'USD';
  for (const a of amounts) {
    const before = t.slice(Math.max(0, a.index - 22), a.index);
    const after = t.slice(a.end, a.end + 14);
    if (f.installmentMinor === undefined && (/\b(pago|cuota|cuotas de|mensualidad|abono)\b[^\d]*$/.test(before) || /^\s*(al mes|mensual|cada mes|por mes)\b/.test(after))) f.installmentMinor = a.minor;
    else if (f.balanceMinor === undefined && /\b(falta|faltan|debo|saldo|queda|quedan|pendiente)\b[^\d]*$/.test(before)) f.balanceMinor = a.minor;
    else if (f.principalMinor === undefined) f.principalMinor = a.minor;
    if (a.approx) f.approx = true;
  }
  return f;
}

type Ctx = { t: 'card'; institution?: string; last4?: string } | { t: 'obligation'; kind: ObligationKind; name: string } | { t: 'income' }
  | { t: 'debt'; kind: 'personal' | 'loan'; name: string; institution?: string; lender?: string };
export const bankIn = (t: string) => BANKS.filter(([re]) => re.test(t)).map(([, code]) => code);

/** Splits on sentence/list boundaries but keeps "5,700", "entre el 9 y 10" and "15 y 30" together. */
function clauses(t: string): string[] {
  return t
    .replace(/(\d)\s*(y|o|al|-)\s*(el\s+)?(\d)/g, '$1~$4') // numeric ranges survive the split
    .split(/[;\n]|\.(?!\d)|,(?!\d{3})|\s(?:y(?!\s+medi)|e|pero|tambien|ademas|aparte)\s(?=[a-z])/)
    .map((c) => c.replace(/~/g, ' y ').trim())
    .filter(Boolean);
}

function amountFields(a: Amount | undefined): { amountMinor?: number; currency?: Currency; approx?: boolean } {
  if (!a) return {};
  return { amountMinor: a.minor, ...(a.currency ? { currency: a.currency } : {}), ...(a.approx ? { approx: true } : {}) };
}

/**
 * "gasto 200 en carro 100 en comida y 100 en agua y luz": a list of monthly spending, one item per "<amount> en <thing>".
 * Read as a whole before the clause split, so "agua y luz" stays ONE item of S/ 100 (never split or guessed per part).
 * Spending has no date: none is invented. Returns the items and the text left for the normal reading.
 */
const SPEND_START = /\b(gasto|gastos|gastamos|gasto mensual|mis gastos son)\b/;
const SPEND_PAIR = /(?:s\/\.?\s*)?(\d[\d,.]*)\s*(?:soles\s+)?(?:en|de|para)\s+(?:el |la |los |las |mi |mis )?([a-z][a-z ]*?)(?=\s*(?:[,;.]|$|\s(?:y\s+)?(?:s\/\.?\s*)?\d))/g;
function spendingList(all: string): { items: Patch[]; rest: string } {
  const start = SPEND_START.exec(all);
  if (!start) return { items: [], rest: all };
  const tail = all.slice(start.index + start[0].length);
  const end = tail.search(/[.;\n]/);
  const segment = end < 0 ? tail : tail.slice(0, end);
  const pairs = [...segment.matchAll(SPEND_PAIR)];
  // Only a clean list counts: every amount in the segment belongs to a pair (else the normal reading handles it).
  if (!pairs.length || findAmounts(segment).length !== pairs.length) return { items: [], rest: all };
  const items: Patch[] = [];
  for (const m of pairs) {
    const amount = findAmounts(m[1]!)[0];
    const thing = m[2]!.trim();
    const known = [...VARIABLE.filter(([re]) => re.test(thing)).map(([, label]) => label), ...OBLIGATIONS.filter(([re]) => re.test(thing)).map(([, , label]) => label)];
    const name = /\b(carro|auto|camioneta|moto)\b/.test(thing) && known.length === 1 ? 'Transporte (carro)'
      : known.length === 1 ? known[0]! : thing.charAt(0).toUpperCase() + thing.slice(1);
    items.push({ t: 'variable', name, ...amountFields(amount) });
  }
  return { items, rest: all.slice(0, start.index) + (end < 0 ? '' : tail.slice(end)) };
}

/** "Préstamo vehicular BCP", "Préstamo BCP", "Préstamo". */
export const loanName = (type: string | null | undefined, institution: string | null | undefined) =>
  `Préstamo${type ? ` ${type}` : ''}${institution ? ` ${BANK_LABEL[institution] ?? institution}` : ''}`.slice(0, 60);

export function interpret(message: string): Interpretation {
  const spending = spendingList(fold(message));
  const all = spending.rest;
  const banksInMessage = bankIn(all);
  const patches: Patch[] = [...spending.items];
  let bare: Bare | null = null;
  // The subject of the previous clause: "mi tarjeta BBVA…, debo 2,430, el mínimo es 284, vence el 19" is one card.
  let ctx = null as Ctx | null;

  const parts = clauses(all);
  for (let ci = 0; ci < parts.length; ci++) {
    const c = parts[ci]!;
    const days = findDays(c);
    const last4 = LAST4.exec(c)?.[1];
    const skip = [...days, ...(last4 ? [{ index: c.indexOf(last4), end: c.indexOf(last4) + 4 }] : [])];
    const amounts = findAmounts(c, skip);
    const amount = amounts[0];
    const day = days[0];
    const unknown = UNKNOWN.test(c);
    const banks = bankIn(c);
    const obligation = OBLIGATIONS.find(([re]) => re.test(c));
    const variable = VARIABLE.find(([re]) => re.test(c));
    const lender = LENDERS.find(([re]) => re.test(c));

    if (REMOVE.test(c)) {
      const target = obligation?.[2] ?? variable?.[1] ?? (CARD.test(c) ? 'tarjeta' : lender ? lender[1] : null);
      if (target) { patches.push({ t: 'remove', name: target, declined: true }); continue; }
    }
    // "No pago alquiler": that payment does not apply (removed, never asked again) — not a new empty payment.
    if ((obligation || variable) && NOT_MINE.test(c) && !NOT_YET.test(c) && !amount) {
      patches.push({ t: 'remove', name: obligation?.[2] ?? variable![1], declined: true });
      continue;
    }
    // "Eso no lo pago" without naming it: it answers the pending question (the payment Vels just asked about).
    if (NOT_THIS.test(c.replace(/[.!¡¿?]/g, '').trim())) { bare = { ...(bare ?? {}), none: true }; continue; }
    if (/\b(no tengo|no tenemos|sin|tampoco tengo)( ningun| ninguna)? (prestamos?|creditos?)\b/.test(c)) { patches.push({ t: 'done', group: 'loans' }); continue; }
    if (/\b(no tengo|no tenemos|sin|tampoco tengo)( ninguna)? (tarjetas?|tarjeta de credito)\b/.test(c)) { patches.push({ t: 'done', group: 'cards' }); continue; }
    // A loan is read as a whole: its numbers mean different things (amount lent, installment, count, paid).
    if (LOAN.test(c) && !lender && !CARD.test(c)) {
      let j = ci + 1;
      const otherSubject = (x: string) => INCOME.test(x) || CARD.test(x) || BALANCE.test(x) || OBLIGATIONS.some(([re]) => re.test(x)) || VARIABLE.some(([re]) => re.test(x)) || LENDERS.some(([re]) => re.test(x)) || LOAN.test(x);
      while (j < parts.length && !otherSubject(parts[j]!)) j++;
      const text = parts.slice(ci, j).join(', ');
      ci = j - 1;
      const f = readLoan(text);
      const institution = f.institution ?? (banksInMessage.length === 1 ? banksInMessage[0] : undefined);
      patches.push({
        t: 'debt', kind: 'loan', name: loanName(f.loanType, institution), ...(institution ? { institution } : {}),
        ...(f.loanType ? { loanType: f.loanType } : {}), ...(f.currency ? { currency: f.currency } : {}), ...(f.principalMinor ? { principalMinor: f.principalMinor } : {}),
        ...(f.balanceMinor ? { balanceMinor: f.balanceMinor, ...(f.approx ? { approx: true } : {}) } : {}),
        ...(f.installmentMinor ? { installmentMinor: f.installmentMinor } : {}), ...(f.installmentsTotal ? { installmentsTotal: f.installmentsTotal } : {}),
        ...(f.installmentsPaid !== undefined ? { installmentsPaid: f.installmentsPaid } : {}), ...(f.installmentsLeft !== undefined ? { installmentsLeft: f.installmentsLeft } : {}),
        ...(f.dueDay ? { dueDay: f.dueDay } : {}),
      });
      ctx = null;
      continue;
    }
    if (NO_DEBTS.test(c)) { patches.push({ t: 'done', group: 'debts' }); continue; }
    if (DONE_OBLIGATIONS.test(c)) { patches.push({ t: 'done', group: 'obligations' }); continue; }

    if (INCOME.test(c) && !DEBT.test(c) && !/\b(le pago|pago (el|la|los|mi))\b/.test(c)) {
      const freq = SEMIMONTHLY.test(c) || day?.second ? 'semimonthly' : MONTHLY.test(c) || day ? 'monthly' : undefined;
      patches.push({
        t: 'income', ...(NEW_INCOME.test(c) ? { isNew: true, name: /freelance|cachuelo|negocio/.test(c) ? 'Ingreso extra' : 'Otro ingreso' } : {}),
        ...amountFields(amount), ...(unknown && !amount ? { unknownAmount: true } : {}),
        ...(day ? { day: day.day, ...(day.dayMax ? { dayMax: day.dayMax } : {}), ...(day.second ? { secondDay: day.second } : {}), ...(day.approx ? { approxDay: true } : {}) } : {}),
        ...(freq ? { frequency: freq } : {}),
      });
      for (const b of banks) patches.push({ t: 'account', institution: b, kind: 'bank' });
      ctx = { t: 'income' };
      continue;
    }

    if (DEBT.test(c) || (lender && /\b(plata|dinero|presto)\b/.test(c))) {
      const cur = ctx as Ctx | null;
      const cardCtx = cur?.t === 'card' && !CARD.test(c) && !lender && !/\bprestamo\b/.test(c) ? cur : null;
      const kind: DebtKind = CARD.test(c) || cardCtx ? 'card' : lender ? 'personal' : 'loan';
      const institution: string | undefined = banks[0] ?? cardCtx?.institution ?? (kind !== 'personal' && banksInMessage.length === 1 ? banksInMessage[0] : undefined);
      const name = kind === 'card' ? `Tarjeta${institution ? ` ${BANK_LABEL[institution]}` : ''}` : kind === 'personal' ? `Deuda con ${lender![1]}` : `Préstamo${institution ? ` ${BANK_LABEL[institution]}` : ''}`;
      const min = MINIMUM.test(c) ? amounts.find((a) => MINIMUM.test(c.slice(Math.max(0, a.index - 25), a.index))) : undefined;
      const balance = amounts.find((a) => a !== min);
      patches.push({
        t: 'debt', kind, name, ...(lender && kind === 'personal' ? { lender: lender[1] } : {}), ...(institution ? { institution } : {}),
        ...(last4 ?? cardCtx?.last4 ? { last4: last4 ?? cardCtx?.last4 } : {}), ...(balance ? { balanceMinor: balance.minor, ...(balance.currency ? { currency: balance.currency } : {}), ...(balance.approx ? { approx: true } : {}) } : {}),
        ...(unknown && !balance ? { unknownBalance: true } : {}), ...(min ? { minimumMinor: min.minor } : {}), ...(day ? { dueDay: day.day } : {}),
      });
      if (kind !== 'card') ctx = { t: 'debt', kind, name, ...(institution ? { institution } : {}), ...(lender && kind === 'personal' ? { lender: lender[1] } : {}) };
      if (kind === 'card') ctx = { t: 'card', ...(institution ? { institution } : {}), ...(last4 ?? cardCtx?.last4 ? { last4: last4 ?? cardCtx?.last4 } : {}) };
      continue;
    }

    if (BALANCE.test(c) && amount && !obligation) {
      patches.push({ t: 'balance', amountMinor: amount.minor, ...(amount.currency ? { currency: amount.currency } : {}) });
      continue;
    }

    if (obligation || (CARD.test(c) && (amount || day) && /\b(pago|pagar|vence|cuota)\b/.test(c))) {
      const [, kind, baseName] = obligation ?? [null, 'card' as const, 'Tarjeta'];
      const inst = kind === 'card' ? (banks[0] ?? (banksInMessage.length === 1 ? banksInMessage[0] : undefined)) : undefined;
      patches.push({
        t: 'obligation', kind, name: inst ? `${baseName} ${BANK_LABEL[inst]}` : baseName, ...amountFields(amount),
        ...(unknown && !amount ? { unknownAmount: true } : {}),
        ...(day ? { day: day.day, ...(day.dayMax ? { dayMax: day.dayMax } : {}), ...(day.approx ? { approxDay: true } : {}) } : {}),
        // "Lo pago en quincena": a monthly payment on a 'quincena' is asked, never silently turned into a day.
        ...(!day && (QUINCENA.test(c) || SEMIMONTHLY.test(c)) ? { quincena: true } : {}),
      });
      ctx = { t: 'obligation', kind, name: inst ? `${baseName} ${BANK_LABEL[inst]}` : baseName };
      continue;
    }

    if (variable && (amount || unknown || /\b(gasto|gastos|gastamos|gaste)\b/.test(c))) {
      patches.push({ t: 'variable', name: variable[1], ...amountFields(amount), ...(unknown && !amount ? { unknownAmount: true } : {}) });
      continue;
    }

    if (CARD.test(c) || banks.length) {
      if (CARD.test(c)) {
        const institution = banks[0] ?? banksInMessage[0] ?? 'OTRO';
        patches.push({ t: 'account', institution, kind: 'card', ...(last4 ? { last4 } : {}) });
        ctx = { t: 'card', ...(institution !== 'OTRO' ? { institution } : {}), ...(last4 ? { last4 } : {}) };
      } else for (const b of banks) patches.push({ t: 'account', institution: b, kind: 'bank' });
      continue;
    }

    // No subject of its own: it continues the previous clause's subject…
    if (ctx && (amount || day)) {
      if (ctx.t === 'card') {
        const name = `Tarjeta${ctx.institution ? ` ${BANK_LABEL[ctx.institution]}` : ''}`;
        patches.push({ t: 'debt', kind: 'card', name, ...(ctx.institution ? { institution: ctx.institution } : {}), ...(ctx.last4 ? { last4: ctx.last4 } : {}),
          ...(amount && MINIMUM.test(c) ? { minimumMinor: amount.minor } : amount ? { balanceMinor: amount.minor, ...(amount.approx ? { approx: true } : {}) } : {}),
          ...(day ? { dueDay: day.day } : {}) });
      } else if (ctx.t === 'debt') {
        // "le devuelvo 100 cada mes" is an installment, not the balance: never overwrite the balance with it.
        if (/\b(devuelvo|pago|cuota|abono|mensual|cada mes)\b/.test(c)) continue;
        patches.push({ t: 'debt', kind: ctx.kind, name: ctx.name, ...(ctx.institution ? { institution: ctx.institution } : {}), ...(ctx.lender ? { lender: ctx.lender } : {}),
          ...(amount ? { balanceMinor: amount.minor, ...(amount.approx ? { approx: true } : {}) } : {}), ...(day ? { dueDay: day.day } : {}) });
      } else if (ctx.t === 'obligation') {
        patches.push({ t: 'obligation', kind: ctx.kind, name: ctx.name, ...amountFields(amount), ...(day ? { day: day.day, ...(day.dayMax ? { dayMax: day.dayMax } : {}), ...(day.approx ? { approxDay: true } : {}) } : {}) });
      } else {
        patches.push({ t: 'income', ...amountFields(amount), ...(day ? { day: day.day, ...(day.dayMax ? { dayMax: day.dayMax } : {}), ...(day.second ? { secondDay: day.second } : {}) } : {}) });
      }
      continue;
    }
    // …or, with no subject at all, a bare answer to the pending question. Only short replies count: a long
    // sentence without subject ("me quedé misio antes de fin de mes") is not an answer, it needs understanding.
    const short = c.split(' ').length <= 6;
    if (amount || ((day || unknown) && short)) {
      bare = {
        ...(bare ?? {}), ...(amount ? { amountMinor: amount.minor, ...(amount.currency ? { currency: amount.currency } : {}), ...(amount.approx || APPROX.test(c) ? { approx: true } : {}) } : {}),
        ...(day ? { day: day.day, ...(day.dayMax ? { dayMax: day.dayMax } : {}) } : {}), ...(unknown && !amount && !day ? { unknown: true } : {}),
        ...(SEMIMONTHLY.test(c) ? { frequency: 'semimonthly' as const } : MONTHLY.test(c) ? { frequency: 'monthly' as const } : {}),
      };
    } else if (SEMIMONTHLY.test(c) || MONTHLY.test(c)) {
      bare = { ...(bare ?? {}), frequency: SEMIMONTHLY.test(c) ? 'semimonthly' : 'monthly' };
    }
  }
  return { patches, bare };
}

/** True when a message is just conversational glue ("ok", "gracias") with nothing to store or answer. */
export const isSmallTalk = (message: string) => /^(ok|okay|oki|listo|ya|si|sí|gracias|dale|perfecto|genial|bien|entendido|chevere|chévere)[.! ]*$/i.test(message.trim());
