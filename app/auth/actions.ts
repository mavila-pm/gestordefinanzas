'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { authCallbackUrl } from '../../lib/env';
import { authUser, createSupabaseServerClient } from '../../lib/supabase/server';
import { AUTH_NEXT_COOKIE, authNextCookieOptions, normalizePhone, parseBirthDate, parseEmail, passwordProblem, safeNextPath } from '../../src/web/auth-input';
import { PRIVACY_VERSION, TERMS_VERSION } from '../../src/web/legal';
import { emailLinkOutcome, newPasswordError, passwordResetOutcome, registrationError } from '../../src/web/password-reset';
import { LOGIN_INVALID, LOGIN_SERVER, lockoutMessage, loginOutcome } from '../../src/web/login';

/** Remembers where the email link should land (the callback URL itself stays query-free). */
async function rememberAuthNext(path: '/crear-cuenta' | '/reset-password') {
  (await cookies()).set(AUTH_NEXT_COOKIE, path, authNextCookieOptions(process.env.NODE_ENV === 'production'));
}

export interface FormState {
  error?: string;
  message?: string;
  /** Registration: the link was sent (the form switches to "Revisa tu correo"). */
  sent?: true;
}

export async function login(_prev: FormState, form: FormData): Promise<FormState> {
  const email = parseEmail(form.get('email'));
  const password = form.get('password');
  if (!email || typeof password !== 'string' || !password) return { error: LOGIN_INVALID };
  const supabase = await createSupabaseServerClient();
  // Progressive lockout (migrations 033/034): reserved in the database before the password is checked, keyed on the email.
  // No IP: this RPC is public, so a caller-supplied IP could lock a shared carrier IP for everyone behind it.
  const { data: gate, error: gateError } = await supabase.rpc('login_attempt', { p_email: email, p_ip: null });
  const g = Array.isArray(gate) ? gate[0] : null;
  if (gateError || !g) {
    console.warn(JSON.stringify({ event: 'login_gate_failed', code: gateError?.code ?? null }));
    return { error: LOGIN_SERVER };
  }
  if (!g.allowed) return { error: lockoutMessage(g.wait_seconds) };
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const outcome = loginOutcome(error, g.wait_seconds);
    if (outcome.diagnostic) console.warn(JSON.stringify(outcome.diagnostic));
    return { error: outcome.message };
  }
  const { error: resetError } = await supabase.rpc('login_succeeded', { p_ip: null });
  if (resetError) console.warn(JSON.stringify({ event: 'login_reset_failed', code: resetError.code ?? null }));
  redirect(safeNextPath(form.get('next')));
}

/**
 * Registration step 1: email only. Supabase Auth sends a signed, single-use, expiring link (signInWithOtp creates the
 * user if new; a registered address simply gets a sign-in link). The link lands on /auth/confirm (token_hash) and
 * continues at /crear-cuenta. Same answer for new and registered addresses; the address is never logged.
 */
export async function signup(_prev: FormState, form: FormData): Promise<FormState> {
  const email = parseEmail(form.get('email'));
  if (!email) return { error: 'Revisa tu correo electrónico.' };
  const supabase = await createSupabaseServerClient();
  await rememberAuthNext('/crear-cuenta');
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: authCallbackUrl() } });
  const outcome = emailLinkOutcome(error);
  if (outcome.diagnostic) console.warn(JSON.stringify(outcome.diagnostic));
  return outcome.state;
}

/** Registration step 2: the password (12+, letters and numbers), validated here and by Supabase Auth. */
export async function createPassword(_prev: FormState, form: FormData): Promise<FormState> {
  const password = form.get('password');
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  const supabase = await createSupabaseServerClient();
  if (!(await authUser(supabase))) redirect('/login?error=link');
  const { error } = await supabase.auth.updateUser({ password: password as string });
  if (error) {
    console.warn(JSON.stringify({ event: 'registration_password_failed', status: error.status ?? null, code: error.code ?? null }));
    return { error: newPasswordError(error) };
  }
  // The step is recorded by the database when Supabase Auth changes the password (trigger, migration 031).
  redirect('/crear-cuenta/perfil');
}

/** Registration step 3: profile, 18+ (birth date, checked again in SQL) and acceptance of the current legal versions. */
export async function completeProfile(_prev: FormState, form: FormData): Promise<FormState> {
  const given = String(form.get('givenNames') ?? '').trim();
  const family = String(form.get('familyNames') ?? '').trim();
  if (!given || !family) return { error: 'Escribe tu nombre y apellidos.' };
  const phone = normalizePhone(form.get('phone'));
  if (!phone) return { error: 'Revisa tu número de celular. Si no es de Perú, incluye el código de país (+).' };
  const birth = parseBirthDate(form.get('birthDate'));
  if (!birth) return { error: 'Revisa tu fecha de nacimiento.' };
  if (form.get('accept') !== 'on') return { error: 'Para continuar, acepta los Términos y la Política de Privacidad.' };
  const supabase = await createSupabaseServerClient();
  if (!(await authUser(supabase))) redirect('/login');
  const { error } = await supabase.rpc('complete_registration', {
    p_given: given, p_family: family, p_phone: phone, p_birth: birth, p_terms: TERMS_VERSION, p_privacy: PRIVACY_VERSION,
  });
  if (error) return { error: registrationError(error.message) };
  redirect('/bienvenida');
}

export async function requestPasswordReset(_prev: FormState, form: FormData): Promise<FormState> {
  const email = parseEmail(form.get('email'));
  if (!email) return { error: 'Ingresa un correo válido.' };
  const supabase = await createSupabaseServerClient();
  await rememberAuthNext('/reset-password');
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: authCallbackUrl() });
  // Same neutral answer whether or not the account exists, including Supabase's 429 (which only happens for
  // registered emails). The failure is logged server-side for diagnosis, without the email address.
  const outcome = passwordResetOutcome(error);
  if (outcome.diagnostic) console.warn(JSON.stringify(outcome.diagnostic));
  return outcome.state;
}

export async function updatePassword(_prev: FormState, form: FormData): Promise<FormState> {
  const password = form.get('password');
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  const supabase = await createSupabaseServerClient();
  if (!(await authUser(supabase))) return { error: 'Tu enlace venció. Pide uno nuevo.' };
  const { error } = await supabase.auth.updateUser({ password: password as string });
  if (error) return { error: newPasswordError(error) };
  redirect('/app');
}

export async function logout(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}
