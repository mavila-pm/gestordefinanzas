import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { ingestRawEvent } from '../../engine/ingest';
import { buildUserContext } from '../../engine/user-context';
import { emailBridgeSource, type InboundEmailPayload } from '../../ingestion/sources/email-bridge-source';
import { PgTransactionRepository } from '../postgres/pg-transaction-repository';

/**
 * Email Bridge webhook (spec §6, §35). Provider-agnostic: an InboundEmailProvider authenticates the request and maps
 * its body to an envelope. Only `generic_hmac` exists today (used by our simulator/tests); real providers (Postmark,
 * Mailgun, SendGrid, Cloudflare) are pending the PO's choice and are NOT VERIFIED.
 *
 * Security properties (all enforced before any parsing of the email itself):
 * - signature over `timestamp.body` with a server secret, constant-time comparison, ±5 min tolerance;
 * - replay protection: (provider, delivery id) unique in inbound_deliveries; Level-1 dedupe by Message-ID too;
 * - size limits; strict schema; unknown/revoked addresses get the same 202 as valid ones (no enumeration);
 * - per-address rate limit; the email body is untrusted input and is never stored.
 */
export const MAX_WEBHOOK_BYTES = 256 * 1024;
export const SIGNATURE_TOLERANCE_S = 300;
export const MAX_DELIVERIES_PER_HOUR = 120;

export interface InboundEnvelope {
  deliveryId: string;
  /** Local part of the recipient address (our private per-user address). */
  toLocal: string;
  email: InboundEmailPayload;
}

export interface InboundEmailProvider {
  readonly name: string;
  verify(headers: Headers, rawBody: string, now: Date): { ok: true } | { ok: false; reason: string };
  parse(json: unknown): InboundEnvelope | null;
}

export function hmacSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function genericHmacProvider(secret: string): InboundEmailProvider {
  return {
    name: 'generic_hmac',
    verify(headers, rawBody, now) {
      const ts = headers.get('x-gf-timestamp') ?? '';
      const sig = headers.get('x-gf-signature') ?? '';
      if (!/^\d{9,11}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'missing_signature' };
      if (Math.abs(now.getTime() / 1000 - Number(ts)) > SIGNATURE_TOLERANCE_S) return { ok: false, reason: 'stale_timestamp' };
      const expected = Buffer.from(hmacSignature(secret, ts, rawBody), 'hex');
      const given = Buffer.from(sig, 'hex');
      return expected.length === given.length && timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'bad_signature' };
    },
    parse(json) {
      if (!json || typeof json !== 'object') return null;
      const j = json as Record<string, unknown>;
      const deliveryId = typeof j.deliveryId === 'string' && /^[\w.:@<>+-]{1,200}$/.test(j.deliveryId) ? j.deliveryId : null;
      const to = typeof j.to === 'string' ? /^([a-z0-9_]{1,64})@[a-z0-9.-]{1,190}$/i.exec(j.to.trim())?.[1]?.toLowerCase() : undefined;
      if (!deliveryId || !to) return null;
      return { deliveryId, toLocal: to, email: { messageId: j.messageId, from: j.from, subject: j.subject, text: j.text, html: j.html, receivedAt: j.receivedAt } };
    },
  };
}

export interface WebhookResult { status: number; body: { status: string } }

const accepted: WebhookResult = { status: 202, body: { status: 'accepted' } };

export async function handleInboundEmail(
  req: { headers: Headers; rawBody: string },
  deps: { pool: Pool; provider: InboundEmailProvider; now?: Date },
): Promise<WebhookResult> {
  const now = deps.now ?? new Date();
  if (Buffer.byteLength(req.rawBody, 'utf8') > MAX_WEBHOOK_BYTES) return { status: 413, body: { status: 'too_large' } };
  const auth = deps.provider.verify(req.headers, req.rawBody, now);
  if (!auth.ok) return { status: 401, body: { status: 'unauthorized' } };

  let json: unknown;
  try { json = JSON.parse(req.rawBody); } catch { return { status: 400, body: { status: 'invalid_payload' } }; }
  const env = deps.provider.parse(json);
  if (!env) return { status: 400, body: { status: 'invalid_payload' } };

  // Replay protection: the same delivery is processed once, whatever the provider retries.
  const ins = await deps.pool.query(
    `insert into public.inbound_deliveries (provider, delivery_id, outcome) values ($1, $2, 'received')
     on conflict (provider, delivery_id) do nothing returning id`, [deps.provider.name, env.deliveryId]);
  if (ins.rowCount === 0) return { status: 200, body: { status: 'duplicate' } };
  const deliveryRow = ins.rows[0].id as string;
  const finish = async (outcome: string, userId: string | null) => {
    await deps.pool.query('update public.inbound_deliveries set outcome = $2, user_id = $3 where id = $1', [deliveryRow, outcome, userId]);
    return accepted;
  };

  const conn = await deps.pool.query(`select user_id from public.email_connections where address_local = $1 and status = 'active'`, [env.toLocal]);
  const userId = conn.rows[0]?.user_id as string | undefined;
  // Same answer as a valid address: the webhook never reveals which addresses exist.
  if (!userId) return finish('unknown_address', null);

  const recent = await deps.pool.query(
    `select count(*)::int as n from public.inbound_deliveries where user_id = $1 and received_at > $2::timestamptz - interval '1 hour'`, [userId, now.toISOString()]);
  if ((recent.rows[0].n as number) >= MAX_DELIVERIES_PER_HOUR) return finish('rate_limited', userId);

  const raw = emailBridgeSource.toRawEvent(env.email);
  if (!raw.ok) return finish('invalid_payload', userId);

  const [cards, accounts, rules] = await Promise.all([
    deps.pool.query('select last4, kind, active from public.cards where user_id = $1', [userId]),
    deps.pool.query('select last4, active from public.accounts where user_id = $1', [userId]),
    deps.pool.query(`select r.contains, c.name as category_name from public.merchant_rules r
      left join public.categories c on c.id = r.category_id where r.user_id = $1`, [userId]),
  ]);
  const ctx = buildUserContext(userId, { cards: cards.rows, accounts: accounts.rows, rules: rules.rows });
  // Privileged connection: every repository query filters by this user_id explicitly (PgTransactionRepository).
  await ingestRawEvent(raw.event, ctx, new PgTransactionRepository(deps.pool));
  return finish('processed', userId);
}
