/**
 * Login messages and request facts (pure). Never reveal whether an email is registered: unknown email and wrong
 * password get the same text, and the lockout applies the same way to both (migration 033).
 */
export const LOGIN_INVALID = 'Correo o contraseña incorrectos. Por favor, inténtalo de nuevo.';
export const LOGIN_UNCONFIRMED = 'Debes confirmar tu correo electrónico antes de iniciar sesión.';
export const LOGIN_SERVER = 'No pudimos iniciar sesión. Inténtalo nuevamente en unos momentos.';

export function lockoutMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Demasiados intentos fallidos. Por seguridad, podrás intentarlo nuevamente en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.`;
}

export interface LoginOutcome { message: string; diagnostic: { event: 'login_failed'; status: number | null; code: string | null } | null }

/**
 * Supabase Auth error → text. `email_not_confirmed` is only returned after the password matched, so showing it does not
 * help guess accounts. `lockSeconds` > 0 when this failed attempt closed a group of 3: say so right away.
 */
export function loginOutcome(error: { status?: number; code?: string }, lockSeconds: number): LoginOutcome {
  const status = typeof error.status === 'number' ? error.status : null;
  const code = typeof error.code === 'string' ? error.code : null;
  if (code === 'email_not_confirmed') return { message: LOGIN_UNCONFIRMED, diagnostic: null };
  if (code === 'invalid_credentials' || code === 'validation_failed' || status === 400) {
    return { message: lockSeconds > 0 ? lockoutMessage(lockSeconds) : LOGIN_INVALID, diagnostic: null };
  }
  return { message: LOGIN_SERVER, diagnostic: { event: 'login_failed', status, code } };
}
