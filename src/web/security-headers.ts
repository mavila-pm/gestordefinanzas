/**
 * Response security headers decided per request (pure; unit-tested). The static ones (frame, sniffing, referrer,
 * permissions, COOP) live in next.config.ts; proxy.ts adds these to every response it handles.
 */

/**
 * HSTS: two years, subdomains included, no preload (preload is a separate, hard-to-undo owner decision). Before the
 * production apex domain: the owner checks that no subdomain must stay http (e.g. an email click-tracking CNAME), since
 * includeSubDomains forces https on all of them (ADR-0018).
 */
export const HSTS = 'max-age=63072000; includeSubDomains';

/**
 * Only answers that really travelled over https carry HSTS (browsers ignore it on http anyway; this keeps local
 * http servers clean). Vercel terminates TLS and forwards the scheme in x-forwarded-proto.
 */
export function isHttps(forwardedProto: string | null | undefined, protocol: string): boolean {
  const first = forwardedProto?.split(',')[0]?.trim().toLowerCase();
  return first ? first === 'https' : protocol === 'https:';
}

// ── Content-Security-Policy (REPORT-ONLY) ───────────────────────────────────────────────────────────────────────
/**
 * Report-only on purpose: browsers report violations to CSP_REPORT_PATH and block nothing. Switching to the
 * enforcing header is a separate step, once the reports from Preview are clean (ADR-0018).
 */
export const CSP_HEADER = 'Content-Security-Policy-Report-Only';
export const CSP_REPORT_PATH = '/api/csp-report';
/** Reporting API group name (Reporting-Endpoints header); report-uri stays for browsers without it. */
export const CSP_REPORT_GROUP = 'csp-endpoint';
export const REPORTING_ENDPOINTS = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;

/** Culqi (card checkout, planned): its script, iframe and API hosts are allowed ahead of time. */
export const CULQI_HOSTS = ['https://checkout.culqi.com', 'https://js.culqi.com', 'https://*.culqi.com'] as const;

const NONCE_RE = /^[A-Za-z0-9+/]{22,}={0,2}$/;

/** 128 random bits, base64: a fresh nonce for every request (Web Crypto: works in the proxy and in Node). */
export function cspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The policy. Scripts: only those carrying this request's nonce (Next.js tags its own; app/layout.tsx tags the theme
 * script) and what they load ('strict-dynamic'); 'wasm-unsafe-eval' for the Cap solver; host entries are only the
 * fallback for browsers without strict-dynamic. Styles stay 'unsafe-inline' (React style attributes, Cap's shadow
 * DOM). Workers: Cap runs its solver in a blob: worker. dev adds 'unsafe-eval' (React refresh), never in production.
 */
export function buildCsp(nonce: string, opts: { dev?: boolean } = {}): string {
  if (!NONCE_RE.test(nonce)) throw new Error('invalid CSP nonce');
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'", ...(opts.dev ? ["'unsafe-eval'"] : []), ...CULQI_HOSTS]],
    ['style-src', ["'self'", "'unsafe-inline'", ...CULQI_HOSTS]],
    ['img-src', ["'self'", 'data:', 'blob:', ...CULQI_HOSTS]],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", ...CULQI_HOSTS]],
    ['frame-src', [...CULQI_HOSTS]],
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['report-uri', [CSP_REPORT_PATH]],
    ['report-to', [CSP_REPORT_GROUP]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}
