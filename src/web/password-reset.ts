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
