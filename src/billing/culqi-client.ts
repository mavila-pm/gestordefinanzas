import {
  chargeBody, classifyError, CULQI_API, isCulqiId, needsAuthentication, parseCharge, parseCreated, parseCustomerList, parseDeleted,
  parsePlan, parseRefund, parseSubscription, PATHS, REFUND_REASON,
} from './culqi';
import type { BillingProvider, CustomerInput, ProviderError, ProviderResult } from './provider';

/** The slice of fetch this client uses (injectable: tests never call the real API). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) =>
  Promise<{ status: number; text(): Promise<string> }>;
export type BillingLog = (event: Record<string, string | number | boolean | null>) => void;

const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Culqi HTTP client (ADR-0019). Server only by construction: it needs the SECRET key, which only lib/culqi.ts reads
 * from the environment. 10 s timeout, NO automatic retry (a retried POST /charges could charge twice), responses
 * capped and validated, ids checked by pattern and mode before they reach a URL. Logs carry the operation, HTTP
 * status and a short code: never the key, the email, the token, names, addresses or provider messages.
 */
export class CulqiClient implements BillingProvider {
  readonly name = 'culqi';
  readonly livemode: boolean;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly log: BillingLog;

  constructor(private readonly secretKey: string, opts: { fetch?: FetchLike; timeoutMs?: number; log?: BillingLog } = {}) {
    const m = /^sk_(test|live)_[A-Za-z0-9]{8,128}$/.exec(secretKey);
    if (!m) throw new Error('culqi_bad_secret_key');
    this.livemode = m[1] === 'live';
    this.fetcher = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.log = opts.log ?? ((e) => console.warn(JSON.stringify(e)));
  }

  private bad(code: string): ProviderError { return { ok: false, kind: 'invalid', code, status: null }; }

