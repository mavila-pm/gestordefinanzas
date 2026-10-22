import { createHash, timingSafeEqual } from 'node:crypto';
import type { Currency, ProviderCharge, ProviderErrorKind, ProviderPlan, ProviderRefund, ProviderSubscription } from './provider';

/**
 * Culqi, pure part (ADR-0019): endpoints, id patterns, request bodies, response validators and webhook parsing.
 * No I/O here (the HTTP client is src/billing/culqi-client.ts). Every Culqi response is untrusted input: it is read
 * through a fixed schema, ids must match their pattern and mode (test/live), amounts must be integers.
 *
 * Sources. The official docs (docs.culqi.com / apidocs.culqi.com) do not resolve from the build sandbox (ENOTFOUND,
 * re-tried 2026-10-22), so the reference is the official PHP SDK source, read 2026-10-22 (raw.githubusercontent.com/
 * culqi/culqi-php/master: lib/Culqi/*.php, lib/Culqi/Utils/Validation/*, Utils/Constant/Request/Plan.php):
 * - CONFIRMED: base https://api.culqi.com/v2 (tokens at https://secure.culqi.com/v2); /charges, /refunds, /customers,
 *   /cards; plans at /recurrent/plans (create = POST /recurrent/plans/create; GET/PATCH/DELETE /recurrent/plans/{id};
 *   PATCH cannot change amount, currency, interval or initial_cycles); subscriptions at /recurrent/subscriptions
 *   (create = POST /recurrent/subscriptions/create with exactly {card_id, plan_id, tyc: true, metadata?}; GET and
 *   DELETE /recurrent/subscriptions/{id}; PATCH only changes card_id); plan and subscription ids are 25 characters;
 *   interval_unit_time ∈ {1..6}; currencies PEN/USD; initial_cycles {count, has_initial_charge, amount,
 *   interval_unit_time} (count ≥ 1 with an initial charge, 0..9999 without); refund reason ∈ {duplicado,
 *   fraudulento, solicitud_comprador}; card create = {customer_id (cus…), token_id (tkn…)}; customer create needs
 *   non-empty first_name, last_name, address, address_city, a valid email, country_code and phone_number (string);
 *   integration keys are "test" and production keys "live" (ids such as crd_live_…, pln_live_…).
 * - UNVERIFIED (unofficial @jibaru/culqi 2026 + audit notes, nothing official reachable): outcome.type
 *   'venta_exitosa' = paid; what each interval_unit_time number means (we assume 1 = day, 3 = month, 4 = year);
 *   how a free trial is expressed (we assume initial_cycles with has_initial_charge false, amount 0, count = days,
 *   unit = day); subscription response fields (trial_end, next_billing_date, active_card, customer_id, plan_id) and
 *   status codes; timestamps in ms; key prefixes pk_test_/sk_test_/pk_live_/sk_live_; webhook body {object:'event',
 *   type, data (object or JSON string), id} and its HTTP Basic auth; 3-D Secure answer 'action_code: REVIEW';
 *   customers filter ?email=; card validate:true; charge amount_refunded; charge metadata.subscription_id; GET of a
 *   cancelled subscription (404 or 200 with a status).
 * Each UNVERIFIED item is in docs/runbooks/billing-culqi.md (sandbox checklist) and marked // UNVERIFIED below.
 */
export const CULQI_API = 'https://api.culqi.com/v2';
export { CULQI_CHECKOUT_SCRIPT } from './culqi-public';

export const PATHS = {
  charges: '/charges',
  charge: (id: string) => `/charges/${id}`,
  refunds: '/refunds',
  refund: (id: string) => `/refunds/${id}`,
  customers: '/customers',
  customersByEmail: (email: string) => `/customers?email=${encodeURIComponent(email)}`, // UNVERIFIED filter
  cards: '/cards',
  plan: (id: string) => `/recurrent/plans/${id}`,
  subscriptionCreate: '/recurrent/subscriptions/create',
  subscription: (id: string) => `/recurrent/subscriptions/${id}`,
} as const;

