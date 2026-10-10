import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { AUTH_NEXT_COOKIE, resolveAuthNext } from '../../../src/web/auth-input';

const TYPES: readonly EmailOtpType[] = ['signup', 'recovery', 'email', 'invite', 'email_change', 'magiclink'];

/**
 * Email links (signup confirmation, password recovery). Supports both:
 *  - token_hash + type (recommended SSR email templates; works across devices)
 *  - code (default PKCE redirect; only works in the browser that started the flow)
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const cookieStore = await cookies();
  const next = resolveAuthNext(params.get('next'), cookieStore.get(AUTH_NEXT_COOKIE)?.value, params.get('type'));
  const supabase = await createSupabaseServerClient();

  const tokenHash = params.get('token_hash');
  const type = params.get('type') as EmailOtpType | null;
  const code = params.get('code');

  let ok = false;
  if (tokenHash && type && TYPES.includes(type)) {
    ok = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  } else if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  }

  // One-shot: the remembered destination is consumed by the first successful link.
  if (ok) cookieStore.delete({ name: AUTH_NEXT_COOKIE, path: '/auth' });
  const target = request.nextUrl.clone();
  target.search = '';
  target.pathname = ok ? next.split('?')[0]! : '/login';
  if (!ok) target.searchParams.set('error', 'link');
  return NextResponse.redirect(target);
}
