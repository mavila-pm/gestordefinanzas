import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabasePublicEnv } from '../env';

/** Refreshes the auth session cookie on every request and guards /app/*, the onboarding (/bienvenida) and /crear-cuenta/*. */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { url, key } = supabasePublicEnv();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  // getClaims() refreshes an expired session and verifies the JWT signature (ES256, cached JWKS) locally:
  // no round trip to Supabase Auth on every request (getSession() alone would trust the cookie).
  const { data: claims } = await supabase.auth.getClaims();
  const user = claims?.claims?.sub ? claims.claims : null;

  // Registration steps need the session the email link created; without it, start again from the email.
  if (!user && request.nextUrl.pathname.startsWith('/crear-cuenta')) {
    const signup = request.nextUrl.clone();
    signup.pathname = '/signup';
    signup.search = '';
    return NextResponse.redirect(signup);
  }
  if (!user && (request.nextUrl.pathname.startsWith('/app') || request.nextUrl.pathname.startsWith('/bienvenida'))) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
    return NextResponse.redirect(login);
  }
  // Writes (server actions, Vels included) from a new account that has not finished registration (18+, consents) are refused
  // here, not only by the page redirect: the steps are decided in SQL (my_registration, migration 029).
  const path = request.nextUrl.pathname;
  if (user && request.method === 'POST' && (path.startsWith('/app') || path.startsWith('/bienvenida'))) {
    const { data } = await supabase.rpc('my_registration');
    const row = (Array.isArray(data) ? data[0] : data) as { required?: boolean } | null;
    if (row?.required) return NextResponse.json({ error: 'Completa tu registro para continuar.' }, { status: 403 });
  }
  return response;
}