export type CulqiKind = 'chr' | 'tkn' | 'crd' | 'cus' | 'pln' | 'sxn' | 'ref' | 'evt' | 'ord';
const ID = /^(chr|tkn|crd|cus|pln|sxn|ref|evt|ord)_(test|live)_[A-Za-z0-9]{6,64}$/;

/** The kind and mode of a Culqi id, or null when it is not one (never interpolated into a URL otherwise). */
export function culqiId(v: unknown, kind?: CulqiKind): { kind: CulqiKind; livemode: boolean } | null {
  if (typeof v !== 'string') return null;
  const m = ID.exec(v);
  if (!m || (kind && m[1] !== kind)) return null;
  return { kind: m[1] as CulqiKind, livemode: m[2] === 'live' };
}
export const isCulqiId = (v: unknown, kind: CulqiKind, livemode: boolean): v is string => culqiId(v, kind)?.livemode === livemode;

/** 'test' | 'live' when both keys are well formed and of the same mode; null otherwise. */
export function keyMode(publicKey: string | undefined, secretKey: string | undefined): 'test' | 'live' | null {
  const pk = /^pk_(test|live)_[A-Za-z0-9]{8,128}$/.exec(publicKey ?? '');
  const sk = /^sk_(test|live)_[A-Za-z0-9]{8,128}$/.exec(secretKey ?? '');
  if (!pk || !sk || pk[1] !== sk[1]) return null;
  return pk[1] as 'test' | 'live';
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const currency = (v: unknown): Currency | null => (v === 'USD' || v === 'PEN' ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const metaOrder = (o: Record<string, unknown>): string | null => {
  const m = o.metadata;
  return isObj(m) && typeof m.order_id === 'string' && UUID.test(m.order_id) ? m.order_id : null;
};

/** Culqi timestamps: epoch ms (UNVERIFIED; seconds and ISO strings also accepted). Sane range only. */
export function culqiDate(v: unknown): Date | null {
  let ms: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) ms = v < 1e11 ? v * 1000 : v;
  else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) ms = Date.parse(v);
  if (ms === null || !Number.isFinite(ms)) return null;
  return ms > Date.UTC(2020, 0, 1) && ms < Date.UTC(2100, 0, 1) ? new Date(ms) : null;
}

// ── Response validators (fixed schemas) ────────────────────────────────────────────────────────────────────────
export function parseCharge(v: unknown): ProviderCharge | null {
  if (!isObj(v)) return null;
  const id = culqiId(v.id, 'chr');
  const cur = currency(v.currency_code);
  if (!id || !cur || !intIn(v.amount, 1, 100_000_000)) return null;
  const outcome = isObj(v.outcome) ? v.outcome : null;
  // UNVERIFIED: 'venta_exitosa' is the success outcome; a charge held without capture is not final.
  const succeeded = outcome?.type === 'venta_exitosa' && v.capture !== false;
  const meta = isObj(v.metadata) ? v.metadata : {};
  const sub = culqiId(meta.subscription_id, 'sxn') ? (meta.subscription_id as string) : null; // UNVERIFIED field
  const refunded = intIn(v.amount_refunded, 0, 100_000_000) ? v.amount_refunded : 0; // UNVERIFIED field
  return { id: v.id as string, amountMinor: v.amount, currency: cur, succeeded, refundedMinor: refunded, orderId: metaOrder(v), subscriptionRef: sub, livemode: id.livemode };
}

export function parseRefund(v: unknown): ProviderRefund | null {
  if (!isObj(v)) return null;
  const id = culqiId(v.id, 'ref');
  const charge = culqiId(v.charge_id, 'chr');
  if (!id || !charge || id.livemode !== charge.livemode || !intIn(v.amount, 1, 100_000_000)) return null;
  return { id: v.id as string, chargeRef: v.charge_id as string, amountMinor: v.amount, livemode: id.livemode };
}

