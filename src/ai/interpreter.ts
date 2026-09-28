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

type Ctx = { t: 'card'; institution?: string; last4?: string } | { t: 'obligation'; kind: ObligationKind; name: string } | { t: 'income' }
  | { t: 'debt'; kind: 'personal' | 'loan'; name: string; institution?: string; lender?: string };
const bankIn = (t: string) => BANKS.filter(([re]) => re.test(t)).map(([, code]) => code);

/** Splits on sentence/list boundaries but keeps "5,700", "entre el 9 y 10" and "15 y 30" together. */
function clauses(t: string): string[] {
  return t
    .replace(/(\d)\s*(y|o|al|-)\s*(el\s+)?(\d)/g, '$1~$4') // numeric ranges survive the split
    .split(/[;\n]|\.(?!\d)|,(?!\d{3})|\s(?:y(?!\s+medi)|pero|tambien|ademas|aparte)\s(?=[a-z])/)
    .map((c) => c.replace(/~/g, ' y ').trim())
    .filter(Boolean);
}

function amountFields(a: Amount | undefined): { amountMinor?: number; currency?: Currency; approx?: boolean } {
  if (!a) return {};
  return { amountMinor: a.minor, ...(a.currency ? { currency: a.currency } : {}), ...(a.approx ? { approx: true } : {}) };
}

export function interpret(message: string): Interpretation {
  const all = fold(message);
  const banksInMessage = bankIn(all);
  const patches: Patch[] = [];
  let bare: Bare | null = null;
  // The subject of the previous clause: "mi tarjeta BBVA…, debo 2,430, el mínimo es 284, vence el 19" is one card.
  let ctx = null as Ctx | null;

  for (const c of clauses(all)) {
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
      if (target) { patches.push({ t: 'remove', name: target }); continue; }
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
