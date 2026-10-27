import { describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import config from '../next.config';
import { HSTS, isHttps } from '../src/web/security-headers';

/**
 * Security headers: the static list in next.config.ts (every path) and the per-request ones added by proxy.ts
 * (HSTS only over https). The Supabase session refresh is stubbed: this file is about headers only.
 */
vi.mock('../lib/supabase/proxy', () => ({ updateSession: async (request: NextRequest) => NextResponse.next({ request }) }));

describe('next.config.ts headers()', () => {
  it('every path carries the frame, sniffing, referrer, permissions and opener policies; x-powered-by is off', async () => {
    expect(config.poweredByHeader).toBe(false);
    const rules = await config.headers!();
    const all = rules.find((r) => r.source === '/:path*' && !r.has && !r.missing);
    expect(all).toBeDefined();
    const h = Object.fromEntries(all!.headers.map(({ key, value }) => [key.toLowerCase(), value]));
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    // HSTS needs the scheme of the request: it is the proxy's job, never sent unconditionally from here.
    expect(h['strict-transport-security']).toBeUndefined();
  });
});

describe('HSTS (proxy.ts)', () => {
  it('value: at least one year, subdomains included', () => {
    const maxAge = Number(/max-age=(\d+)/.exec(HSTS)?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
    expect(HSTS).toContain('includeSubDomains');
  });

  it('https is read from x-forwarded-proto (first hop) or, without it, from the URL', () => {
    expect(isHttps('https', 'http:')).toBe(true);
    expect(isHttps('https, http', 'http:')).toBe(true);
    expect(isHttps('http', 'https:')).toBe(false);
    expect(isHttps(null, 'https:')).toBe(true);
    expect(isHttps(undefined, 'http:')).toBe(false);
  });

  it('an https request gets Strict-Transport-Security; plain http (local dev) does not', async () => {
    const { proxy } = await import('../proxy');
    const secure = await proxy(new NextRequest('https://velsuno.example/login', { headers: { 'x-forwarded-proto': 'https' } }));
    expect(secure.headers.get('strict-transport-security')).toBe(HSTS);
    const local = await proxy(new NextRequest('http://localhost:3000/login'));
    expect(local.headers.get('strict-transport-security')).toBeNull();
  });
});