export function parsePlan(v: unknown): ProviderPlan | null {
  if (!isObj(v)) return null;
  const id = culqiId(v.id, 'pln');
  const cur = currency(v.currency);
  if (!id || !cur || !intIn(v.amount, 1, 100_000_000) || !intIn(v.interval_unit_time, 1, 6) || !intIn(v.interval_count, 0, 9999)) return null;
  // UNVERIFIED: 3 = month, 4 = year (interval_unit_time ∈ 1..6 is CONFIRMED); other units are not sold by Velsuno.
  const interval = v.interval_unit_time === 3 ? 'month' : v.interval_unit_time === 4 ? 'year' : 'other';
  const ic = isObj(v.initial_cycles) ? v.initial_cycles : null;
  if (ic && (!intIn(ic.count, 0, 9999) || typeof ic.has_initial_charge !== 'boolean' || !intIn(ic.amount, 0, 100_000_000))) return null;
  // UNVERIFIED: a free trial = initial cycles at amount 0 without an initial charge (unit 1 = day, assumed).
  const free = ic && (ic.count as number) > 0 && ic.amount === 0 && ic.has_initial_charge === false
    ? { count: ic.count as number, unit: intIn(ic.interval_unit_time, 1, 6) ? ic.interval_unit_time : 0 } : null;
  const chargesAtStart = !free;
  const initialCycles = ic ? (ic.count as number) : 0;
  return { id: v.id as string, amountMinor: v.amount, currency: cur, interval, intervalCount: v.interval_count, freeInitialCycles: free, chargesAtStart, initialCycles, livemode: id.livemode };
}

export function parseSubscription(v: unknown): ProviderSubscription | null {
  if (!isObj(v)) return null;
  const id = culqiId(v.id, 'sxn');
  if (!id) return null;
  const ref = (x: unknown, kind: CulqiKind) => (culqiId(x, kind)?.livemode === id.livemode ? (x as string) : null);
  const plan = isObj(v.plan) ? v.plan.plan_id : v.plan_id; // UNVERIFIED shape
  return {
    id: v.id as string,
    rawStatus: intIn(v.status, 0, 99) ? v.status : null,
    planRef: ref(plan, 'pln'),
    customerRef: ref(v.customer_id, 'cus'),
    cardRef: ref(v.active_card ?? v.card_id, 'crd'),
    trialEnd: culqiDate(v.trial_end),
    nextBillingDate: culqiDate(v.next_billing_date),
    orderId: metaOrder(v),
    livemode: id.livemode,
  };
}

export const parseCreated = (kind: 'cus' | 'crd') => (v: unknown): { id: string } | null =>
  isObj(v) && culqiId(v.id, kind) ? { id: v.id as string } : null;

/** DELETE answer: { id, deleted: true }. */
export const parseDeleted = (v: unknown): { deleted: true } | null => (isObj(v) && v.deleted === true ? { deleted: true } : null);

/** GET /customers?email= answer: { data: [...] } (UNVERIFIED). Only an exact, case-insensitive email match counts. */
export function parseCustomerList(v: unknown, email: string): { id: string } | null {
  if (!isObj(v) || !Array.isArray(v.data)) return null;
  const want = email.trim().toLowerCase();
  for (const c of v.data) if (isObj(c) && typeof c.email === 'string' && c.email.trim().toLowerCase() === want && culqiId(c.id, 'cus')) return { id: c.id as string };
  return null;
}

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Culqi error envelope { object:'error', type, code, decline_code, merchant_message, user_message } → our kind
 * and a short code. Provider messages are NEVER shown to the person (fixed Spanish copy instead) nor logged.
 */
export function classifyError(status: number, body: unknown, movesMoney: boolean): { kind: ProviderErrorKind; code: string } {
  const b = isObj(body) ? body : {};
  const clean = (x: unknown) => (typeof x === 'string' && /^[a-z0-9_]{1,60}$/.test(x) ? x : null);
  const code = clean(b.decline_code) ?? clean(b.code) ?? clean(b.type) ?? `http_${status}`;
  if (status === 401 || status === 403) return { kind: 'auth', code: 'provider_auth' };
  if (status === 404) return { kind: 'not_found', code: 'not_found' };
  if (status === 402 || b.type === 'card_error') return { kind: 'declined', code };
  if (status === 400 || status === 422 || b.type === 'invalid_request_error' || b.type === 'parameter_error') return { kind: 'invalid', code };
  // 429 is answered before any processing; 5xx on a call that moves money: the outcome is unknown.
  if (status === 429) return { kind: 'unavailable', code: 'rate_limited' };
  return { kind: movesMoney ? 'unknown' : 'unavailable', code };
}

