/**
 * Planning forms (untrusted input). Short forms: name, amount (or "no sé"), day (or "no sé" / window), and the rest
 * behind "más opciones". Unknown stays unknown (null), never 0.
 */
import { parseAmountToMinor } from '../domain/money';
import type { ObligationKind } from '../engine/planning';

type Get = (k: string) => unknown;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const cur = (v: unknown) => (v === 'USD' ? 'USD' : v === 'PEN' || v === '' || v === undefined || v === null ? 'PEN' : null);
function day(v: unknown): number | null | 'bad' {
  const s = str(v);
  if (!s) return null;
  if (!/^\d{1,2}$/.test(s)) return 'bad';
  const n = Number(s);
  return n >= 1 && n <= 31 ? n : 'bad';
}
const KINDS: ObligationKind[] = ['rent', 'car', 'loan', 'card', 'internet', 'phone', 'insurance', 'education', 'services', 'taxes', 'subscription', 'other'];
export const KIND_LABEL: Record<ObligationKind, string> = {
  rent: 'Alquiler', car: 'Carro', loan: 'Préstamo', card: 'Tarjeta', internet: 'Internet', phone: 'Celular', insurance: 'Seguro',
  education: 'Educación', services: 'Servicios', taxes: 'Impuestos', subscription: 'Suscripción', other: 'Otro',
};

export interface ObligationForm {
  name: string; kind: ObligationKind; currency: 'PEN' | 'USD'; amountMinor: number | null; amountStatus: 'confirmed' | 'estimated' | 'unknown';
  frequency: 'monthly' | 'bimonthly' | 'quarterly' | 'yearly'; anchorMonth: number | null; dueDay: number | null; dueDayMax: number | null;
  targetDay: number | null; categoryId: string | null;
}

export function parseObligationForm(get: Get): Result<ObligationForm> {
  const name = str(get('name')).replace(/\s+/g, ' ');
  if (!name || name.length > 60 || /[<>\u0000-\u001f]/.test(name)) return { ok: false, error: 'Ponle un nombre (hasta 60 caracteres).' };
  const kind = (KINDS.includes(get('kind') as ObligationKind) ? get('kind') : 'other') as ObligationKind;
  const currency = cur(get('currency'));
  if (!currency) return { ok: false, error: 'Moneda no válida.' };
  const unknownAmount = get('amountUnknown') === '1' || !str(get('amount'));
  const amountMinor = unknownAmount ? null : parseAmountToMinor(str(get('amount')));
  if (!unknownAmount && amountMinor === null) return { ok: false, error: 'Revisa el monto (por ejemplo 129.90).' };
  const amountStatus = unknownAmount ? 'unknown' : get('amountEstimated') === '1' ? 'estimated' : 'confirmed';
  const freq = get('frequency');
  const frequency = freq === 'bimonthly' || freq === 'quarterly' || freq === 'yearly' ? freq : 'monthly';
  const anchor = str(get('anchorMonth'));
  const anchorMonth = frequency === 'monthly' ? null : /^(0?[1-9]|1[0-2])$/.test(anchor) ? Number(anchor) : NaN;
  if (Number.isNaN(anchorMonth)) return { ok: false, error: 'Indica en qué mes vence.' };
  const dueDay = get('dateUnknown') === '1' ? null : day(get('dueDay'));
  const dueDayMax = dueDay === null ? null : day(get('dueDayMax'));
  const targetDay = day(get('targetDay'));
  if (dueDay === 'bad' || dueDayMax === 'bad' || targetDay === 'bad') return { ok: false, error: 'Los días van del 1 al 31.' };
  if (dueDayMax !== null && (dueDay === null || dueDayMax <= dueDay || dueDayMax - dueDay > 7)) return { ok: false, error: 'El rango de fechas es de hasta 7 días (por ejemplo del 9 al 10).' };
  if (targetDay !== null && dueDay !== null && targetDay > (dueDayMax ?? dueDay)) return { ok: false, error: 'El día en que quieres pagar debe ser antes del vencimiento.' };
  const cat = str(get('categoryId'));
  if (cat && !/^[0-9a-f-]{36}$/i.test(cat)) return { ok: false, error: 'Categoría no válida.' };
  return { ok: true, value: { name, kind, currency, amountMinor, amountStatus, frequency, anchorMonth, dueDay, dueDayMax, targetDay, categoryId: cat || null } };
}

