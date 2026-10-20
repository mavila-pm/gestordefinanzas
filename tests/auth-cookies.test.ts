import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookieOptions } from '../src/web/auth-input';

/**
 * Supabase session cookies: httpOnly (no browser Supabase client exists, page scripts never read sb-*-auth-token),
 * Secure in production, SameSite=Lax, path /. Both server clients (server components/actions and the proxy) use the
 * same options, and the real @supabase/ssr writes them on the cookies it sets. No network: fetch is stubbed.
 */

describe('authCookieOptions', () => {
  it('httpOnly, SameSite=Lax, path / always; Secure only when asked (production)', () => {
    expect(authCookieOptions(true)).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect(authCookieOptions(false)).toEqual({ httpOnly: true, secure: false, sameSite: 'lax', path: '/' });
  });
});

// ── The real @supabase/ssr client inside lib/supabase/server.ts, with Next.js cookies and fetch stubbed ──────────
const jar = new Map<string, { value: string; options: Record<string, unknown> }>();
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [...jar].map(([name, c]) => ({ name, value: c.value })),
    set: (name: string, value: string, options: Record<string, unknown>) => { jar.set(name, { value, options }); },
  }),
}));

const SESSION = {
  access_token: 'header.payload.signature', token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-token',
  user: { id: '00000000-0000-4000-8000-00000000000a', aud: 'authenticated', email: 'a@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' },
};
const tokenResponse = () => new Response(JSON.stringify(SESSION), { status: 200, headers: { 'content-type': 'application/json' } });
const authCookies = () => [...jar].filter(([name]) => /^sb-example-auth-token/.test(name));

describe('lib/supabase/server.ts: the session cookie the real client sets', () => {
  beforeEach(() => {
    jar.clear();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('after sign-in, every sb-*-auth-token cookie is httpOnly + Secure + SameSite=Lax on path / (production)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { createSupabaseServerClient } = await import('../lib/supabase/server');
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({ email: 'a@example.test', password: 'ahorro2026lima' });
    expect(error).toBeNull();
    expect(authCookies().length).toBeGreaterThan(0);
    for (const [, c] of authCookies()) expect(c.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  });

  it('outside production the cookie is still httpOnly (Secure off for plain-http dev servers)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { createSupabaseServerClient } = await import('../lib/supabase/server');
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signInWithPassword({ email: 'a@example.test', password: 'ahorro2026lima' });
    expect(authCookies().length).toBeGreaterThan(0);
    for (const [, c] of authCookies()) expect(c.options).toMatchObject({ httpOnly: true, secure: false });
  });
});
