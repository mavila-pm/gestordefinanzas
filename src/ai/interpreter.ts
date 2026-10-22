import type { ObligationKind } from '../engine/planning';
import type { Currency } from '../domain/money';
import { APPROX, findAmounts, findDays, fold, LAST4, UNKNOWN, type Amount } from './text';
import type { Bare, DebtKind, Interpretation, Patch } from './types';

/**
 * Deterministic Spanish interpreter (no provider, no cost): reads messy messages like
 * "Me pagan 5,700 el 5, uso BCP, pago el carro como el 10, debo en la tarjeta y le debo plata a mi pareja".
 * It only extracts what is literally there; anything it cannot read is left for Gemini (if configured) or asked.
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
const CARD = /\b(tarjetas?|visa|mastercard|amex|tc)\b/;
/** "Dos tarjetas", "mis tarjetas": several cards, so the banks named after it are cards, not bank accounts. */
const CARDS = /\btarjetas\b/;
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

type Ctx = { t: 'card'; institution?: string; last4?: string; many?: boolean } | { t: 'obligation'; kind: ObligationKind; name: string } | { t: 'income' }
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

const CASH_WORDS = /\b(efectivo|cash|en (la )?mano|en fisico|en billetera|en mi billetera|sencillo|en casa)\b/;
const BANK_WORDS = /\b(cuentas?|banco|bancos|bancari[ao]s?|digital|ahorros|tarjeta de debito|yape|plin|en el app)\b/;

/**
 * "Tengo S/ 4,000 en mis cuentas y S/ 150 en efectivo": money today with its breakdown (banks vs cash). Each amount
 * is classified by the words right after it ("… en efectivo"), else right before it ("en efectivo tengo 150").
 * null unless at least one amount is clearly cash or bank. Never invents a part that was not said.
 */
export function balanceSplit(folded: string): { bankMinor?: number; cashMinor?: number; currency?: Currency } | null {
  if (INCOME.test(folded) || DEBT.test(folded) || /\b(pago|pagar|gasto|cuota)\b/.test(folded)) return null;
  const amounts = findAmounts(folded, findDays(folded));
  if (!amounts.length) return null;
  const out: { bankMinor?: number; cashMinor?: number; currency?: Currency } = {};
  amounts.forEach((a, i) => {
    const after = folded.slice(a.end, amounts[i + 1]?.index ?? folded.length).split(/\by\b|,|;/)[0] ?? '';
    const before = folded.slice(amounts[i - 1]?.end ?? 0, a.index);
    const kind = CASH_WORDS.test(after) ? 'cash' : BANK_WORDS.test(after) ? 'bank' : CASH_WORDS.test(before) ? 'cash' : BANK_WORDS.test(before) ? 'bank' : null;
    if (kind === 'cash' && out.cashMinor === undefined) out.cashMinor = a.minor;
    else if (kind === 'bank' && out.bankMinor === undefined) out.bankMinor = a.minor;
    if (a.currency && !out.currency) out.currency = a.currency;
  });
  return out.cashMinor !== undefined || out.bankMinor !== undefined ? out : null;
}

export function interpret(message: string): Interpretation {
  const t = fold(message);
  // Money today with its breakdown (cuentas / efectivo) is read first and kept whole: never only the last amount.
  const split = balanceSplit(t);
  if (split) return { patches: [{ t: 'balance', ...split }], bare: null };
  // Several debts in one message (a bank loan and a person), several fixed payments, several subscriptions: each
  // item keeps ITS amounts and dates (a list is never read as one item with the first number).
  const cards = cardDebtList(t);
  if (cards) return { patches: cards, bare: null };
  const debts = debtList(t);
  if (debts) return { patches: debts, bare: null };
  const payments = paymentList(t);
  if (payments) return { patches: payments, bare: null };
  return interpretRest(message);
}

const MONTHLY_AFTER = /^\s*(soles\s+|dolares\s+)?(al mes|mensual(es)?|mesual(es)?|mesnaul(es)?|mensaul(es)?|mesnual(es)?|mensuale?s?|cada mes|por mes|x mes|mes a mes)\b/;

/**
 * "pago 100 de luz, 100 de agua, 1000 de alquiler; todo el 5" / "luz 100 agua 100 y 1000 de alquiler cada 5":
 * each payment with the amount next to it ("100 de luz" or "luz 100"); one date said for all applies to all.
 * null unless at least two payments each have their own amount (else the normal reading handles it).
 */