export interface IncomeForm {
  name: string; currency: 'PEN' | 'USD'; amountMinor: number | null; amountStatus: 'confirmed' | 'estimated' | 'unknown';
  frequency: 'monthly' | 'semimonthly' | 'biweekly' | 'weekly'; dayOfMonth: number | null; dayMax: number | null; secondDay: number | null; anchorDate: string | null;
}

export function parseIncomeForm(get: Get): Result<IncomeForm> {
  const name = str(get('name')).replace(/\s+/g, ' ') || 'Sueldo';
  if (name.length > 60 || /[<>\u0000-\u001f]/.test(name)) return { ok: false, error: 'Nombre no válido.' };
  const currency = cur(get('currency'));
  if (!currency) return { ok: false, error: 'Moneda no válida.' };
  const raw = str(get('amount'));
  const amountMinor = raw ? parseAmountToMinor(raw) : null;
  if (raw && amountMinor === null) return { ok: false, error: 'Revisa el monto.' };
  const f = get('frequency');
  const frequency = f === 'semimonthly' || f === 'biweekly' || f === 'weekly' ? f : 'monthly';
  const d1 = day(get('dayOfMonth')), dMax = day(get('dayMax')), d2 = day(get('secondDay'));
  if (d1 === 'bad' || dMax === 'bad' || d2 === 'bad') return { ok: false, error: 'Los días van del 1 al 31.' };
  const anchorDate = str(get('anchorDate'));
  if (frequency === 'monthly' && d1 === null) return { ok: false, error: '¿Qué día del mes sueles recibirlo?' };
  if (frequency === 'semimonthly' && (d1 === null || d2 === null || d1 === d2)) return { ok: false, error: 'Indica los dos días del mes.' };
  if ((frequency === 'weekly' || frequency === 'biweekly') && !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) return { ok: false, error: 'Indica la fecha de un pago reciente.' };
  if (dMax !== null && (d1 === null || dMax <= d1 || dMax - d1 > 7)) return { ok: false, error: 'El rango es de hasta 7 días.' };
  return { ok: true, value: {
    name, currency, amountMinor, amountStatus: amountMinor === null ? 'unknown' : 'estimated', frequency,
    dayOfMonth: frequency === 'monthly' || frequency === 'semimonthly' ? d1 : null, dayMax: frequency === 'monthly' ? dMax : null,
    secondDay: frequency === 'semimonthly' ? d2 : null, anchorDate: frequency === 'weekly' || frequency === 'biweekly' ? anchorDate : null,
  } };
}

/** Balance can be negative (overdraft); "0" is a real value. */
export function parseBalanceForm(get: Get): Result<{ currency: 'PEN' | 'USD'; amountMinor: number }> {
  const currency = cur(get('currency'));
  const raw = str(get('amount'));
  const negative = raw.startsWith('-');
  const minor = raw === '0' || raw === '0.00' ? 0 : parseAmountToMinor(negative ? raw.slice(1) : raw);
  if (!currency || minor === null) return { ok: false, error: 'Escribe cuánto tienes hoy (por ejemplo 5000).' };
  return { ok: true, value: { currency, amountMinor: negative ? -minor : minor } };
}

export function parseSettingsForm(get: Get): Result<{ currency: 'PEN' | 'USD'; essentialsMonthlyMinor: number | null; cushionMinor: number }> {
  const currency = cur(get('currency'));
  const e = str(get('essentials'));
  const c = str(get('cushion'));
  const essentials = e ? (e === '0' ? 0 : parseAmountToMinor(e)) : null;
  const cushion = c ? (c === '0' ? 0 : parseAmountToMinor(c)) : 0;
  if (!currency || (e && essentials === null) || cushion === null) return { ok: false, error: 'Revisa los montos.' };
  return { ok: true, value: { currency, essentialsMonthlyMinor: essentials, cushionMinor: cushion } };
}
