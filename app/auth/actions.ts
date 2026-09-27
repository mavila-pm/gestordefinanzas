'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { authCallbackUrl } from '../../lib/env';
import { createSupabaseServerClient } from '../../lib/supabase/server';
import { AUTH_NEXT_COOKIE, authNextCookieOptions, parseEmail, passwordProblem, safeNextPath } from '../../src/web/auth-input';
import { passwordResetOutcome } from '../../src/web/password-reset';

/** Remembers where the email link should land (the callback URL itself stays query-free). */
async function rememberAuthNext(path: '/app' | '/reset-password') {
  (await cookies()).set(AUTH_NEXT_COOKIE, path, authNextCookieOptions(process.env.NODE_ENV === 'production'));
}

export interface FormState {
  error?: string;
  message?: string;
}

// Messages never reveal whether an account exists (anti-enumeration, §86).
const GENERIC_LOGIN_ERROR = 'Correo o contraseña incorrectos, o cuenta sin confirmar.';
const SIGNUP_SENT = 'Si el correo es válido, te enviamos un enlace para confirmar tu cuenta.';

export async function login(_prev: FormState, form: FormData): Promise<FormState> {
  const email = parseEmail(form.get('email'));
  const password = form.get('password');
  if (!email || typeof password !== 'string' || !password) return { error: GENERIC_LOGIN_ERROR };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.status === 429 ? 'Demasiados intentos. Espera unos minutos.' : GENERIC_LOGIN_ERROR };
  redirect(safeNextPath(form.get('next')));
}

export async function signup(_prev: FormState, form: FormData): Promise<FormState> {
  const email = parseEmail(form.get('email'));
  if (!email) return { error: 'Ingresa un correo válido.' };
  const problem = passwordProblem(form.get('password'));
  if (problem) return { error: problem };
  const supabase = await createSupabaseServerClient();
  await rememberAuthNext('/app');
  const { error } = await supabase.auth.signUp({
    email,
    password: form.get('password') as string,
    options: { emailRedirectTo: authCallbackUrl() },
  });
  if (error?.status === 429) return { error: 'Demasiados intentos. Espera unos minutos.' };
  if (error && error.code === 'weak_password') return { error: 'La contraseña es demasiado débil.' };
  // Any other outcome (including an already registered email) gets the same answer.
  return { message: SIGNUP_SENT };
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
  if (password !== form.get('confirm')) return { error: 'Las contraseñas no coinciden.' };
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'El enlace expiró. Solicita uno nuevo.' };
  const { error } = await supabase.auth.updateUser({ password: password as string });
  if (error) return { error: 'No se pudo actualizar la contraseña. Intenta con otra.' };
  redirect('/app');
}

export async function logout(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}
