import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { sameOriginPost } from '../../../src/web/auth-input';

/**
 * "Cerrar sesión": this device only ("Cerrar otras sesiones" in Ajustes → Seguridad covers the rest). A plain form
 * POST outside /app on purpose: the proxy's registration gate refuses every POST under /app while the registration
 * status cannot be read (it fails closed), and signing out must work even then (shared device). Works without
 * JavaScript; GET is not handled (405), so a link or an image cannot sign anyone out, and a cross-site form is refused.
 */
export async function POST(request: NextRequest) {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!sameOriginPost(request.headers.get('origin'), request.headers.get('sec-fetch-site'), host)) {
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const supabase = await createSupabaseServerClient();
  // auth-js clears this device's session cookies even when the revoke call fails; the failure is only logged.
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) console.warn(JSON.stringify({ event: 'logout_failed', status: error.status ?? null, code: error.code ?? null }));
  const login = request.nextUrl.clone();
  login.pathname = '/login';
  login.search = '';
  // 303: the browser follows with a GET to /login.
  return NextResponse.redirect(login, 303);
}
