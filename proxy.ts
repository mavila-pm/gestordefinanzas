import type { NextRequest } from 'next/server';
import { updateSession } from './lib/supabase/proxy';
import { buildCsp, CSP_HEADER, cspNonce, HSTS, isHttps, REPORTING_ENDPOINTS } from './src/web/security-headers';

export async function proxy(request: NextRequest) {
  // A fresh nonce per request. Next.js reads it from the request's CSP header to tag its own inline scripts, and
  // app/layout.tsx reads x-nonce for the theme script. Whatever the client sent under these names is replaced.
  const nonce = cspNonce();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== 'production' });
  request.headers.delete('content-security-policy');
  request.headers.set('x-nonce', nonce);
  request.headers.set(CSP_HEADER.toLowerCase(), csp);

  const response = await updateSession(request);
  response.headers.set(CSP_HEADER, csp);
  response.headers.set('Reporting-Endpoints', REPORTING_ENDPOINTS);
  if (isHttps(request.headers.get('x-forwarded-proto'), request.nextUrl.protocol)) {
    response.headers.set('Strict-Transport-Security', HSTS);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
