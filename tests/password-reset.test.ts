import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailLinkOutcome, newPasswordError, passwordResetOutcome, registrationError, RESET_SENT } from '../src/web/password-reset';

/**
 * Anti-enumeration for password recovery (spec §86). Supabase returns 429 `over_email_send_rate_limit` only for
 * REGISTERED emails (it only rate-limits when it would send); unknown emails get 200. Observed on the real project
 * on 2026-09-27. The user-facing answer must be identical in both cases.
 * No network and no emails: the Supabase client is a stub.
 */

const RATE_LIMITED = { status: 429, code: 'over_email_send_rate_limit', message: 'email rate limit exceeded', name: 'AuthApiError' };

describe('passwordResetOutcome (pure policy)', () => {
  it('registered email rate-limited (429) and unknown email (no error) produce the same user state', () => {
    const existing = passwordResetOutcome(RATE_LIMITED);
    const unknown = passwordResetOutcome(null);
    expect(existing.state).toEqual(unknown.state);
    expect(existing.state).toEqual({ message: RESET_SENT });
    expect(existing.state).not.toHaveProperty('error');
  });

  it('any other failure is also neutral to the user', () => {
    for (const e of [{ status: 500, code: 'unexpected_failure' }, { status: 400 }, {}]) {
      expect(passwordResetOutcome(e).state).toEqual({ message: RESET_SENT });
    }
  });

  it('keeps an internal diagnostic only when Supabase failed, with status/code and no email', () => {
    expect(passwordResetOutcome(null).diagnostic).toBeNull();
    expect(passwordResetOutcome(RATE_LIMITED).diagnostic).toEqual({ event: 'password_reset_request_failed', status: 429, code: 'over_email_send_rate_limit' });
  });
});

// ── The real server action, with Next.js and Supabase stubbed ────────────────────────────────────────────────
const resetPasswordForEmail = vi.fn();
const signInWithOtp = vi.fn();
vi.mock('server-only', () => ({}));
// Cap is covered in tests/cap.test.ts; here the person already passed it (the subject is anti-enumeration).
vi.mock('../lib/cap', () => ({ capPassed: async () => true }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), getAll: () => [] }) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ auth: { resetPasswordForEmail, signInWithOtp } }),
}));

const form = (email: string) => { const f = new FormData(); f.set('email', email); return f; };

describe('requestPasswordReset action: no enumeration by message difference', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetPasswordForEmail.mockReset();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('registered email hitting the email rate limit === unknown email, byte for byte', async () => {
    const { requestPasswordReset } = await import('../app/auth/actions');
    resetPasswordForEmail.mockResolvedValueOnce({ data: null, error: RATE_LIMITED }); // account exists
    const existing = await requestPasswordReset({}, form('registered@example.test'));
    resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: null }); // no such account
    const unknown = await requestPasswordReset({}, form('nobody@example.test'));

    expect(JSON.stringify(existing)).toBe(JSON.stringify(unknown));
    expect(existing).toEqual({ message: RESET_SENT });
  });

  it('logs the 429 internally once, without the email address', async () => {
    const { requestPasswordReset } = await import('../app/auth/actions');
    resetPasswordForEmail.mockResolvedValueOnce({ data: null, error: RATE_LIMITED });
    await requestPasswordReset({}, form('registered@example.test'));
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(logged)).toEqual({ event: 'password_reset_request_failed', status: 429, code: 'over_email_send_rate_limit' });
    expect(logged).not.toContain('registered@example.test');
  });

  it('a successful request logs nothing and still uses the query-free callback', async () => {
    const { requestPasswordReset } = await import('../app/auth/actions');
    resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: null });
    await requestPasswordReset({}, form('someone@example.test'));
    expect(warn).not.toHaveBeenCalled();
    expect(resetPasswordForEmail).toHaveBeenCalledWith('someone@example.test', { redirectTo: 'http://localhost:3000/auth/confirm' });
  });

  it('an invalid email format is rejected before calling Supabase (format, not existence)', async () => {
    const { requestPasswordReset } = await import('../app/auth/actions');
    expect(await requestPasswordReset({}, form('not-an-email'))).toEqual({ error: 'Ingresa un correo válido.' });
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe('signup (email only): same answer for new and registered addresses; errors in plain words', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { signInWithOtp.mockReset(); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  it('new and registered addresses both get { sent: true }; the link goes to the query-free callback', async () => {
    const { signup } = await import('../app/auth/actions');
    signInWithOtp.mockResolvedValue({ data: {}, error: null });
    const fresh = await signup({}, form('new@example.test'));
    const registered = await signup({}, form('registered@example.test'));
    expect(fresh).toEqual({ sent: true });
    expect(JSON.stringify(fresh)).toBe(JSON.stringify(registered));
    expect(signInWithOtp).toHaveBeenCalledWith({ email: 'new@example.test', options: { shouldCreateUser: true, emailRedirectTo: 'http://localhost:3000/auth/confirm' } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('rate limit and provider failures are shown in plain words and logged without the address', async () => {
    const { signup } = await import('../app/auth/actions');
    signInWithOtp.mockResolvedValueOnce({ data: null, error: RATE_LIMITED });
    expect(await signup({}, form('someone@example.test'))).toEqual({ error: 'Demasiados intentos. Espera un minuto y vuelve a intentarlo.' });
    expect(String(warn.mock.calls[0]![0])).not.toContain('someone@example.test');
    expect(emailLinkOutcome({ status: 500, code: 'unexpected_failure' }).state).toEqual({ error: 'No pudimos enviar el correo. Intenta de nuevo en unos minutos.' });
    expect(await signup({}, form('not-an-email'))).toEqual({ error: 'Revisa tu correo electrónico.' });
  });

  it('password and profile errors never show provider text', () => {
    expect(newPasswordError({ status: 422, code: 'weak_password' })).toMatch(/fácil de adivinar/);
    expect(newPasswordError({ status: 401 })).toMatch(/enlace venció/);
    expect(registrationError('under_age')).toBe('Velsuno es para personas mayores de 18 años.');
    expect(registrationError('phone_taken')).toBe('Ese número ya está registrado en otra cuenta. Usa otro número o entra con esa cuenta.');
    expect(registrationError('duplicate key value violates something internal')).toBe('No pudimos guardar tus datos. Intenta de nuevo.');
  });
});
