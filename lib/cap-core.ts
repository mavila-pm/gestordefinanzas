import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateChallenge, validateChallenge } from 'capjs-core';

/**
 * Cap (trycap.dev) anti-bot for the public auth forms: a proof-of-work challenge solved in the browser, verified here.
 * Two single-use steps, both spent in the database (migration 040) so nothing can be replayed:
 *   1. /api/cap/<scope>/challenge → signed challenge (5 min). /api/cap/<scope>/redeem → checks the solution with
 *      capjs-core and spends the challenge signature ("c:…"), then returns a redeem token signed here (10 min).
 *   2. The server action verifies that token (signature, scope, expiry) and spends its id ("r:…") before doing anything.
 * The secret lives only in the server env (CAP_SECRET, never NEXT_PUBLIC_). Missing or short secret → fail closed.
 * Nothing here logs or returns tokens, solutions or the secret.
 */

export { CAP_ERROR, CAP_FIELD, CAP_SCOPES, isCapScope, type CapScope } from '../src/web/cap';
import type { CapScope } from '../src/web/cap';

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const REDEEM_TTL_MS = 10 * 60_000;
export interface ChallengeParams { challengeCount: number; challengeSize: number; challengeDifficulty: number }
/** capjs-core defaults: ~1 s on a mid-range phone, solved while the person types. */
export const DEFAULT_PARAMS: ChallengeParams = { challengeCount: 50, challengeSize: 32, challengeDifficulty: 4 };

/** Server-only secret; null when absent or too short (callers must then refuse, never skip). */
export function capSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.CAP_SECRET;
  return s && s.length >= 32 ? s : null;
}

/** Spends a key once while it is valid: true = first use, false = already used. May throw (store down). */
export type Spend = (key: string, ttlSeconds: number) => Promise<boolean>;
/** The database accepts 1..600 s (migration 041): the redeem token, the longest-lived key, lasts 10 min. */
const ttlSeconds = (ms: number) => Math.min(600, Math.max(1, Math.ceil(ms / 1000)));

export async function newChallenge(secret: string, scope: CapScope, params: ChallengeParams = DEFAULT_PARAMS) {
  const r = await generateChallenge(secret, { ...params, scope, expiresMs: CHALLENGE_TTL_MS });
  if (!('challenge' in r)) throw new Error('unexpected challenge format');
  return { challenge: r.challenge, token: r.token, expires: r.expires };
}

// ── Redeem token: v1.<scope>.<id>.<exp>.<mac>, HMAC-SHA256 with a key derived from CAP_SECRET ─────────────────────
const TOKEN = /^v1\.(login|signup|recovery)\.([A-Za-z0-9_-]{22})\.(\d{13})\.([A-Za-z0-9_-]{43})$/;
const redeemKey = (secret: string) => createHmac('sha256', secret).update('velsuno:cap:redeem:v1').digest();
const mac = (secret: string, body: string) => createHmac('sha256', redeemKey(secret)).update(body).digest('base64url');

export function signRedeemToken(secret: string, scope: CapScope, expires: number, id = randomBytes(16).toString('base64url')): string {
  const body = `v1.${scope}.${id}.${expires}`;
  return `${body}.${mac(secret, body)}`;
}

export type RedeemResult = { success: true; token: string; expires: number } | { success: false; reason: string };

/** Widget POST body → capjs-core check (PoW, signature, scope, expiry, single use) → our redeem token. */
export async function redeem(secret: string, scope: CapScope, body: unknown, spend: Spend): Promise<RedeemResult> {
  if (!body || typeof body !== 'object') return { success: false, reason: 'invalid_body' };
  const { token, solutions } = body as { token?: unknown; solutions?: unknown };
  if (typeof token !== 'string' || token.length > 4096) return { success: false, reason: 'missing_token' };
  if (!Array.isArray(solutions) || solutions.length > 1000 || !solutions.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return { success: false, reason: 'invalid_solutions' };
  }
  const r = await validateChallenge(secret, { token, solutions: solutions as number[] }, {
    scope,
    tokenTtlMs: REDEEM_TTL_MS,
    consumeNonce: (sig, ttlMs) => spend(`c:${sig}`, ttlSeconds(ttlMs)),
    signToken: ({ expires }) => signRedeemToken(secret, scope, expires),
  });
  return r.success ? { success: true, token: r.token, expires: r.expires } : { success: false, reason: r.reason };
}

export type CapCheck = { ok: true } | { ok: false; reason: 'unconfigured' | 'missing' | 'malformed' | 'bad_signature' | 'scope' | 'expired' | 'replayed' | 'store_error' };

/** Inside the protected action, before anything else. Every failure is a refusal (fail closed). */
export async function verifyCapToken(secret: string | null, scope: CapScope, raw: unknown, spend: Spend, now = Date.now()): Promise<CapCheck> {
  if (!secret) return { ok: false, reason: 'unconfigured' };
  if (typeof raw !== 'string' || !raw) return { ok: false, reason: 'missing' };
  const m = raw.length <= 200 ? TOKEN.exec(raw) : null;
  if (!m) return { ok: false, reason: 'malformed' };
  const [, tokenScope, id, exp, sig] = m as unknown as [string, CapScope, string, string, string];
  const expected = Buffer.from(mac(secret, `v1.${tokenScope}.${id}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
  if (tokenScope !== scope) return { ok: false, reason: 'scope' };
  const expires = Number(exp);
  if (expires <= now) return { ok: false, reason: 'expired' };
  try {
    return (await spend(`r:${id}`, ttlSeconds(expires - now))) ? { ok: true } : { ok: false, reason: 'replayed' };
  } catch {
    return { ok: false, reason: 'store_error' };
  }
}
