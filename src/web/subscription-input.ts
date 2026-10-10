/**
 * Mis suscripciones form (untrusted input, whitelist-parsed). Required: service (catalogue or own name), currency,
 * frequency and the next charge date; the price may be "por confirmar" (unknown, never 0). The next date becomes the
 * obligation's due day (and anchor month for non-monthly), so the planning engine projects it like any payment.
 */
import { parseAmountToMinor } from '../domain/money';
import { addDays } from '../domain/dates';
import { providerBySlug } from '../domain/subscriptions';

type Get = (k: string) => unknown;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SubscriptionForm {
  name: string; provider: string | null; currency: 'PEN' | 'USD'; amountMinor: number | null; amountStatus: 'confirmed' | 'unknown';
  frequency: 'monthly' | 'quarterly' | 'yearly'; dueDay: number; anchorMonth: number | null; cardId: string | null; accountId: string | null;
}

export function parseSubscriptionForm(get: Get, today: string): Result<SubscriptionForm> {
  const slug = str(get('provider'));
  const provider = slug ? providerBySlug(slug) : null;
  if (slug && !provider) return { ok: false, error: 'Elige un servicio de la lista o escribe su nombre.' };
  const name = (str(get('name')) || provider?.name || '').replace(/\s+/g, ' ');
  if (!name || name.length > 60 || /[<>\u0000-\u001f]/.test(name)) return { ok: false, error: 'Escribe el nombre del servicio (hasta 60 caracteres).' };
  const c = get('currency');
  const currency = c === 'USD' ? 'USD' : c === 'PEN' || c === undefined || c === null || c === '' ? 'PEN' : null;
  if (!currency) return { ok: false, error: 'Elige soles o dólares.' };
  const raw = str(get('amount'));
  const amountMinor = raw ? parseAmountToMinor(raw) : null;
  if (raw && (amountMinor === null || amountMinor <= 0)) return { ok: false, error: 'Revisa el precio (por ejemplo 44.90).' };
  const f = get('frequency');
  const frequency = f === 'yearly' || f === 'quarterly' ? f : f === 'monthly' || !f ? 'monthly' : null;
  if (!frequency) return { ok: false, error: 'Elige cada cuánto se cobra.' };
  const next = str(get('nextDate'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || Number.isNaN(Date.parse(`${next}T12:00:00Z`)) || new Date(`${next}T12:00:00Z`).toISOString().slice(0, 10) !== next) {
    return { ok: false, error: 'Indica la fecha del próximo cobro.' };
  }
  if (next < addDays(today, -31) || next > addDays(today, 400)) return { ok: false, error: 'La fecha del próximo cobro debe estar dentro del próximo año.' };
  const inst = str(get('instrument'));
  const [kind, id] = inst.split(':');
  if (inst && (!(kind === 'card' || kind === 'account') || !UUID.test(id ?? ''))) return { ok: false, error: 'Elige una tarjeta o cuenta de la lista.' };
  return { ok: true, value: {
    name, provider: provider?.slug ?? null, currency, amountMinor, amountStatus: amountMinor === null ? 'unknown' : 'confirmed', frequency,
    dueDay: Number(next.slice(8, 10)), anchorMonth: frequency === 'monthly' ? null : Number(next.slice(5, 7)),
    cardId: kind === 'card' ? id! : null, accountId: kind === 'account' ? id! : null,
  } };
}
