/**
 * Signed-in password change (Ajustes → Cuenta). Uses Supabase Auth only: `updateUser({ password })`, and when the
 * project has "Secure password change" on and the session is older than 24 h, Supabase answers
 * `reauthentication_needed`; then `reauthenticate()` emails a one-time code that goes back as `nonce`.
 * No parallel auth: the app never checks the current password itself.
 */

export const PASSWORD_CHANGED = 'Contraseña actualizada.';
export const CODE_SENT = 'Por seguridad, te enviamos un código a tu correo. Escríbelo para continuar.';

export interface ChangePasswordState {
  error?: string;
  message?: string;
  /** Supabase asked for reauthentication: the form shows the code field. */
  needsCode?: true;
  /** Changed: the form clears what was typed. Increments so two changes in a row both reset. */
  done?: number;
}

/** The emailed reauthentication code (Supabase OTP: 6–10 digits). Spaces are ignored; anything else → null. */
export function parseReauthCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = v.replace(/\s/g, '');
  return /^\d{6,10}$/.test(c) ? c : null;
}

type AuthError = { status?: number; code?: string } | null | undefined;

/** What the form shows after `updateUser`. `withCode`: the attempt carried a reauthentication code. */
export function passwordChangeOutcome(error: AuthError, withCode: boolean, done = 1): ChangePasswordState | 'reauthenticate' {
  if (!error) return { message: PASSWORD_CHANGED, done };
  if (error.code === 'reauthentication_needed' || error.code === 'reauth_nonce_missing') {
    return withCode ? { needsCode: true, error: 'El código no es correcto o venció. Revisa tu correo.' } : 'reauthenticate';
  }
  if (error.code === 'reauthentication_not_valid') return { needsCode: true, error: 'El código no es correcto o venció. Revisa tu correo.' };
  if (error.status === 429 || error.code === 'over_request_rate_limit' || error.code === 'over_email_send_rate_limit') {
    return { needsCode: withCode || undefined, error: 'Demasiados intentos. Espera unos minutos.' };
  }
  if (error.code === 'same_password') return { error: 'Usa una contraseña distinta a la actual.' };
  if (error.code === 'weak_password') return { error: 'Esa contraseña es fácil de adivinar. Prueba con otra.' };
  if (error.code === 'session_not_found' || error.status === 401) return { error: 'Tu sesión venció. Vuelve a entrar.' };
  return { error: 'No pudimos cambiar tu contraseña. Intenta de nuevo.' };
}

/** After asking Supabase to email the reauthentication code. */
export function reauthRequestOutcome(error: AuthError): ChangePasswordState {
  if (!error) return { needsCode: true, message: CODE_SENT };
  if (error.status === 429 || error.code === 'over_email_send_rate_limit' || error.code === 'over_request_rate_limit') {
    return { error: 'Demasiados intentos. Espera unos minutos.' };
  }
  return { error: 'No pudimos enviarte el código. Intenta de nuevo.' };
}

/**
 * One submission at a time. `pending` from useActionState only flips after React re-renders, so a fast double tap
 * can fire two submits; this gate closes synchronously on the first one and opens again when the answer arrives.
 */
export function submitGate() {
  let busy = false;
  return {
    enter(): boolean { if (busy) return false; busy = true; return true; },
    leave(): void { busy = false; },
    get busy() { return busy; },
  };
}

/** Show/hide state of a password field (type, button label, aria-pressed). */
export const revealState = (shown: boolean) => ({
  type: shown ? 'text' : 'password',
  label: shown ? 'Ocultar contraseña' : 'Mostrar contraseña',
  pressed: shown,
  icon: shown ? 'eyeOff' : 'eye',
} as const);
