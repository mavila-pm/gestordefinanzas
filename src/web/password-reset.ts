/**
 * Password-reset response policy (anti-enumeration, spec §86).
 *
 * Supabase answers /recover with 429 `over_email_send_rate_limit` only when it would actually send an email,
 * i.e. only for REGISTERED addresses; unknown addresses get 200 without sending. Surfacing the 429 would therefore
 * reveal which emails have an account. The user always gets the same neutral message; the error is kept only as
 * an internal diagnostic (no email address in it).
 */
export const RESET_SENT = 'Si existe una cuenta con ese correo, te enviamos un enlace para restablecer tu contraseña. Si no llega en unos minutos, revisa spam o inténtalo más tarde.';

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

/**
 * Registration starts with the email only (Supabase signInWithOtp, shouldCreateUser): new AND registered addresses
 * both receive a link (a registered one simply signs in and continues), so a rate limit or a sending failure does
 * not reveal whether the account exists and can be shown as is. The address is never logged.
 */
export type EmailLinkOutcome = { state: { sent?: true; error?: string }; diagnostic: { event: 'signup_link_failed'; status: number | null; code: string | null } | null };
export function emailLinkOutcome(error: { status?: number; code?: string } | null | undefined): EmailLinkOutcome {
  if (!error) return { state: { sent: true }, diagnostic: null };
  const status = typeof error.status === 'number' ? error.status : null;
  const code = typeof error.code === 'string' ? error.code : null;
  const diagnostic = { event: 'signup_link_failed' as const, status, code };
  if (status === 429 || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') {
    return { state: { error: 'Demasiados intentos. Espera un minuto y vuelve a intentarlo.' }, diagnostic };
  }
  if (code === 'email_address_invalid' || code === 'validation_failed') return { state: { error: 'Revisa tu correo electrónico.' }, diagnostic };
  return { state: { error: 'No pudimos enviar el correo. Intenta de nuevo en unos minutos.' }, diagnostic };
}

/** Supabase errors when saving the new password, in plain words (never the provider's text). */
export function newPasswordError(error: { status?: number; code?: string }): string {
  if (error.status === 429) return 'Demasiados intentos. Espera unos minutos.';
  if (error.code === 'same_password') return 'Usa una contraseña distinta a la anterior.';
  if (error.code === 'weak_password') return 'Esa contraseña es fácil de adivinar. Prueba con otra.';
  if (error.code === 'reauthentication_needed' || error.code === 'session_not_found' || error.status === 401) return 'Tu enlace venció. Pide uno nuevo para continuar.';
  return 'No pudimos guardar tu contraseña. Intenta de nuevo.';
}

/** complete_registration errors (SQL exception messages) to copy. */
export function registrationError(message: string | undefined): string {
  if (!message) return 'No pudimos guardar tus datos. Intenta de nuevo.';
  if (message.includes('under_age')) return 'Velsuno es para personas mayores de 18 años.';
  if (message.includes('phone_taken')) return 'Ese número ya está registrado en otra cuenta. Usa otro número o entra con esa cuenta.';
  if (message.includes('invalid_phone')) return 'Escribe tu celular de 9 dígitos. Empieza con 9.';
  if (message.includes('invalid_birth_date')) return 'Revisa tu fecha de nacimiento.';
  if (message.includes('invalid_name')) return 'Revisa tu nombre y apellidos.';
  if (message.includes('consent_version')) return 'Actualizamos los Términos o la Política de Privacidad. Recarga la página y vuelve a aceptarlos.';
  if (message.includes('password_step_pending')) return 'Primero crea tu contraseña.';
  return 'No pudimos guardar tus datos. Intenta de nuevo.';
}
