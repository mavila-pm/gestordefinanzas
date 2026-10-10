/** Pure, framework-agnostic validation for auth forms (unit-tested). */

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function parseEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/** New passwords (registration, reset): 12+ characters with at least one letter and one number. */
export const PASSWORD_MIN = 12;
/** bcrypt (Supabase Auth) ignores bytes beyond 72: longer passwords are refused, never silently truncated. */
export const PASSWORD_MAX = 72;
export const PASSWORD_HINT = 'Usa al menos 12 caracteres con letras y números.';

export function passwordProblem(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return 'Escribe una contraseña.';
  if (v.length < PASSWORD_MIN) return `Usa al menos ${PASSWORD_MIN} caracteres.`;
  if (!/\p{L}/u.test(v) || !/\p{N}/u.test(v)) return 'Combina letras y números.';
  if (new TextEncoder().encode(v).length > PASSWORD_MAX) return 'Es demasiado larga. Usa una más corta.';
  return null;
}

/**
 * Peruvian mobile only (registration is Peru-only): the person types the 9 digits (starting with 9) after a fixed +51.
 * Spaces are tolerated; anything else (letters, symbols, another country, a missing or extra digit) is refused.
 * Returns E.164 (+519XXXXXXXX) or null.
 */
export function normalizePhone(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const digits = v.replace(/ /g, '');
  return /^9\d{8}$/.test(digits) ? `+51${digits}` : null;
}

export const PHONE_ERROR = 'Escribe tu celular de 9 dígitos. Empieza con 9.';
export const UNDER_AGE_ERROR = 'Velsuno es para personas mayores de 18 años.';
export const BIRTH_ERROR = 'Revisa tu fecha de nacimiento.';

/** Birth date problem for the profile step (Lima calendar, exact day): null when valid and 18+. */
export function birthProblem(v: unknown, today: string): string | null {
  const birth = parseBirthDate(v);
  if (!birth || birth > today) return BIRTH_ERROR;
  return ageOn(birth, today) >= 18 ? null : UNDER_AGE_ERROR;
}

/** ISO date (YYYY-MM-DD) that exists on the calendar, or null. */
export function parseBirthDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '1900-01-01' ? v : null;
}

/** Full years between a birth date and a day (both YYYY-MM-DD). The database applies the same rule (Lima calendar). */
export function ageOn(birth: string, today: string): number {
  const [by, bm, bd] = birth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** Only same-origin relative paths; blocks open redirects ("//evil.com", "https://…", "/\\evil"). */
export function safeNextPath(v: unknown, fallback = '/app'): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return fallback;
  if (/[\r\n]/.test(v)) return fallback;
  return v;
}

/** Current month in America/Lima (UTC-5, no DST) as YYYY-MM. */
export function limaMonth(now: Date = new Date()): string {
  return new Date(now.getTime() - 5 * 3600_000).toISOString().slice(0, 7);
}

/** [start, end) instants of a Lima calendar month. Returns null for malformed input. */
export function limaMonthRange(month: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const from = new Date(Date.UTC(y, mo - 1, 1, 5));
  const to = new Date(Date.UTC(y, mo, 1, 5));
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Where to go after an email link lands on /auth/confirm. Set by the signup / password-reset actions because the
 * callback URL itself must stay query-free (see lib/env.ts authCallbackUrl). httpOnly, short-lived, scoped to /auth.
 */
export const AUTH_NEXT_COOKIE = 'gf_auth_next';

export function authNextCookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/auth', maxAge: 60 * 60 };
}

/** A `next` query param (token_hash email templates) wins; else the cookie; always same-origin, default /app. */
export function resolveAuthNext(queryNext: unknown, cookieNext: unknown, type?: unknown): string {
  // A recovery link always ends on the password form, whatever next/cookie say (cross-device: no cookie there).
  if (type === 'recovery') return '/reset-password';
  if (typeof queryNext === 'string' && queryNext) return safeNextPath(queryNext);
  return safeNextPath(cookieNext);
}
