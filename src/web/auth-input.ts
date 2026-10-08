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
 * Mobile number to E.164. A Peruvian mobile written without the country code (9 digits starting with 9) gets +51;
 * any other number must include its "+code". Spaces, dashes, dots and parentheses are ignored.
 */
export function normalizePhone(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const raw = v.trim().replace(/[\s().-]/g, '');
  const e164 = /^9\d{8}$/.test(raw) ? `+51${raw}` : raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
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

/** Today in America/Lima (UTC-5, no DST) as YYYY-MM-DD. */
export const limaToday = (now: Date = new Date()) => new Date(now.getTime() - 5 * 3600_000).toISOString().slice(0, 10);

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
