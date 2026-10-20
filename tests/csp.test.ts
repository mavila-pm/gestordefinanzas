import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { buildCsp, CSP_HEADER, CSP_REPORT_PATH, cspNonce, CULQI_HOSTS, REPORTING_ENDPOINTS } from '../src/web/security-headers';
import { MAX_REPORT_BYTES, MAX_REPORTS, parseCspReports, readLimited, safeReportUrl } from '../src/web/csp-report';

/**
 * Content-Security-Policy, REPORT-ONLY in this block: a per-request nonce from proxy.ts, the policy string, and the
 * public /api/csp-report endpoint (untrusted input: size-limited, sanitised, one structured log line per report).
 */

const directives = (csp: string) => Object.fromEntries(csp.split('; ').map((d) => { const [k, ...v] = d.split(' '); return [k, v]; }));

describe('cspNonce', () => {
  it('128-bit base64, different every time', () => {
    const a = cspNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(new Set(Array.from({ length: 50 }, cspNonce)).size).toBe(50);
  });
});

describe('buildCsp', () => {
  const nonce = 'AAAAAAAAAAAAAAAAAAAAAA==';
  it('production policy: nonce + strict-dynamic scripts, wasm for Cap, nothing framed, reports to /api/csp-report', () => {
    const d = directives(buildCsp(nonce));
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['script-src']).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'", ...CULQI_HOSTS]);
    expect(d['script-src']).not.toContain("'unsafe-eval'");
    expect(d['script-src']).not.toContain("'unsafe-inline'");
    expect(d['style-src']).toEqual(["'self'", "'unsafe-inline'", ...CULQI_HOSTS]);
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:', ...CULQI_HOSTS]);
    expect(d['font-src']).toEqual(["'self'"]);
    expect(d['connect-src']).toEqual(["'self'", ...CULQI_HOSTS]);
    expect(d['worker-src']).toEqual(["'self'", 'blob:']);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
    expect(d['form-action']).toEqual(["'self'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['report-uri']).toEqual([CSP_REPORT_PATH]);
    expect(d['report-to']).toEqual(['csp-endpoint']);
    expect(REPORTING_ENDPOINTS).toBe('csp-endpoint="/api/csp-report"');
  });

  it('Culqi checkout (planned) is allowed ahead of time: script, iframe and API hosts', () => {
    const d = directives(buildCsp(nonce));
    for (const host of ['https://checkout.culqi.com', 'https://js.culqi.com', 'https://*.culqi.com']) {
      expect(d['script-src']).toContain(host);
      expect(d['frame-src']).toContain(host);
      expect(d['connect-src']).toContain(host);
    }
  });

  it("dev adds 'unsafe-eval' (React refresh) and nothing else", () => {
    const prod = directives(buildCsp(nonce));
    const dev = directives(buildCsp(nonce, { dev: true }));
    expect(dev['script-src']).toEqual([...prod['script-src']!.slice(0, 4), "'unsafe-eval'", ...CULQI_HOSTS]);
  });

  it('refuses a nonce that could break out of the header', () => {
    expect(() => buildCsp("abc'; script-src *")).toThrow();
    expect(() => buildCsp('')).toThrow();
  });
});

// ── proxy.ts with the Supabase session refresh stubbed ───────────────────────────────────────────────────────
let forwarded: Headers | null = null;
vi.mock('../lib/supabase/proxy', () => ({
  updateSession: async (request: NextRequest) => { forwarded = new Headers(request.headers); return NextResponse.next({ request }); },
}));

describe('proxy.ts: report-only CSP with a per-request nonce', () => {
  it('the response carries the report-only policy (never the enforcing header) and the Reporting-Endpoints group', async () => {
    const { proxy } = await import('../proxy');
    const res = await proxy(new NextRequest('https://velsuno.example/login'));
    const csp = res.headers.get(CSP_HEADER);
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic'/);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('reporting-endpoints')).toBe(REPORTING_ENDPOINTS);
  });

  it('the app sees the same nonce (x-nonce + request CSP header, which Next.js reads to tag its scripts); client values are replaced', async () => {
    const { proxy } = await import('../proxy');
    const res = await proxy(new NextRequest('https://velsuno.example/app', {
      headers: { 'x-nonce': 'attacker', 'content-security-policy': "script-src 'nonce-attacker'" },
    }));
    const nonce = forwarded!.get('x-nonce')!;
    expect(nonce).not.toBe('attacker');
    expect(forwarded!.get('content-security-policy')).toBeNull();
    expect(forwarded!.get('content-security-policy-report-only')).toBe(res.headers.get(CSP_HEADER));
    expect(res.headers.get(CSP_HEADER)).toContain(`'nonce-${nonce}'`);
    // Next.js forwards the overridden request headers to the render through x-middleware-request-*.
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
  });

  it('a new nonce on every request', async () => {
    const { proxy } = await import('../proxy');
    const a = (await proxy(new NextRequest('https://velsuno.example/login'))).headers.get(CSP_HEADER);
    const b = (await proxy(new NextRequest('https://velsuno.example/login'))).headers.get(CSP_HEADER);
    expect(a).not.toBe(b);
  });
});

// ── Report parsing (pure) ────────────────────────────────────────────────────────────────────────────────────
describe('parseCspReports', () => {
  it('report-uri format: known fields only, the URL query (token_hash) is dropped', () => {
    const raw = JSON.stringify({ 'csp-report': {
      'document-uri': 'https://velsuno.example/auth/confirm?token_hash=SECRET&type=email#x',
      'blocked-uri': 'inline', 'effective-directive': 'script-src-elem', disposition: 'report',
      'source-file': 'https://velsuno.example/_next/static/chunks/app.js?v=SECRET', 'line-number': 12, 'column-number': 7,
      'script-sample': 'alert(document.cookie)', 'original-policy': 'default-src …',
    } });
    const [v, ...rest] = parseCspReports(raw);
    expect(rest).toEqual([]);
    expect(v).toEqual({
      document: 'https://velsuno.example/auth/confirm', blocked: 'inline', directive: 'script-src-elem', disposition: 'report',
      source: 'https://velsuno.example/_next/static/chunks/app.js', line: 12, column: 7,
    });
    expect(JSON.stringify(v)).not.toContain('SECRET');
    expect(JSON.stringify(v)).not.toContain('alert');
  });

  it('Reporting API format: only csp-violation entries, at most 5 per request', () => {
    const one = { type: 'csp-violation', body: { documentURL: 'https://velsuno.example/app', blockedURL: 'https://evil.example/x.js?q=1', effectiveDirective: 'script-src-elem', disposition: 'report', lineNumber: 1 } };
    const raw = JSON.stringify([{ type: 'deprecation', body: { id: 'x' } }, ...Array.from({ length: 8 }, () => one)]);
    const out = parseCspReports(raw);
    expect(out).toHaveLength(MAX_REPORTS);
    expect(out[0]).toMatchObject({ document: 'https://velsuno.example/app', blocked: 'https://evil.example/x.js', directive: 'script-src-elem', line: 1, column: null, source: null });
  });

  it('garbage, wrong shapes and oversize input → nothing to log', () => {
    expect(parseCspReports('')).toEqual([]);
    expect(parseCspReports('not json')).toEqual([]);
    expect(parseCspReports('{"foo":1}')).toEqual([]);
    expect(parseCspReports('[1, null, "x", {"type":"csp-violation","body":[]}]')).toEqual([]);
    expect(parseCspReports(JSON.stringify({ 'csp-report': { disposition: 'report' } }))).toEqual([]);
    expect(parseCspReports(' '.repeat(MAX_REPORT_BYTES + 1))).toEqual([]);
  });

  it('values are truncated, control characters (log forging) removed, numbers validated', () => {
    const raw = JSON.stringify({ 'csp-report': { 'effective-directive': `script-src\n{"event":"forged"}${'x'.repeat(500)}`, 'blocked-uri': 'eval', 'line-number': -1, 'column-number': 1.5 } });
    const [v] = parseCspReports(raw);
    expect(v!.directive!.length).toBeLessThanOrEqual(200);
    expect(v!.directive).not.toContain('\n');
    expect(v!.line).toBeNull();
    expect(v!.column).toBeNull();
  });

  it('safeReportUrl: data:/blob: collapse to the scheme; keywords pass; relative paths lose the query', () => {
    expect(safeReportUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe('data');
    expect(safeReportUrl('blob:https://velsuno.example/123')).toBe('blob');
    expect(safeReportUrl('wasm-eval')).toBe('wasm-eval');
    expect(safeReportUrl('/app?x=1')).toBe('/app');
    expect(safeReportUrl(42)).toBeNull();
  });
});

describe('readLimited', () => {
  const stream = (text: string, chunk = 1000) => new ReadableStream<Uint8Array>({
    start(c) { const b = new TextEncoder().encode(text); for (let i = 0; i < b.length; i += chunk) c.enqueue(b.slice(i, i + chunk)); c.close(); },
  });
  it('returns the text under the limit, null above it (without reading everything)', async () => {
    expect(await readLimited(stream('hola ñandú'), 100)).toBe('hola ñandú');
    expect(await readLimited(stream('x'.repeat(5000)), 4096)).toBeNull();
    expect(await readLimited(null, 10)).toBe('');
  });
});

// ── The route ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('POST /api/csp-report', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request('https://velsuno.example/api/csp-report', { method: 'POST', body, headers: { 'content-type': 'application/csp-report', ...headers } });

  it('valid report → 204, one structured line per violation, no secrets', async () => {
    const { POST } = await import('../app/api/csp-report/route');
    const res = await POST(post(JSON.stringify({ 'csp-report': { 'document-uri': 'https://velsuno.example/reset-password?code=SECRET', 'blocked-uri': 'inline', 'effective-directive': 'script-src-elem', disposition: 'report' } })));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({ event: 'csp_violation', document: 'https://velsuno.example/reset-password', blocked: 'inline' });
    expect(line).not.toContain('SECRET');
  });

  it('oversize body → 413 and nothing logged (declared length or actual bytes)', async () => {
    const { POST } = await import('../app/api/csp-report/route');
    expect((await POST(post('{}', { 'content-length': String(MAX_REPORT_BYTES + 1) }))).status).toBe(413);
    expect((await POST(post(`{"csp-report":{"blocked-uri":"${'x'.repeat(MAX_REPORT_BYTES)}"}}`))).status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it('garbage → 204, nothing logged', async () => {
    const { POST } = await import('../app/api/csp-report/route');
    expect((await POST(post('<<<not json>>>'))).status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });
});
