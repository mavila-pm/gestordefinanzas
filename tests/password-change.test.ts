import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { passwordProblem } from '../src/web/auth-input';
import { CODE_SENT, PASSWORD_CHANGED, parseReauthCode, passwordChangeOutcome, reauthRequestOutcome, revealState, submitGate } from '../src/web/password-change';

/**
 * Ajustes → Cambiar contraseña. The client form and the server action share passwordProblem; the action talks only to
 * Supabase Auth (getUser → updateUser, reauthenticate when Supabase asks). No network: the Supabase client is a stub.
 */

describe('password rules (client and server use the same check)', () => {
  it('valid: 12+ with letters and numbers', () => {
    expect(passwordProblem('ahorro2026lima')).toBeNull();
    expect(passwordProblem('Contraseña123')).toBeNull();
  });
  it('fewer than 12 characters', () => expect(passwordProblem('abc12345678')).toBe('Usa al menos 12 caracteres.'));
  it('letters only', () => expect(passwordProblem('soloLetrasLargas')).toBe('Combina letras y números.'));
  it('numbers only', () => expect(passwordProblem('123456789012')).toBe('Combina letras y números.'));
  it('empty', () => expect(passwordProblem('')).toBe('Escribe una contraseña.'));
});

describe('show / hide', () => {
  it('hidden by default: password type, "Mostrar" label, not pressed', () => {
    expect(revealState(false)).toEqual({ type: 'password', label: 'Mostrar contraseña', pressed: false, icon: 'eye' });
  });
  it('shown: text type, "Ocultar" label, pressed', () => {
    expect(revealState(true)).toEqual({ type: 'text', label: 'Ocultar contraseña', pressed: true, icon: 'eyeOff' });
  });
});

describe('submitGate (no double submit)', () => {
  it('a second submit while the first is in flight is refused; opens again after the answer', () => {
    const g = submitGate();
    expect(g.enter()).toBe(true);
    expect(g.busy).toBe(true);
    expect(g.enter()).toBe(false);
    g.leave();
    expect(g.enter()).toBe(true);
  });
});

describe('outcomes', () => {
  it('success → short confirmation', () => expect(passwordChangeOutcome(null, false)).toEqual({ message: PASSWORD_CHANGED, done: 1 }));
  it('Supabase asks for reauthentication → send the code (never an error first)', () => {
    expect(passwordChangeOutcome({ status: 400, code: 'reauthentication_needed' }, false)).toBe('reauthenticate');
  });
  it('wrong or expired code → stays on the code step', () => {
    expect(passwordChangeOutcome({ status: 400, code: 'reauthentication_not_valid' }, true)).toMatchObject({ needsCode: true, error: expect.stringContaining('código') });
  });
  it('Supabase errors in plain words, never the provider text', () => {
    expect(passwordChangeOutcome({ code: 'same_password' }, false)).toEqual({ error: 'Usa una contraseña distinta a la actual.' });
    expect(passwordChangeOutcome({ code: 'weak_password' }, false)).toEqual({ error: 'Esa contraseña es fácil de adivinar. Prueba con otra.' });
    expect(passwordChangeOutcome({ status: 429 }, false)).toEqual({ error: 'Demasiados intentos. Espera unos minutos.' });
    expect(passwordChangeOutcome({ status: 500, code: 'unexpected_failure' }, false)).toEqual({ error: 'No pudimos cambiar tu contraseña. Intenta de nuevo.' });
  });
  it('reauthentication email', () => {
    expect(reauthRequestOutcome(null)).toEqual({ needsCode: true, message: CODE_SENT });
    expect(reauthRequestOutcome({ status: 429 })).toEqual({ error: 'Demasiados intentos. Espera unos minutos.' });
  });
  it('code: 6–10 digits, spaces ignored', () => {
    expect(parseReauthCode('123 456')).toBe('123456');
    expect(parseReauthCode('12345')).toBeNull();
    expect(parseReauthCode('abc123')).toBeNull();
    expect(parseReauthCode(null)).toBeNull();
  });
});

// ── The real server action, with Next.js and Supabase stubbed ────────────────────────────────────────────────
const getUser = vi.fn();
const updateUser = vi.fn();
const reauthenticate = vi.fn();
const signOut = vi.fn(async () => ({ error: null }));
const redirect = vi.fn((to: string) => { throw new Error(`redirect:${to}`); });
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), getAll: () => [] }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser, updateUser, reauthenticate, signOut } }),
  authUser: vi.fn(),
}));

const form = (password: string, code?: string) => {
  const f = new FormData(); f.set('password', password); if (code !== undefined) f.set('code', code); return f;
};

