import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * lib/supabase/proxy.ts (updateSession): session refresh with the shared cookie flags, the route guards and the
 * registration gate for writes, which fails closed. @supabase/ssr is stubbed: no network.
 */
const getClaims = vi.fn();
const rpc = vi.fn();
const created: Array<{ cookieOptions?: unknown }> = [];
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: { cookieOptions?: unknown }) => {
    created.push(options);
    return { auth: { getClaims }, rpc };
  },
}));

const req = (path: string, method = 'GET') => new NextRequest(`https://velsuno.example${path}`, { method });
const signedIn = () => getClaims.mockResolvedValue({ data: { claims: { sub: 'u1' } }, error: null });

describe('updateSession', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    getClaims.mockReset(); rpc.mockReset(); created.length = 0;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); vi.unstubAllEnvs(); });

  it('the refreshed session cookie gets the same httpOnly flags as the server client', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { updateSession } = await import('../lib/supabase/proxy');
    getClaims.mockResolvedValue({ data: null, error: null });
    await updateSession(req('/login'));
    expect(created[0]!.cookieOptions).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  });

  it('signed out: /app → /login?next=…, /crear-cuenta → /signup', async () => {
    const { updateSession } = await import('../lib/supabase/proxy');
    getClaims.mockResolvedValue({ data: null, error: null });
    expect((await updateSession(req('/app/movimientos'))).headers.get('location')).toBe('https://velsuno.example/login?next=%2Fapp%2Fmovimientos');
    expect((await updateSession(req('/crear-cuenta/perfil'))).headers.get('location')).toBe('https://velsuno.example/signup');
  });

  describe('registration gate for writes (POST under /app and /bienvenida)', () => {
    it('unfinished registration → 403', async () => {
      const { updateSession } = await import('../lib/supabase/proxy');
      signedIn();
      rpc.mockResolvedValue({ data: [{ required: true, password_done: false, completed: false }], error: null });
      const res = await updateSession(req('/app', 'POST'));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Completa tu registro para continuar.' });
    });

    it('finished → the write passes', async () => {
      const { updateSession } = await import('../lib/supabase/proxy');
      signedIn();
      rpc.mockResolvedValue({ data: [{ required: false, password_done: true, completed: true }], error: null });
      const res = await updateSession(req('/bienvenida', 'POST'));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-next')).toBe('1');
    });

    it('status unreadable (RPC error) → 503 "Intenta de nuevo en unos segundos.", logged with the code only', async () => {
      const { updateSession } = await import('../lib/supabase/proxy');
      signedIn();
      rpc.mockResolvedValue({ data: null, error: { code: 'PGRST301', message: 'JWT expired for user u1' } });
      const res = await updateSession(req('/app/movimientos', 'POST'));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Intenta de nuevo en unos segundos.' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({ event: 'registration_gate_failed', code: 'PGRST301' });
    });

    it('no row or a malformed row → 503 too (never a silent pass)', async () => {
      const { updateSession } = await import('../lib/supabase/proxy');
      signedIn();
      rpc.mockResolvedValueOnce({ data: [], error: null });
      expect((await updateSession(req('/app', 'POST'))).status).toBe(503);
      rpc.mockResolvedValueOnce({ data: [{ required: 'no' }], error: null });
      expect((await updateSession(req('/app', 'POST'))).status).toBe(503);
    });

    it('reads (GET) and other paths never call the gate', async () => {
      const { updateSession } = await import('../lib/supabase/proxy');
      signedIn();
      rpc.mockResolvedValue({ data: null, error: { code: 'x' } });
      expect((await updateSession(req('/app'))).status).toBe(200);
      expect((await updateSession(req('/api/csp-report', 'POST'))).status).toBe(200);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('"Cerrar sesión" (POST /auth/logout) is outside the gate: signing out works while the status is unreadable', async () => {
      const { updateSession } = await import('../lib/supabase/proxy');
      signedIn();
      rpc.mockResolvedValue({ data: null, error: { code: 'PGRST301' } });
      const res = await updateSession(req('/auth/logout', 'POST'));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-next')).toBe('1');
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});
