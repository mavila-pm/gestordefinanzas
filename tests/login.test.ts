import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCKOUT_LINKS, LOGIN_INVALID, LOGIN_SERVER, LOGIN_UNCONFIRMED, lockedState, lockoutMessage, loginOutcome } from '../src/web/login';

describe('login messages', () => {
  it('wrong password and unknown email read the same; a closing failure announces the lock', () => {
    expect(loginOutcome({ status: 400, code: 'invalid_credentials' }, 0).message).toBe(LOGIN_INVALID);
    expect(loginOutcome({ status: 400, code: 'invalid_credentials' }, 0).locked).toBe(false);
    const closing = loginOutcome({ status: 400, code: 'invalid_credentials' }, 300);
    expect(closing.message).toBe('Demasiados intentos fallidos. Por seguridad, podrás intentarlo nuevamente en 5 minutos.');
    expect(closing.locked).toBe(true);
  });
  it('unconfirmed email is named (Supabase only says so after the password matched)', () => {
    expect(loginOutcome({ status: 400, code: 'email_not_confirmed' }, 0).message).toBe(LOGIN_UNCONFIRMED);
  });
  it('server or provider errors never show technical text', () => {
    const o = loginOutcome({ status: 500, code: 'unexpected_failure' }, 0);
    expect(o.message).toBe(LOGIN_SERVER);
    expect(o.diagnostic).toEqual({ event: 'login_failed', status: 500, code: 'unexpected_failure' });
    expect(loginOutcome({ status: 429, code: 'over_request_rate_limit' }, 0).message).toBe(LOGIN_SERVER);
  });
  it('lock minutes round up, singular for 1', () => {
    expect(lockoutMessage(899)).toContain('15 minutos');
    expect(lockoutMessage(30)).toContain('1 minuto.');
  });
  it('a lock always offers the ways in that do not need the password: email link and recovery', () => {
    expect(lockedState(300)).toEqual({ error: lockoutMessage(300), locked: true });
    expect(LOCKOUT_LINKS).toEqual([
      { href: '/signup?modo=enlace', label: 'Recibir un enlace para entrar' },
      { href: '/forgot-password', label: '¿Olvidaste tu contraseña?' },
    ]);
  });
});

// ── The real login action, with Cap, Next.js and Supabase stubbed ────────────────────────────────────────────
const rpc = vi.fn();
const signInWithPassword = vi.fn();
vi.mock('server-only', () => ({}));
vi.mock('../lib/cap', () => ({ capPassed: async () => true }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), getAll: () => [] }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ rpc, auth: { signInWithPassword } }),
  authUser: async () => null,
}));

const form = (email: string, password = 'una clave 2026 cualquiera') => { const f = new FormData(); f.set('email', email); f.set('password', password); return f; };

describe('login action: the lock reads the same for every email and offers the ways in', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { rpc.mockReset(); signInWithPassword.mockReset(); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  it('locked registered email === locked unknown email, byte for byte; the password is never checked', async () => {
    const { login } = await import('../app/auth/actions');
    rpc.mockResolvedValue({ data: [{ allowed: false, wait_seconds: 840 }], error: null });
    const registered = await login({}, form('registrada@example.test'));
    const unknown = await login({}, form('nadie@example.test'));
    expect(registered).toEqual({ error: lockoutMessage(840), locked: true });
    expect(JSON.stringify(registered)).toBe(JSON.stringify(unknown));
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('the failed attempt that closes a group says so at once, with the ways in', async () => {
    const { login } = await import('../app/auth/actions');
    rpc.mockResolvedValue({ data: [{ allowed: true, wait_seconds: 300 }], error: null });
    signInWithPassword.mockResolvedValue({ error: { status: 400, code: 'invalid_credentials' } });
    expect(await login({}, form('ana@example.test'))).toEqual({ error: lockoutMessage(300), locked: true });
  });

  it('an ordinary wrong password is not a lock (no ways-in block)', async () => {
    const { login } = await import('../app/auth/actions');
    rpc.mockResolvedValue({ data: [{ allowed: true, wait_seconds: 0 }], error: null });
    signInWithPassword.mockResolvedValue({ error: { status: 400, code: 'invalid_credentials' } });
    expect(await login({}, form('ana@example.test'))).toEqual({ error: LOGIN_INVALID });
  });
});
