/**
 * Login messages and request facts (pure). Never reveal whether an email is registered: unknown email and wrong
 * password get the same text, and the lockout applies the same way to both (migration 033).
 *
 * The lockout counter (public.login_attempt) can still be called directly with the publishable key, outside the app
 * and its Cap check, so a third party can keep someone's email locked for password sign-in. The lock therefore
 * always offers the ways in that do not use the password: an email link and password recovery (ADR-0016).
 */
export const LOGIN_INVALID = 'Correo o contraseña incorrectos. Por favor, inténtalo de nuevo.';
export const LOGIN_UNCONFIRMED = 'Debes confirmar tu correo electrónico antes de iniciar sesión.';
export const LOGIN_SERVER = 'No pudimos iniciar sesión. Inténtalo nuevamente en unos momentos.';

/** Shown under the lock message (same for every email, registered or not). */
export const LOCKOUT_LINKS = [
  { href: '/signup?modo=enlace', label: 'Recibir un enlace para entrar' },
  { href: '/forgot-password', label: '¿Olvidaste tu contraseña?' },
] as const;

export function lockoutMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Demasiados intentos fallidos. Por seguridad, podrás intentarlo nuevamente en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.`;
}

/** Form state of a locked login: the message plus the email-link and recovery ways in (LOCKOUT_LINKS). */
export function lockedState(seconds: number): { error: string; locked: true } {
  return { error: lockoutMessage(seconds), locked: true };
}

export interface LoginOutcome { message: string; locked: boolean; diagnostic: { event: 'login_failed'; status: number | null; code: string | null } | null }

/**
 * Supabase Auth error → text. `email_not_confirmed` is only returned after the password matched, so showing it does not
 * help guess accounts. `lockSeconds` > 0 when this failed attempt closed a group of 3: say so right away.
 */
export function loginOutcome(error: { status?: number; code?: string }, lockSeconds: number): LoginOutcome {
  const status = typeof error.status === 'number' ? error.status : null;
  const code = typeof error.code === 'string' ? error.code : null;
  if (code === 'email_not_confirmed') return { message: LOGIN_UNCONFIRMED, locked: false, diagnostic: null };
  if (code === 'invalid_credentials' || code === 'validation_failed' || status === 400) {
    return lockSeconds > 0
      ? { message: lockoutMessage(lockSeconds), locked: true, diagnostic: null }
      : { message: LOGIN_INVALID, locked: false, diagnostic: null };
  }
  return { message: LOGIN_SERVER, locked: false, diagnostic: { event: 'login_failed', status, code } };
}