/** UNVERIFIED: Culqi answers 200 with action_code 'REVIEW' when the issuer requires 3-D Secure. */
export const needsAuthentication = (body: unknown): boolean => isObj(body) && body.action_code === 'REVIEW';

/** Fixed Spanish copy for a declined card (es-PE). Never the provider's own text. */
export function declineMessage(code: string): string {
  if (/insufficient_funds/.test(code)) return 'Tu tarjeta no tiene saldo suficiente. No se hizo ningún cargo.';
  if (/expired/.test(code)) return 'Tu tarjeta está vencida. No se hizo ningún cargo.';
  if (/cvv|cvc/.test(code)) return 'El código de seguridad no coincide. Revísalo e inténtalo de nuevo. No se hizo ningún cargo.';
  if (/stolen|lost|fraud/.test(code)) return 'Tu banco no aceptó esta tarjeta. Usa otra. No se hizo ningún cargo.';
  if (/needs_3ds/.test(code)) return 'Tu banco pidió una verificación adicional que aún no podemos hacer. Prueba con otra tarjeta. No se hizo ningún cargo.';
  return 'Tu banco rechazó el pago. Prueba con otra tarjeta o llama a tu banco. No se hizo ningún cargo.';
}

// ── Request bodies (amounts always from the server's order, never from the browser) ────────────────────────────
/** CONFIRMED enum (culqi-php refund_validation.php): 'duplicado' | 'fraudulento' | 'solicitud_comprador'. */
export const REFUND_REASON = 'solicitud_comprador';

export function chargeBody(i: { amountMinor: number; currency: Currency; email: string; sourceRef: string; description: string; orderId: string }) {
  return {
    amount: i.amountMinor,
    currency_code: i.currency,
    email: i.email,
    source_id: i.sourceRef,
    description: i.description.slice(0, 80),
    capture: true,
    metadata: { order_id: i.orderId },
  };
}

// ── Webhooks ─────────────────────────────────────────────────────────────────────────────────────────────────────
export const WEBHOOK_MAX_BYTES = 64 * 1024;

export interface CulqiWebhookEvent {
  /** Idempotency key: the event id when it has one, else a digest of the whole delivery. */
  eventRef: string;
  type: string;
  objectRef: string | null;
  objectKind: CulqiKind | null;
  livemode: boolean | null;
}

/**
 * Parse a delivery (UNVERIFIED shape: {object:'event', type, data, id}; data may be a JSON string). Only the type
 * and the id of the object are read: the object itself is re-fetched with the secret key before acting.
 */
export function parseWebhook(rawBody: string): CulqiWebhookEvent | null {
  let json: unknown;
  try { json = JSON.parse(rawBody); } catch { return null; }
  if (!isObj(json) || typeof json.type !== 'string' || !/^[a-z_]{2,30}(\.[a-z_]{2,30}){1,4}$/.test(json.type) || json.type.length > 60) return null;
  let data: unknown = json.data;
  if (typeof data === 'string') {
    if (data.length > WEBHOOK_MAX_BYTES) return null;
    try { data = JSON.parse(data); } catch { return null; }
  }
  const obj = isObj(data) ? data : null;
  const id = obj ? culqiId(obj.id) : null;
  const eventRef = culqiId(json.id, 'evt') ? (json.id as string) : `sha256:${createHash('sha256').update(rawBody).digest('hex').slice(0, 48)}`;
  return { eventRef, type: json.type, objectRef: id ? (obj!.id as string) : null, objectKind: id?.kind ?? null, livemode: id?.livemode ?? null };
}

/** HTTP Basic credentials from CulqiPanel → Webhooks → "Activar autenticación", compared in constant time. */
export function basicAuthOk(header: string | null, user: string, password: string): boolean {
  const m = /^Basic ([A-Za-z0-9+/=]{4,512})$/.exec(header ?? '');
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  const okUser = timingSafeEqual(digest(decoded.slice(0, i)), digest(user));
  const okPass = timingSafeEqual(digest(decoded.slice(i + 1)), digest(password));
  return okUser && okPass;
}
