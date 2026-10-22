import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailLinkOutcome, newPasswordError, passwordResetOutcome, REGISTRATION_TOO_MANY, registrationError, registrationOutcome, RESET_SENT } from '../src/web/password-reset';

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
const updateUser = vi.fn();
const signOut = vi.fn();
const rpc = vi.fn();
const authUser = vi.fn();
const calls: string[] = [];
const redirect = vi.fn((to: string) => { calls.push(`redirect:${to}`); });
vi.mock('server-only', () => ({}));
// Cap is covered in tests/cap.test.ts; here the person already passed it (the subject is anti-enumeration).
vi.mock('../lib/cap', () => ({ capPassed: async () => true }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), getAll: () => [] }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ auth: { resetPasswordForEmail, signInWithOtp, updateUser, signOut }, rpc }),
  authUser: (...a: unknown[]) => authUser(...a),
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

describe('updatePassword (recovery link → new password): other devices are signed out', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  const pw = (password: string) => { const f = new FormData(); f.set('password', password); return f; };
  beforeEach(() => {
    for (const m of [updateUser, signOut, authUser, redirect]) m.mockClear();
    calls.length = 0;
    authUser.mockResolvedValue({ id: 'u1', email: null });
    updateUser.mockReset();
    signOut.mockReset();
    signOut.mockImplementation(async (o: unknown) => { calls.push(`signOut:${JSON.stringify(o)}`); return { error: null }; });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('success → signOut({ scope: "others" }) exactly once, then redirect to /app', async () => {
    const { updatePassword } = await import('../app/auth/actions');
    updateUser.mockResolvedValueOnce({ data: {}, error: null });
    await updatePassword({}, pw('ahorro2026lima'));
    expect(updateUser).toHaveBeenCalledWith({ password: 'ahorro2026lima' });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: 'others' });
    expect(calls).toEqual(['signOut:{"scope":"others"}', 'redirect:/app']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('updateUser error → plain message, no sign-out, no redirect', async () => {
    const { updatePassword } = await import('../app/auth/actions');
    updateUser.mockResolvedValueOnce({ data: null, error: { status: 422, code: 'weak_password' } });
    expect(await updatePassword({}, pw('ahorro2026lima'))).toEqual({ error: 'Esa contraseña es fácil de adivinar. Prueba con otra.' });
    expect(signOut).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('a sign-out failure is logged as {event, status, code} without the password, and the person still continues', async () => {
    const { updatePassword } = await import('../app/auth/actions');
    updateUser.mockResolvedValueOnce({ data: {}, error: null });
    signOut.mockResolvedValueOnce({ error: { status: 500, code: 'unexpected_failure', message: 'boom' } });
    await updatePassword({}, pw('ahorro2026lima'));
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(logged)).toEqual({ event: 'password_reset_signout_others_failed', status: 500, code: 'unexpected_failure' });
    expect(logged).not.toContain('ahorro2026lima');
    expect(redirect).toHaveBeenCalledWith('/app');
  });

  it('expired link (no session) → asks for a new link; nothing is changed', async () => {
    const { updatePassword } = await import('../app/auth/actions');
    authUser.mockResolvedValueOnce(null);
    expect(await updatePassword({}, pw('ahorro2026lima'))).toEqual({ error: 'Tu enlace venció. Pide uno nuevo.' });
    expect(updateUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe('completeProfile: finish_registration answers a status (migration 049)', () => {
  const TAKEN = 'Ese número ya está registrado en otra cuenta. Usa otro número o entra con esa cuenta.';
  const profileForm = () => {
    const f = new FormData();
    f.set('givenNames', 'Ana María'); f.set('familyNames', 'Pérez Soto'); f.set('phone', '987654321');
    f.set('birthDate', '1990-04-20'); f.set('accept', 'on');
    return f;
  };
  beforeEach(() => {
    rpc.mockReset(); redirect.mockClear(); calls.length = 0;
    authUser.mockResolvedValue({ id: 'u1', email: null });
  });

  it('pure mapping: ok / already_registered continue; refusals become copy; unknown fails closed', () => {
    for (const ok of ['ok', 'already_registered']) expect(registrationOutcome(ok, null)).toEqual({ next: '/bienvenida' });
    expect(registrationOutcome('phone_taken', null)).toEqual({ error: TAKEN });
    expect(registrationOutcome('too_many_attempts', null)).toEqual({ error: REGISTRATION_TOO_MANY });
    // Says what happened and when / how to try again (the window is 24 h; nothing sensitive in saying so).
    expect(REGISTRATION_TOO_MANY).toBe('Probaste varios números ya registrados. Intenta de nuevo mañana con otro número.');
    expect(registrationOutcome('something_new', null)).toEqual({ error: 'No pudimos guardar tus datos. Intenta de nuevo.' });
    expect(registrationOutcome({ status: 'ok' }, null)).toEqual({ error: 'No pudimos guardar tus datos. Intenta de nuevo.' });
    // An error wins over any data, and still never shows the provider's text.
    expect(registrationOutcome('ok', { message: 'under_age' })).toEqual({ error: 'Velsuno es para personas mayores de 18 años.' });
    expect(registrationOutcome(null, { message: 'permission denied for function complete_registration' })).toEqual({ error: 'No pudimos guardar tus datos. Intenta de nuevo.' });
  });

  it('an empty answer is success only from the old void complete_registration (fallback), never from finish_registration', () => {
    for (const empty of [null, undefined, '']) {
      expect(registrationOutcome(empty, null)).toEqual({ error: 'No pudimos guardar tus datos. Intenta de nuevo.' });
      expect(registrationOutcome(empty, null, true)).toEqual({ next: '/bienvenida' });
    }
  });

  it('the action: an empty answer from finish_registration stays on the form (fail closed)', async () => {
    const { completeProfile } = await import('../app/auth/actions');
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await completeProfile({}, profileForm())).toEqual({ error: 'No pudimos guardar tus datos. Intenta de nuevo.' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('the action sends the normalized values once and redirects only on ok / already_registered', async () => {
    const { completeProfile } = await import('../app/auth/actions');
    for (const answer of ['ok', 'already_registered']) {
      rpc.mockResolvedValueOnce({ data: answer, error: null });
      expect(await completeProfile({}, profileForm())).toBeUndefined();
    }
    expect(calls).toEqual(['redirect:/bienvenida', 'redirect:/bienvenida']);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith('finish_registration', {
      p_given: 'Ana María', p_family: 'Pérez Soto', p_phone: '+51987654321', p_birth: '1990-04-20', p_terms: '2026-10-08', p_privacy: '2026-10-08',
    });
  });

  it('only while 049 is not applied (PGRST202) it falls back to complete_registration; any other error does not', async () => {
    const { completeProfile } = await import('../app/auth/actions');
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    rpc.mockResolvedValueOnce({ data: null, error: null }); // old void function: success
    expect(await completeProfile({}, profileForm())).toBeUndefined();
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['finish_registration', 'complete_registration']);
    expect(rpc.mock.calls[1]![1]).toEqual(rpc.mock.calls[0]![1]);
    expect(calls).toEqual(['redirect:/bienvenida']);
    // The old function's raise is still mapped to copy.
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'phone_taken' } });
    expect(await completeProfile({}, profileForm())).toEqual({ error: TAKEN });
    // After 049 the old function is not executable: a permission error is never retried elsewhere.
    rpc.mockReset();
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied for function finish_registration' } });
    expect(await completeProfile({}, profileForm())).toEqual({ error: 'No pudimos guardar tus datos. Intenta de nuevo.' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('phone_taken and too_many_attempts stay on the form with plain copy; no redirect', async () => {
    const { completeProfile } = await import('../app/auth/actions');
    rpc.mockResolvedValueOnce({ data: 'phone_taken', error: null });
    expect(await completeProfile({}, profileForm())).toEqual({ error: TAKEN });
    rpc.mockResolvedValueOnce({ data: 'too_many_attempts', error: null });
    expect(await completeProfile({}, profileForm())).toEqual({ error: REGISTRATION_TOO_MANY });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'consent_version', code: '22023' } });
    expect(await completeProfile({}, profileForm())).toEqual({ error: 'Actualizamos los Términos o la Política de Privacidad. Recarga la página y vuelve a aceptarlos.' });
    expect(redirect).not.toHaveBeenCalled();
  });
});
