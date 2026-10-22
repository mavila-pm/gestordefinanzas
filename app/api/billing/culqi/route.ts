import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { culqiWebhookDeps } from '../../../../lib/culqi';
import { WEBHOOK_MAX_BYTES } from '../../../../src/billing/culqi';
import { handleCulqiWebhook } from '../../../../src/infrastructure/billing/culqi-webhook';

/**
 * Culqi webhook (ADR-0019; owner setup in docs/runbooks/billing-culqi.md). Disabled (503) until the server secrets
 * exist: CULQI_PUBLIC_KEY + CULQI_SECRET_KEY (test keys outside Production, live keys only in Production),
 * CULQI_WEBHOOK_USER + CULQI_WEBHOOK_PASSWORD (HTTP Basic set in CulqiPanel, password ≥ 24 characters) and
 * DATABASE_URL. Culqi does not sign webhooks: the body is never trusted — the handler re-fetches the object from
 * Culqi with the secret key and acts only on that. Works even with CULQI_ENABLED=false (renewals and refunds of
 * existing subscribers keep flowing while new sales are off).
 */
export async function POST(request: NextRequest) {
  const deps = culqiWebhookDeps();
  if (!deps) return NextResponse.json({ status: 'not_configured' }, { status: 503 });
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > WEBHOOK_MAX_BYTES) return NextResponse.json({ status: 'too_large' }, { status: 413 });
  const rawBody = await request.text();
  try {
    const r = await handleCulqiWebhook({ headers: request.headers, rawBody }, deps);
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    // Transient (database or Culqi): the receipt stays open and Culqi's retry processes it. No details in the answer.
    deps.log({ event: 'culqi_webhook_failed', code: e instanceof Error ? e.name.slice(0, 60) : 'unknown' });
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}
