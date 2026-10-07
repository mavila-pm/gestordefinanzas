'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { authCallbackUrl } from '../../lib/env';
import { authUser, createSupabaseServerClient } from '../../lib/supabase/server';
import { AUTH_NEXT_COOKIE, authNextCookieOptions, parseEmail, passwordProblem, safeNextPath } from '../../src/web/auth-input';
import { passwordResetOutcome, signupOutcome } from '../../src/web/password-reset';

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
  // Any outcome (new or registered email, including Supabase's 429) gets the same answer; failures are logged
  // server-side without the email address.
  const outcome = signupOutcome(error);
  if (outcome.diagnostic) console.warn(JSON.stringify(outcome.diagnostic));
  return outcome.state;
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

/**
 * "Eliminar mi cuenta" (privacy policy, MVP P1): the SQL function deletes only the signed-in person (auth.uid()) and
 * every row of theirs cascades. Typed confirmation on both sides. Then the local session is cleared (no network call:
 * the user no longer exists) and the person lands on the home page.
 */
export async function deleteAccount(_prev: FormState, form: FormData): Promise<FormState> {
  if (String(form.get('confirm') ?? '').trim() !== 'ELIMINAR') return { error: 'Escribe ELIMINAR, en mayúsculas, para confirmar.' };
  const supabase = await createSupabaseServerClient();
  if (!(await authUser(supabase))) redirect('/login');
  const { error } = await supabase.rpc('delete_my_account', { p_confirm: 'ELIMINAR' });
  if (error) {
    console.warn(JSON.stringify({ event: 'account_delete_failed', code: error.code ?? null }));
    return { error: 'No pudimos eliminar tu cuenta. Intenta de nuevo en unos minutos.' };
  }
  console.info(JSON.stringify({ event: 'account_deleted' })); // anonymous trace only: no id, no email
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  redirect('/?cuenta=eliminada');
}