  private async call<T>(op: string, method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, parse: (v: unknown) => T | null, movesMoney = false): Promise<ProviderResult<T>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await this.fetcher(`${CULQI_API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      status = res.status;
      text = await res.text();
    } catch {
      // Network cut or timeout: for a call that moves money the request may have been processed.
      this.log({ event: 'culqi_call', op, status: null, code: 'network' });
      return { ok: false, kind: movesMoney ? 'unknown' : 'unavailable', code: 'network', status: null };
    } finally { clearTimeout(timer); }
    let json: unknown = null;
    if (text.length > MAX_RESPONSE_BYTES) json = null;
    else { try { json = text ? JSON.parse(text) : null; } catch { json = null; } }
    if (status >= 200 && status < 300) {
      if (needsAuthentication(json)) {
        this.log({ event: 'culqi_call', op, status, code: 'needs_3ds' });
        return { ok: false, kind: 'needs_authentication', code: 'needs_3ds', status };
      }
      const value = parse(json);
      if (value === null) {
        // A 2xx we cannot read: for a money call the charge may exist → unknown, never "failed".
        this.log({ event: 'culqi_call', op, status, code: 'unreadable_response' });
        return { ok: false, kind: movesMoney ? 'unknown' : 'unavailable', code: 'unreadable_response', status };
      }
      const mode = (value as { livemode?: unknown }).livemode;
      if (typeof mode === 'boolean' && mode !== this.livemode) {
        this.log({ event: 'culqi_call', op, status, code: 'mode_mismatch' });
        return { ok: false, kind: movesMoney ? 'unknown' : 'invalid', code: 'mode_mismatch', status };
      }
      this.log({ event: 'culqi_call', op, status, code: 'ok' });
      return { ok: true, value };
    }
    const e = classifyError(status, json, movesMoney);
    this.log({ event: 'culqi_call', op, status, code: e.code });
    return { ok: false, kind: e.kind, code: e.code, status };
  }

  charge(i: Parameters<BillingProvider['charge']>[0]) {
    if (!isCulqiId(i.sourceRef, 'tkn', this.livemode) && !isCulqiId(i.sourceRef, 'crd', this.livemode)) return Promise.resolve(this.bad('bad_source'));
    if (!Number.isSafeInteger(i.amountMinor) || i.amountMinor < 1) return Promise.resolve(this.bad('bad_amount'));
    return this.call('charge.create', 'POST', PATHS.charges, chargeBody(i), parseCharge, true);
  }
  getCharge(id: string) {
    if (!isCulqiId(id, 'chr', this.livemode)) return Promise.resolve(this.bad('bad_id'));
    return this.call('charge.get', 'GET', PATHS.charge(id), undefined, parseCharge);
  }
  refund(i: { chargeRef: string; amountMinor: number }) {
    if (!isCulqiId(i.chargeRef, 'chr', this.livemode) || !Number.isSafeInteger(i.amountMinor) || i.amountMinor < 1) return Promise.resolve(this.bad('bad_refund'));
    return this.call('refund.create', 'POST', PATHS.refunds, { amount: i.amountMinor, charge_id: i.chargeRef, reason: REFUND_REASON }, parseRefund, true);
  }
  getRefund(id: string) {
    if (!isCulqiId(id, 'ref', this.livemode)) return Promise.resolve(this.bad('bad_id'));
    return this.call('refund.get', 'GET', PATHS.refund(id), undefined, parseRefund);
  }
  createCustomer(i: CustomerInput) {
    return this.call('customer.create', 'POST', PATHS.customers, {
      first_name: i.firstName, last_name: i.lastName, email: i.email, address: i.address, address_city: i.addressCity,
      country_code: i.countryCode, phone_number: i.phoneNumber,
    }, (v) => { const c = parseCreated('cus')(v); return c && isCulqiId(c.id, 'cus', this.livemode) ? c : null; });
  }
  findCustomerByEmail(email: string) {
    return this.call('customer.find', 'GET', PATHS.customersByEmail(email), undefined, (v) => {
      const found = parseCustomerList(v, email);
      return found && isCulqiId(found.id, 'cus', this.livemode) ? { found } : (v && typeof v === 'object' ? { found: null } : null);
    }).then((r) => (r.ok ? { ok: true as const, value: r.value.found } : r));
  }
  createCard(i: { customerRef: string; tokenRef: string }) {
    if (!isCulqiId(i.customerRef, 'cus', this.livemode) || !isCulqiId(i.tokenRef, 'tkn', this.livemode)) return Promise.resolve(this.bad('bad_card_input'));
    // UNVERIFIED: validate:true asks Culqi to verify the card when saving it.
    return this.call('card.create', 'POST', PATHS.cards, { customer_id: i.customerRef, token_id: i.tokenRef, validate: true },
      (v) => { const c = parseCreated('crd')(v); return c && isCulqiId(c.id, 'crd', this.livemode) ? c : null; });
  }
  getPlan(id: string) {
    if (!isCulqiId(id, 'pln', this.livemode)) return Promise.resolve(this.bad('bad_id'));
    return this.call('plan.get', 'GET', PATHS.plan(id), undefined, parsePlan);
  }
  createSubscription(i: { cardRef: string; planRef: string; orderId: string }) {
    if (!isCulqiId(i.cardRef, 'crd', this.livemode) || !isCulqiId(i.planRef, 'pln', this.livemode)) return Promise.resolve(this.bad('bad_subscription_input'));
    return this.call('subscription.create', 'POST', PATHS.subscriptionCreate,
      { card_id: i.cardRef, plan_id: i.planRef, tyc: true, metadata: { order_id: i.orderId } }, parseSubscription, true);
  }
  getSubscription(id: string) {
    if (!isCulqiId(id, 'sxn', this.livemode)) return Promise.resolve(this.bad('bad_id'));
    return this.call('subscription.get', 'GET', PATHS.subscription(id), undefined, parseSubscription);
  }
  cancelSubscription(id: string) {
    if (!isCulqiId(id, 'sxn', this.livemode)) return Promise.resolve(this.bad('bad_id'));
    return this.call('subscription.cancel', 'DELETE', PATHS.subscription(id), undefined, parseDeleted);
  }
}
