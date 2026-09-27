/** Pure, framework-agnostic validation for auth forms (unit-tested). */

export const PASSWORD_MIN = 8;
/** bcrypt (Supabase Auth) ignores bytes beyond 72. */
export const PASSWORD_MAX = 72;

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function parseEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

export function passwordProblem(v: unknown): string | null {
  if (typeof v !== 'string') return 'Ingresa una contraseña.';
  if (v.length < PASSWORD_MIN) return `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.`;
  if (new TextEncoder().encode(v).length > PASSWORD_MAX) return `La contraseña no puede superar ${PASSWORD_MAX} caracteres.`;
  return null;
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