export function paymentList(t: string): Patch[] | null {
  if (DEBT.test(t) || INCOME.test(t) || SPEND_START.test(t)) return null;
  const hits: Array<{ index: number; end: number; kind: ObligationKind; name: string }> = [];
  for (const [re, kind, name] of OBLIGATIONS) {
    if (kind === 'car') continue; // "carro" in a payment list is ambiguous (loan, fuel): left to the normal reading
    for (const m of t.matchAll(new RegExp(re.source, 'g'))) if (!hits.some((h) => h.name === name)) hits.push({ index: m.index!, end: m.index! + m[0].length, kind, name });
  }
  if (hits.length < 2) return null;
  hits.sort((a, b) => a.index - b.index);
  const days = findDays(t);
  const amounts = findAmounts(t, days);
  const used = new Set<number>();
  const items: Array<{ hit: (typeof hits)[number]; amount: Amount | undefined }> = [];
  for (const h of hits) {
    // "100 de luz" (amount right before) or "luz 100" / "luz: S/ 100" (right after); each amount used once.
    const before = amounts.findIndex((a, i) => !used.has(i) && a.end <= h.index && /^\s*(soles\s+)?(de|en|para|del)?\s*(la |el |mi |los |las )?$/.test(t.slice(a.end, h.index)));
    const after = before < 0 ? amounts.findIndex((a, i) => !used.has(i) && a.index >= h.end && /^\s*(:|de|es|son|por|como|unos|unas|aprox\w*|mas o menos|cerca de|casi)?\s*(s\/\.?|us\$|\$)?\s*$/.test(t.slice(h.end, a.index))) : -1;
    const i = before >= 0 ? before : after;
    if (i >= 0) used.add(i);
    items.push({ hit: h, amount: i >= 0 ? amounts[i]! : undefined });
  }
  // A list only when at least two payments carry their own amount; a payment named without one is kept (amount unknown).
  if (items.filter((x) => x.amount).length < 2) return null;
  // Dates: one said for all ("todo lo pago el 5", "… cada 5 de cada mes") goes to each; otherwise each payment takes
  // the date said inside its own part ("luz 120 el 10, agua 80 e internet 99 el 20" → luz 10, agua —, internet 20).
  const distinct = [...new Set(days.map((d) => d.day))];
  const forAll = distinct.length === 1 && (/\b(todo|todos|todas|ambos|ambas|los tres|siempre)\b/.test(t) || /\bde cada mes\b/.test(t) && items.length >= 2 && days[0]!.index > Math.max(...items.map((x) => x.hit.end)));
  const sorted = [...items].sort((a, b) => a.hit.index - b.hit.index);
  return items.map(({ hit, amount }): Patch => {
    const next = sorted.find((x) => x.hit.index > hit.index)?.hit.index ?? t.length;
    const own = days.find((d) => d.index > Math.min(hit.index, amount?.index ?? hit.index) && d.index < next);
    const day = forAll ? days[0]! : own ?? null;
    return { t: 'obligation', kind: hit.kind, name: hit.name, ...amountFields(amount), ...(day ? { day: day.day, ...(day.dayMax ? { dayMax: day.dayMax } : {}), ...(day.approx ? { approxDay: true } : {}) } : {}) };
  });
}

const PROPER_LENDER = /\b(?:de|a|con)\s+([a-z]{3,15})\s+(?:mi|un|una|el|la)\s+(amig[oa]|herman[oa]|prim[oa]|tio|tia|vecin[oa]|compadre|cunad[oa]|jefe|jefa)\b/;
const PERSON_WORDS = /\b(amig[oa]|herman[oa]|prim[oa]|tio|tia|vecin[oa]|compadre|cunad[oa]|jefe|jefa|pareja|enamorad[oa]|espos[oa]|novi[oa]|mama|madre|papa|padre|suegr[oa])\b/;

/**
 * Debts said together: "pago mi préstamo del carro 250 mensuales cada 8 y también un préstamo de Roberto mi amigo,
 * me prestó 100, le pago 10 al mes, voy pagándole 30, me faltan 70". Each part is its own record with its own
 * numbers: a loan's installment is never its principal; a person's loan keeps lent / owed / installment apart.
 * Nothing is computed (the balance is the one said). null unless at least one debt has a number.
 */