describe('changePassword action', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    for (const m of [getUser, updateUser, reauthenticate]) m.mockReset();
    signOut.mockClear();
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('valid password → Supabase updateUser → "Contraseña actualizada."', async () => {
    const { changePassword } = await import('../app/auth/actions');
    updateUser.mockResolvedValueOnce({ data: {}, error: null });
    expect(await changePassword({}, form('ahorro2026lima'))).toEqual({ message: PASSWORD_CHANGED, done: 1 });
    expect(updateUser).toHaveBeenCalledWith({ password: 'ahorro2026lima' });
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledWith({ scope: 'others' });
  });

  it('server validates again: short / letters only / numbers only never reach Supabase', async () => {
    const { changePassword } = await import('../app/auth/actions');
    for (const [pw, msg] of [['abc12345678', 'Usa al menos 12 caracteres.'], ['soloLetrasLargas', 'Combina letras y números.'], ['123456789012', 'Combina letras y números.']]) {
      expect((await changePassword({}, form(pw!))).error).toBe(msg);
    }
    expect(getUser).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('Supabase error → plain message, logged without the password', async () => {
    const { changePassword } = await import('../app/auth/actions');
    updateUser.mockResolvedValueOnce({ data: null, error: { status: 422, code: 'same_password', message: 'New password should be different' } });
    expect(await changePassword({}, form('ahorro2026lima'))).toEqual({ error: 'Usa una contraseña distinta a la actual.' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ahorro2026lima');
    expect(signOut).not.toHaveBeenCalled();
  });

  it('reauthentication: Supabase emails a code, the next submit sends it as nonce', async () => {
    const { changePassword } = await import('../app/auth/actions');
    updateUser.mockResolvedValueOnce({ data: null, error: { status: 400, code: 'reauthentication_needed' } });
    reauthenticate.mockResolvedValueOnce({ data: {}, error: null });
    const step = await changePassword({}, form('ahorro2026lima'));
    expect(step).toEqual({ needsCode: true, message: CODE_SENT });
    expect(await changePassword(step, form('ahorro2026lima', ''))).toEqual({ needsCode: true, error: 'Escribe el código que te enviamos por correo.' });
    updateUser.mockResolvedValueOnce({ data: {}, error: null });
    expect(await changePassword(step, form('ahorro2026lima', '123456'))).toEqual({ message: PASSWORD_CHANGED, done: 1 });
    expect(updateUser).toHaveBeenLastCalledWith({ password: 'ahorro2026lima', nonce: '123456' });
    expect(reauthenticate).toHaveBeenCalledTimes(1);
  });

  it('no session → back to login, nothing updated', async () => {
    const { changePassword } = await import('../app/auth/actions');
    getUser.mockResolvedValueOnce({ data: { user: null }, error: { status: 401 } });
    await expect(changePassword({}, form('ahorro2026lima'))).rejects.toThrow('redirect:/login');
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe('POST /auth/logout ("Cerrar sesión", a plain form outside /app)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { signOut.mockClear(); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());
  const SAME = { origin: 'https://velsuno.example', host: 'velsuno.example', 'sec-fetch-site': 'same-origin' };
  const post = (headers: Record<string, string> = SAME) => new NextRequest('https://velsuno.example/auth/logout', { method: 'POST', headers });

  it('signs out this device only (scope local), then 303 to /login', async () => {
    const { POST } = await import('../app/auth/logout/route');
    const res = await POST(post());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://velsuno.example/login');
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a revoke failure is logged (status/code only) and the person still lands on /login', async () => {
    const { POST } = await import('../app/auth/logout/route');
    signOut.mockResolvedValueOnce({ error: { status: 500, code: 'unexpected_failure' } } as never);
    const res = await POST(post());
    expect(res.headers.get('location')).toBe('https://velsuno.example/login');
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({ event: 'logout_failed', status: 500, code: 'unexpected_failure' });
  });

  it('a cross-site form cannot sign anyone out (403, Supabase not called)', async () => {
    const { POST } = await import('../app/auth/logout/route');
    expect((await POST(post({ origin: 'https://evil.example', host: 'velsuno.example' }))).status).toBe(403);
    expect((await POST(post({ 'sec-fetch-site': 'cross-site', host: 'velsuno.example' }))).status).toBe(403);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('behind Vercel the forwarded host is the one compared', async () => {
    const { POST } = await import('../app/auth/logout/route');
    const res = await POST(post({ origin: 'https://velsuno.example', host: 'internal.vercel', 'x-forwarded-host': 'velsuno.example' }));
    expect(res.status).toBe(303);
  });

  it('no server action is left for "Cerrar sesión" (it would post to /app and meet the registration gate)', async () => {
    const actions = await import('../app/auth/actions');
    expect('logout' in actions).toBe(false);
  });
});
