import type { NextRequest } from 'next/server';
import { updateSession } from './lib/supabase/proxy';
import { HSTS, isHttps } from './src/web/security-headers';

export async function proxy(request: NextRequest) {
  const response = await updateSession(request);
  if (isHttps(request.headers.get('x-forwarded-proto'), request.nextUrl.protocol)) {
    response.headers.set('Strict-Transport-Security', HSTS);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
