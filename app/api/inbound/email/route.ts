import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { getServerPool } from '../../../../lib/server-db';
import { genericHmacProvider, handleInboundEmail, MAX_WEBHOOK_BYTES } from '../../../../src/infrastructure/inbound/email-webhook';

/**
 * Inbound email webhook. Disabled (503) until the server secrets exist: INBOUND_EMAIL_SECRET and DATABASE_URL
 * (server-only env vars, never NEXT_PUBLIC_). Provider choice pending: see docs/architecture/email-bridge.md.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INBOUND_EMAIL_SECRET;
  const pool = getServerPool();
  if (!secret || secret.length < 32 || !pool) return NextResponse.json({ status: 'not_configured' }, { status: 503 });
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_WEBHOOK_BYTES) return NextResponse.json({ status: 'too_large' }, { status: 413 });
  const rawBody = await request.text();
  try {
    const r = await handleInboundEmail({ headers: request.headers, rawBody }, { pool, provider: genericHmacProvider(secret) });
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    console.warn(JSON.stringify({ event: 'inbound_email_failed', message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' }));
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}