export function debtList(t: string): Patch[] | null {
  if (!/\b(prestamo|prestamos|me presto|me prestaron|debo|deuda)\b/.test(t) || CARD.test(t)) return null;
  const parts = t.split(/\b(?:y (?:pago )?tambien|tambien|ademas|y (?:otro|un) prestamo|y le debo|y debo)\b/).map((x) => x.trim()).filter((x) => /\d/.test(x) && /\b(prestamo|presto|prestaron|debo|deuda)\b/.test(x));
  if (!parts.length) return null;
  const out: Patch[] = [];
  for (const part of parts) {
    const proper = PROPER_LENDER.exec(part);
    const person = proper || PERSON_WORDS.test(part) || /\b(me presto|le debo|le pago)\b/.test(part) && !bankIn(part).length;
    if (person) {
      const lenderKnown = LENDERS.find(([re]) => re.test(part));
      const lender = proper ? proper[1]!.charAt(0).toUpperCase() + proper[1]!.slice(1) : lenderKnown?.[1] ?? 'una persona';
      const f: { principal?: number; balance?: number; installment?: number; paid?: number } = {};
      for (const a of findAmounts(part, findDays(part))) {
        const before = part.slice(Math.max(0, a.index - 30), a.index);
        const after = part.slice(a.end, a.end + 18);
        if (f.installment === undefined && (/\b(le pago|pagare|pago|pagando|abono|devuelvo)\b[^\d]{0,12}$/.test(before) && MONTHLY_AFTER.test(after) || MONTHLY_AFTER.test(after) && !/\b(presto|prestaron)\b[^\d]*$/.test(before))) f.installment = a.minor;
        else if (f.balance === undefined && /\b(faltan?|falta pagar|quedan?|debo|le debo|pendiente)\b[^\d]{0,12}$/.test(before)) f.balance = a.minor;
        else if (f.paid === undefined && /\b(pagandole|pagado|pague|le he pagado|abonado|llevo)\b[^\d]{0,12}$/.test(before)) f.paid = a.minor;
        else if (f.principal === undefined && /\b(presto|prestaron|prestamo de|me dio)\b[^\d]{0,12}$/.test(before)) f.principal = a.minor;
      }
      const day = findDays(part)[0];
      // The balance is the one said ("me faltan 70"); with only "me prestó 100" nothing was paid back yet as far as we know.
      const balance = f.balance ?? (f.paid === undefined ? f.principal : undefined);
      out.push({ t: 'debt', kind: 'personal', name: `Deuda con ${lender}`, lender, ...(f.principal !== undefined ? { principalMinor: f.principal } : {}),
        ...(balance !== undefined ? { balanceMinor: balance } : { unknownBalance: true }), ...(f.installment !== undefined ? { installmentMinor: f.installment } : {}), ...(day ? { dueDay: day.day } : {}) });
    } else {
      const f = readLoan(part);
      // "pago mi préstamo … 250 soles mensuales": the installment (never the amount lent).
      if (f.installmentMinor === undefined && f.principalMinor !== undefined) {
        const a = findAmounts(part, findDays(part)).find((x) => x.minor === f.principalMinor);
        if (a && (MONTHLY_AFTER.test(part.slice(a.end, a.end + 18)) || /\bpago\b/.test(part.slice(0, a.index)))) { f.installmentMinor = f.principalMinor; delete f.principalMinor; }
      }
      out.push({ t: 'debt', kind: 'loan', name: loanName(f.loanType, f.institution), ...(f.institution ? { institution: f.institution } : {}), ...(f.loanType ? { loanType: f.loanType } : {}),
        ...(f.currency ? { currency: f.currency } : {}), ...(f.principalMinor !== undefined ? { principalMinor: f.principalMinor } : {}), ...(f.balanceMinor !== undefined ? { balanceMinor: f.balanceMinor } : {}),
        ...(f.installmentMinor !== undefined ? { installmentMinor: f.installmentMinor } : {}), ...(f.installmentsTotal !== undefined ? { installmentsTotal: f.installmentsTotal } : {}),
        ...(f.installmentsPaid !== undefined ? { installmentsPaid: f.installmentsPaid } : {}), ...(f.dueDay !== undefined ? { dueDay: f.dueDay } : {}) });
    }
  }
  // A single plain loan sentence is left to the normal reading (it already handles one loan well).
  return out.length >= 2 || out.some((p) => p.t === 'debt' && p.kind === 'personal' && p.installmentMinor !== undefined) ? out : null;
}

/**
 * Several card debts in one message: "debo en dos tarjetas: bcp 1,200 y bbva 800", "debo 1,200 en la tarjeta bcp y
 * 800 en la tarjeta bbva". Each card is its bank's, with the amount said next to that bank (its balance); a due day or
 * the last 4 digits said in the same part go to that card. Nothing is spread or guessed: a part with two banks or two
 * amounts, a minimum or payment, or any other subject (income, loan, person, payment) leaves the message to the
 * normal reading. null unless at least two cards of different banks are read.
 */
