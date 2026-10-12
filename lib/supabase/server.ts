import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabasePublicEnv } from '../env';

/** Per-request client acting as the signed-in user: every query is subject to RLS. */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { url, key } = supabasePublicEnv();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies are refreshed by proxy.ts instead.
        }
      },
    },
  });
}

/**
 * The signed-in user, verified locally: the project signs sessions with an asymmetric key (ES256), so getClaims()
 * checks the JWT signature and expiry against the cached JWKS without a round trip to Supabase Auth (getUser() made
 * one per call; the proxy, layout and every action each paid it). Password flows keep getUser() on purpose.
 */
export async function authUser(supabase: SupabaseClient): Promise<{ id: string; email: string | null } | null> {
  const { data, error } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  if (error || typeof sub !== 'string' || !sub) return null;
  return { id: sub, email: typeof data.claims.email === 'string' ? data.claims.email : null };
}
