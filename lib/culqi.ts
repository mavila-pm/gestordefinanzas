import 'server-only';
import { culqiKeys, culqiSales, culqiWebhook, type BillingDisabledReason, type CulqiKeys, type PlanKey } from '../src/billing/config';
import { CulqiClient } from '../src/billing/culqi-client';
import type { BillingProvider } from '../src/billing/provider';
import type { BillingStore } from '../src/billing/store';
import { PgBillingStore } from '../src/infrastructure/billing/pg-billing-store';
import { TERMS_COVER_BILLING } from '../src/web/legal';
import { getServerPool } from './server-db';

/**
 * Server-only wiring of Culqi (ADR-0018). The SECRET key is read here from the environment and handed to the
 * client; it never reaches a client component, a log line or a response. Writes go through the privileged pool
 * (DATABASE_URL) and only the service-only SQL billing functions.
 */
const logged = new Set<string>();
export const billingLog = (e: Record<string, string | number | boolean | null>) => console.warn(JSON.stringify(e));

/** Disabled billing is said once per process with its reason (never silently "on" by default). */
export function logDisabled(scope: 'checkout' | 'webhook' | 'service', reason: BillingDisabledReason): void {
  const key = `${scope}:${reason}`;
  if (logged.has(key)) return;
  logged.add(key);
  billingLog({ event: 'billing_disabled', scope, reason });
}

export type CulqiDeps = { ok: true; keys: CulqiKeys; plans: Partial<Record<PlanKey, string>>; provider: BillingProvider; store: BillingStore };

/** Everything a checkout needs, or why payments are off. */
export function culqiCheckout(env: Record<string, string | undefined> = process.env): CulqiDeps | { ok: false; reason: BillingDisabledReason } {
  const sales = culqiSales(env, TERMS_COVER_BILLING);
  if (!sales.ok) { logDisabled('checkout', sales.reason); return sales; }
  const pool = getServerPool();
  if (!pool) { logDisabled('checkout', 'missing_database_url'); return { ok: false, reason: 'missing_database_url' }; }
  for (const issue of sales.issues) if (!logged.has(issue)) { logged.add(issue); billingLog({ event: 'billing_plan_config', issue }); }
  return { ok: true, keys: sales.keys, plans: sales.plans, provider: new CulqiClient(sales.keys.secretKey, { log: billingLog }), store: new PgBillingStore(pool) };
}

/** The webhook's dependencies (works with new sales switched off: renewals and refunds keep flowing). */
export function culqiWebhookDeps(env: Record<string, string | undefined> = process.env) {
  const w = culqiWebhook(env);
  const pool = getServerPool();
  if (!w.ok || !pool) { logDisabled('webhook', w.ok ? 'missing_database_url' : w.reason); return null; }
  return { auth: { user: w.user, password: w.password }, provider: new CulqiClient(w.keys.secretKey, { log: billingLog }), store: new PgBillingStore(pool), log: billingLog };
}

/**
 * Calls made for an EXISTING subscriber ("Cancelar renovación"): valid keys and the database are enough. They work
 * with new sales switched off (CULQI_ENABLED=false) so nobody is ever stuck with a renewal they cannot stop.
 */
export function culqiServiceDeps(env: Record<string, string | undefined> = process.env) {
  const k = culqiKeys(env);
  const pool = getServerPool();
  if (!k.ok || !pool) { logDisabled('service', k.ok ? 'missing_database_url' : k.reason); return null; }
  return { provider: new CulqiClient(k.keys.secretKey, { log: billingLog }) as BillingProvider, store: new PgBillingStore(pool) as BillingStore, log: billingLog };
}