const CARD_LIST_OTHER = /\b(pago|pagar|pagos|cuota|cuotas|minimo|limite|linea)\b/;
export function cardDebtList(t: string): Patch[] | null {
  if (!CARD.test(t) || !DEBT.test(t) || LOAN.test(t) || INCOME.test(t) || BALANCE.test(t) || REMOVE.test(t) || NO_DEBTS.test(t) || SPEND_START.test(t)
    || CARD_LIST_OTHER.test(t) || PERSON_WORDS.test(t) || LENDERS.some(([re]) => re.test(t)) || OBLIGATIONS.some(([re]) => re.test(t)) || VARIABLE.some(([re]) => re.test(t))) return null;
  const pieces = t.split(/\s*[;:\n]\s*|\s*,\s*(?!\d{3}\b)|\s+(?:y(?!\s+medi)|e|tambien|ademas|aparte)\s+/).map((x) => x.trim()).filter(Boolean);
  const cards: Array<Extract<Patch, { t: 'debt' }>> = [];
  for (const piece of pieces) {
    const days = findDays(piece);
    const last4 = LAST4.exec(piece);
    const skip = [...days, ...(last4 ? [{ index: last4.index, end: last4.index + last4[0].length }] : [])];
    const amounts = findAmounts(piece, skip);
    const banks = [...new Set(bankIn(piece))];
    // Each part says only which card and how much ("bcp 1,200", "y 800 en la tarjeta bbva"): anything else is left to
    // the normal reading ("en bbva tengo 3,000" is money in an account, not a card).
    if (banks.length > 1 || amounts.length > 1 || days.length > 1 || !onlyBank(piece, [...skip, ...amounts], CARD_WORDS)) return null;
    const amount = amounts[0];
    const day = days[0];
    const facts = { ...(amount ? { balanceMinor: amount.minor, ...(amount.currency ? { currency: amount.currency } : {}), ...(amount.approx ? { approx: true } : {}) } : {}),
      ...(day ? { dueDay: day.day } : {}), ...(last4 ? { last4: last4[1]! } : {}) };
    if (banks.length === 1) {
      const institution = banks[0]!;
      if (cards.some((c) => c.institution === institution)) return null; // the same bank twice: which amount is which is not said
      cards.push({ t: 'debt', kind: 'card', name: `Tarjeta ${BANK_LABEL[institution] ?? institution}`, institution, ...facts,
        ...(!amount && UNKNOWN.test(piece) ? { unknownBalance: true } : {}) });
    } else if (amount || day || last4) {
      // "tarjeta bcp, debo 1,200": a part with no bank continues the card just named, only with what it still lacks.
      const prev = cards.at(-1);
      if (!prev || (amount && prev.balanceMinor !== undefined) || (day && prev.dueDay !== undefined) || (last4 && prev.last4 !== undefined)) return null;
      Object.assign(prev, facts);
    }
  }
  return cards.length >= 2 ? cards : null;
}

/** What is left of a clause once a bank, amounts, days and connecting words are taken out is empty: "y en la bbva 800". */
const BANK_FILLER = /\b(en|la|el|los|las|de|del|mi|mis|su|sus|otra|otro|tambien|y|con|s|soles?|dolares?|us|usd|pen|vence)\b/g;
/** Words a card-debt list may also carry: "debo en dos tarjetas", "tengo deuda en la de bbva", "como 800", "no sé". */
const CARD_WORDS = /\b(tengo (una |un )?deudas?|debo|deudas?|tarjetas?|visa|mastercard|amex|tc|de credito|credito|dos|tres|ambas|un|una|que|ahora|hoy|como|aprox\w*|unos|unas|mas o menos|casi|no se|ni idea)\b/g;
function onlyBank(c: string, spans: ReadonlyArray<{ index: number; end: number }>, words?: RegExp): boolean {
  let s = c;
  for (const sp of [...spans].sort((a, b) => b.index - a.index)) s = `${s.slice(0, sp.index)} ${s.slice(sp.end)}`;
  for (const [re] of BANKS) s = s.replace(new RegExp(re.source, 'g'), ' ');
  if (words) s = s.replace(words, ' ');
  return s.replace(BANK_FILLER, ' ').replace(/[^a-z]+/g, ' ').trim() === '';
}

