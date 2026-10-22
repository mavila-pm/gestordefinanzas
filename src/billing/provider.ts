/**
 * BillingProvider (spec §85, ADR-0018): the only shape the billing flows know. Culqi is the first implementation
 * (src/billing/culqi-client.ts); the domain never imports a provider. Every method returns a typed result, never
 * throws for a provider answer, and every returned object was validated against a fixed schema (provider responses
 * are untrusted input). Money in integer minor units.
 */
export type Currency = 'USD' | 'PEN';

/**
 * Why a call did not succeed. The distinction that matters for money:
 * - 'declined' / 'invalid' / 'auth' / 'not_found': a definitive answer — nothing was charged by THIS call.
 * - 'needs_authentication': the issuer asked for an extra check (3-D Secure) that this integration does not run.
 * - 'unknown': the request may have reached the provider (timeout, network cut, 5xx on a call that moves money):
 *   the outcome is unknown and the order must stay 'processing' until a re-fetch or webhook settles it.
 * - 'unavailable': a read failed transiently (safe to retry later).
 */
export type ProviderErrorKind = 'declined' | 'needs_authentication' | 'invalid' | 'auth' | 'not_found' | 'unknown' | 'unavailable';
export interface ProviderError { ok: false; kind: ProviderErrorKind; code: string; status: number | null }
export type ProviderResult<T> = { ok: true; value: T } | ProviderError;

export interface ProviderCharge {
  id: string;
  amountMinor: number;
  currency: Currency;
  /** Final, captured and successful (Culqi: outcome.type 'venta_exitosa'). */
  succeeded: boolean;
  /** Already refunded by the provider (Culqi amount_refunded, UNVERIFIED); 0 when absent. */
  refundedMinor: number;
  /** Our order id, read back from the provider's own copy of the metadata we sent. */
  orderId: string | null;
  /** Subscription that produced this charge, when the provider says so (UNVERIFIED for Culqi recurring charges). */
  subscriptionRef: string | null;
  /** Read from the object id (Culqi ids carry _test_ / _live_). */
  livemode: boolean;
}

export interface ProviderRefund { id: string; chargeRef: string; amountMinor: number; livemode: boolean }

export interface ProviderPlan {
  id: string;
  amountMinor: number;
  currency: Currency;
  /** Normalised billing interval; 'other' for anything we do not sell. */
  interval: 'month' | 'year' | 'other';
  intervalCount: number;
  /** Free initial period (the trial), as the plan defines it; null when the plan has none. */
  freeInitialCycles: { count: number; unit: number } | null;
  /** The plan charges something when the subscription is created (no free first period). */
  chargesAtStart: boolean;
  /** Number of initial cycles of any kind (free or at another price); 0 when the plan has none. */
  initialCycles: number;
  livemode: boolean;
}

export interface ProviderSubscription {
  id: string;
  /** Raw provider status code, kept for the ledger; flows never decide on it (meaning UNVERIFIED). */
  rawStatus: number | null;
  planRef: string | null;
  customerRef: string | null;
  cardRef: string | null;
  trialEnd: Date | null;
  nextBillingDate: Date | null;
  orderId: string | null;
  livemode: boolean;
}

export interface CustomerInput { firstName: string; lastName: string; email: string; address: string; addressCity: string; countryCode: 'PE'; phoneNumber: string }

export interface BillingProvider {
  readonly name: string;
  readonly livemode: boolean;
  charge(input: { amountMinor: number; currency: Currency; email: string; sourceRef: string; description: string; orderId: string }): Promise<ProviderResult<ProviderCharge>>;
  getCharge(id: string): Promise<ProviderResult<ProviderCharge>>;
  refund(input: { chargeRef: string; amountMinor: number }): Promise<ProviderResult<ProviderRefund>>;
  getRefund(id: string): Promise<ProviderResult<ProviderRefund>>;
  createCustomer(input: CustomerInput): Promise<ProviderResult<{ id: string }>>;
  findCustomerByEmail(email: string): Promise<ProviderResult<{ id: string } | null>>;
  createCard(input: { customerRef: string; tokenRef: string }): Promise<ProviderResult<{ id: string }>>;
  getPlan(id: string): Promise<ProviderResult<ProviderPlan>>;
  createSubscription(input: { cardRef: string; planRef: string; orderId: string }): Promise<ProviderResult<ProviderSubscription>>;
  getSubscription(id: string): Promise<ProviderResult<ProviderSubscription>>;
  cancelSubscription(id: string): Promise<ProviderResult<{ deleted: true }>>;
}
