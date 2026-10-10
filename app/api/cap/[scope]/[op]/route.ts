import { databaseSpend } from '../../../../../lib/cap';
import { capSecret, isCapScope, newChallenge, redeem } from '../../../../../lib/cap-core';
import { createSupabaseServerClient } from '../../../../../lib/supabase/server';

/**
 * Cap widget endpoints: POST /api/cap/<login|signup|recovery>/challenge and /redeem (the widget appends the op to its
 * data-cap-api-endpoint). Unconfigured → 503 (the protected actions refuse too). Answers carry no reason details.
 */
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const MAX_BODY = 32 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ scope: string; op: string }> }) {
  const { scope, op } = await params;
  if (!isCapScope(scope) || (op !== 'challenge' && op !== 'redeem')) return json({ success: false }, 404);
  const secret = capSecret();
  if (!secret) {
    console.warn(JSON.stringify({ event: 'cap_unconfigured', scope }));
    return json({ success: false }, 503);
  }
  if (op === 'challenge') return json(await newChallenge(secret, scope));

  // Refuse an oversized body before reading it; the length is checked again after reading (header may be absent).
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json({ success: false }, 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ success: false }, 413);
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* invalid JSON → rejected below */ }
  const r = await redeem(secret, scope, body, databaseSpend(await createSupabaseServerClient()));
  if (!r.success) {
    console.warn(JSON.stringify({ event: 'cap_redeem_failed', scope, reason: r.reason }));
    return json({ success: false }, 400);
  }
  return json({ success: true, token: r.token, expires: r.expires });
}
