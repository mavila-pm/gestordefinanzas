/**
 * CSP violation reports → one compact, safe log line each (pure; unit-tested). Reports are untrusted input from any
 * browser (or anyone with curl): only a few known fields are kept, URLs lose their query and fragment (auth links
 * carry token_hash), every value is truncated and stripped of control characters, and at most MAX_REPORTS are read
 * from one request.
 */
export const MAX_REPORT_BYTES = 8 * 1024;
export const MAX_REPORTS = 5;
const MAX_FIELD = 200;

export interface CspViolation {
  document: string | null;
  blocked: string | null;
  directive: string | null;
  disposition: string | null;
  source: string | null;
  line: number | null;
  column: number | null;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL, '').slice(0, MAX_FIELD);
  return s || null;
}

/** Keeps scheme + host + path of a URL; CSP keywords ('inline', 'eval', 'wasm-eval', 'self', …) pass unchanged. */
export function safeReportUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const raw = v.replace(CONTROL, '');
  if (/^[a-z][a-z-]{0,30}$/i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return u.protocol.slice(0, -1);
    return clean(`${u.protocol}//${u.host}${u.pathname}`);
  } catch {
    return clean(raw.split(/[?#]/)[0]);
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e7 ? v : null);

function pick(body: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (body[k] !== undefined) return body[k];
  return undefined;
}

function violation(body: unknown): CspViolation | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const v: CspViolation = {
    document: safeReportUrl(pick(b, 'documentURL', 'document-uri')),
    blocked: safeReportUrl(pick(b, 'blockedURL', 'blocked-uri')),
    directive: clean(pick(b, 'effectiveDirective', 'effective-directive', 'violated-directive')),
    disposition: clean(pick(b, 'disposition')),
    source: safeReportUrl(pick(b, 'sourceFile', 'source-file')),
    line: num(pick(b, 'lineNumber', 'line-number')),
    column: num(pick(b, 'columnNumber', 'column-number')),
  };
  return v.directive || v.blocked ? v : null;
}

/**
 * Accepts the two browser formats: report-uri (`{"csp-report": {...}}`, application/csp-report) and the Reporting
 * API (`[{"type": "csp-violation", "body": {...}}]`, application/reports+json). Anything else → [].
 */
export function parseCspReports(raw: string): CspViolation[] {
  if (!raw || raw.length > MAX_REPORT_BYTES) return [];
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  let bodies: unknown[] = [];
  if (Array.isArray(data)) {
    bodies = data
      .filter((r): r is { type: string; body?: unknown } => !!r && typeof r === 'object' && (r as { type?: unknown }).type === 'csp-violation')
      .map((r) => r.body);
  } else if (data && typeof data === 'object' && 'csp-report' in data) {
    bodies = [(data as Record<string, unknown>)['csp-report']];
  }
  return bodies.slice(0, MAX_REPORTS).map(violation).filter((v): v is CspViolation => v !== null);
}

/** Log lines per minute per server instance for /api/csp-report (the endpoint is public and has no other limit). */
export const CSP_LOG_LINES_PER_WINDOW = 20;
export const CSP_LOG_WINDOW_MS = 60_000;

export type CspLogLine = ({ event: 'csp_violation' } & CspViolation) | { event: 'csp_violation_dropped'; count: number };

/**
 * Log volume guard for the public report endpoint: within a window each distinct directive + blocked pair is logged
 * once, and at most `maxLines` pairs per window; everything else is only counted, and the count is logged once when
 * the next window starts. A script posting in a loop therefore costs at most `maxLines` + 1 lines per minute per
 * instance, and a real violation already seen in the window is not repeated. Memory stays bounded by `maxLines`.
 */
export function cspLogLimiter(maxLines = CSP_LOG_LINES_PER_WINDOW, windowMs = CSP_LOG_WINDOW_MS) {
  let start = Number.NEGATIVE_INFINITY;
  let seen = new Set<string>();
  let dropped = 0;
  return (violations: CspViolation[], now: number): CspLogLine[] => {
    const out: CspLogLine[] = [];
    if (now - start >= windowMs) {
      if (dropped > 0) out.push({ event: 'csp_violation_dropped', count: dropped });
      start = now;
      seen = new Set();
      dropped = 0;
    }
    for (const v of violations) {
      const key = `${v.directive ?? ''}\u0000${v.blocked ?? ''}`;
      if (seen.has(key) || seen.size >= maxLines) { dropped++; continue; }
      seen.add(key);
      out.push({ event: 'csp_violation', ...v });
    }
    return out;
  };
}

/**
 * Reads at most `limit` bytes of a request body (the Content-Length header may be absent or lie). Returns null when
 * the body is larger: the caller answers 413 without buffering the rest.
 */
export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}