/**
 * "notion 24 dólares mensual y faceit 5 dólares": subscriptions named with their price, each its own record, in its
 * currency (PEN ≠ USD). Used while the subscriptions question is pending. Days are asked afterwards, never guessed.
 */
export function subscriptionList(t: string): Patch[] {
  const clean = t.replace(/^(si|sí|claro|tengo|pago|uso)\b[, ]*/, '');
  const out: Patch[] = [];
  const re = /([a-z][a-z0-9+.]*(?:\s(?!de\b|y\b|a\b|por\b|mensual|al\b|cada\b)[a-z0-9+.]+)?)\s+(?:de\s+|a\s+|por\s+|en\s+)?(s\/\.?|us\$|\$|usd)?\s*(\d+(?:[.,]\d{1,2})?)\s*(dolares|dolar|usd|soles|sol)?/g;
  for (const m of clean.matchAll(re)) {
    const raw = m[1]!.replace(/^(y|e|tambien|pago|tengo|uso|el|la|mi)\s+/, '').trim();
    if (!raw || /^(cada|el|dia|al|mensual|y|de|si|pago|unos|unas|como|aprox\w*|mas|menos|cerca|casi|alrededor|gasto|gastos|soles|dolares|tengo|son|es|total|en)$/.test(raw.split(' ')[0]!)) continue;
    const usd = /^(us\$|\$|usd)$/.test(m[2] ?? '') || /^(dolares|dolar|usd)$/.test(m[4] ?? '');
    const minor = Math.round(Number(m[3]!.replace(',', '.')) * 100);
    if (!minor || minor > 1e9) continue;
    const day = findDays(clean.slice(m.index! + m[0].length, m.index! + m[0].length + 20))[0];
    out.push({ t: 'obligation', kind: 'subscription', name: raw.charAt(0).toUpperCase() + raw.slice(1), amountMinor: minor, currency: usd ? 'USD' : 'PEN', ...(day ? { day: day.day } : {}) });
  }
  return out;
}

function interpretRest(message: string): Interpretation {
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
    if (/\b(no tengo|no pago|sin|tampoco tengo)( ninguna)? (suscripciones?|membresias?)\b/.test(c)) { patches.push({ t: 'done', group: 'subscriptions' }); continue; }
    if (/\b(no tengo|tampoco tengo)( ningun)? (otros? ingresos?|mas ingresos)\b/.test(c)) { patches.push({ t: 'done', group: 'incomes' }); continue; }
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
      if (kind === 'card') ctx = { t: 'card', ...(institution ? { institution } : {}), ...(last4 ?? cardCtx?.last4 ? { last4: last4 ?? cardCtx?.last4 } : {}), ...(CARDS.test(c) || cardCtx?.many ? { many: true } : {}) };
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

    // After a card subject, a clause with only a bank and an amount ("…, y bbva 800") is THAT bank's card and what is
    // owed on it, never a bank account; after "tengo dos tarjetas", a bank alone ("bcp y bbva") names one of the cards.
    const cardSubject = ctx as Ctx | null;
    if (cardSubject?.t === 'card' && banks.length === 1 && !CARD.test(c) && (amount || day || cardSubject.many) && onlyBank(c, [...skip, ...amounts])) {
      const b = banks[0]!;
      if (amount || day) {
        patches.push({ t: 'debt', kind: 'card', name: `Tarjeta ${BANK_LABEL[b] ?? b}`, institution: b, ...(last4 ? { last4 } : {}),
          ...(amount ? { balanceMinor: amount.minor, ...(amount.currency ? { currency: amount.currency } : {}), ...(amount.approx ? { approx: true } : {}) } : {}), ...(day ? { dueDay: day.day } : {}) });
      } else patches.push({ t: 'account', institution: b, kind: 'card' });
      ctx = { t: 'card', institution: b, ...(cardSubject.many ? { many: true } : {}) };
      continue;
    }
    if (CARD.test(c) || banks.length) {
      if (CARD.test(c)) {
        // "Tengo dos tarjetas" without a bank in that clause: the banks said next name them; none is assumed here.
        const many = CARDS.test(c) && !banks.length;
        const institution = banks[0] ?? (many ? undefined : banksInMessage[0]) ?? 'OTRO';
        if (!many) patches.push({ t: 'account', institution, kind: 'card', ...(last4 ? { last4 } : {}) });
        ctx = { t: 'card', ...(institution !== 'OTRO' ? { institution } : {}), ...(last4 ? { last4 } : {}), ...(CARDS.test(c) ? { many: true } : {}) };
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
