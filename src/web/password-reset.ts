/**
 * Password-reset response policy (anti-enumeration, spec §86).
 *
 * Supabase answers /recover with 429 `over_email_send_rate_limit` only when it would actually send an email,
 * i.e. only for REGISTERED addresses; unknown addresses get 200 without sending. Surfacing the 429 would therefore
 * reveal which emails have an account. The user always gets the same neutral message; the error is kept only as
 * an internal diagnostic (no email address in it).
 */
export const RESET_SENT = 'Si existe una cuenta con ese correo, te enviamos un enlace para restablecer tu contraseña.';

export interface ResetDiagnostic {
  event: 'password_reset_request_failed';
  status: number | null;
  code: string | null;
}

export interface ResetOutcome {
  state: { message: string };
  diagnostic: ResetDiagnostic | null;
}

export function passwordResetOutcome(error: { status?: number; code?: string } | null | undefined): ResetOutcome {
  return {
    state: { message: RESET_SENT },
    diagnostic: error
      ? { event: 'password_reset_request_failed', status: typeof error.status === 'number' ? error.status : null, code: typeof error.code === 'string' ? error.code : null }
      : null,
  };
}

export const SIGNUP_SENT = 'Si el correo es válido, te enviamos un enlace para confirmar tu cuenta.';

/**
 * Signup has the mirror-image side channel: when the email cap is exhausted, a NEW address gets 429 (Supabase
 * would send a confirmation) while an already registered one gets 200 (nothing is sent). Same neutral answer for
 * both; only a weak password (a property of the input, not of the account) is reported.
 */
export function signupOutcome(error: { status?: number; code?: string } | null | undefined): { state: { message?: string; error?: string }; diagnostic: (Omit<ResetDiagnostic, 'event'> & { event: 'signup_request_failed' }) | null } {
  if (error?.code === 'weak_password') return { state: { error: 'La contraseña es demasiado débil.' }, diagnostic: null };
  return {
    state: { message: SIGNUP_SENT },
    diagnostic: error
      ? { event: 'signup_request_failed', status: typeof error.status === 'number' ? error.status : null, code: typeof error.code === 'string' ? error.code : null }
      : null,
  };
}
