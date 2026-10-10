import { describe, expect, it } from 'vitest';
import { authCallbackUrl, siteUrl } from '../lib/env';
import { resolveAuthNext } from '../src/web/auth-input';

const PREVIEW = {
  VERCEL_ENV: 'preview',
  VERCEL_BRANCH_URL: 'gestordefinanzas-git-claude-beautifu-cb0485-mavila-pms-projects.vercel.app',
  VERCEL_URL: 'gestordefinanzas-6lugr5s3s-mavila-pms-projects.vercel.app',
};

describe('siteUrl (auth email link base)', () => {
  it('explicit NEXT_PUBLIC_SITE_URL wins (trailing slash removed)', () => {
    expect(siteUrl({ ...PREVIEW, NEXT_PUBLIC_SITE_URL: 'https://app.example.pe/' })).toBe('https://app.example.pe');
  });
  it('Vercel preview uses the stable branch URL, never the per-commit URL nor localhost', () => {
    expect(siteUrl(PREVIEW)).toBe(`https://${PREVIEW.VERCEL_BRANCH_URL}`);
  });
  it('Vercel preview without a branch URL falls back to the deployment URL, not localhost', () => {
    expect(siteUrl({ VERCEL_ENV: 'preview', VERCEL_URL: PREVIEW.VERCEL_URL })).toBe(`https://${PREVIEW.VERCEL_URL}`);
  });
  it('production uses the production domain, never a branch URL; explicit NEXT_PUBLIC_SITE_URL still wins', () => {
    expect(siteUrl({ VERCEL_ENV: 'production', VERCEL_BRANCH_URL: 'x.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'velsuno.pe' })).toBe('https://velsuno.pe');
    expect(siteUrl({ VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'velsuno.pe', NEXT_PUBLIC_SITE_URL: 'https://app.velsuno.pe' })).toBe('https://app.velsuno.pe');
  });
  it('without Vercel vars it defaults to localhost', () => {
    expect(siteUrl({ VERCEL_ENV: 'production', VERCEL_BRANCH_URL: 'x.vercel.app' })).toBe('http://localhost:3000');
    expect(siteUrl({})).toBe('http://localhost:3000');
  });
});

describe('authCallbackUrl (emailRedirectTo / redirectTo)', () => {
  // Regression (TASK-003 manual test, 2026-09-27): "/auth/confirm?next=/app" did not match the Supabase Redirect
  // URL entry ".../auth/confirm" (matched as a whole string), so Supabase fell back to Site URL = localhost.
  it('is exactly <site>/auth/confirm with no query string or fragment, matching the allow-list entry', () => {
    const url = authCallbackUrl(PREVIEW);
    expect(url).toBe(`https://${PREVIEW.VERCEL_BRANCH_URL}/auth/confirm`);
    expect(new URL(url).search).toBe('');
    expect(new URL(url).hash).toBe('');
    expect(url).not.toContain('localhost');
  });
  it('local development keeps the localhost callback', () => {
    expect(authCallbackUrl({})).toBe('http://localhost:3000/auth/confirm');
  });
});

describe('resolveAuthNext (destination after the email link)', () => {
  it('a recovery link always lands on the password form (cross-device, no cookie; next cannot redirect it)', () => {
    expect(resolveAuthNext(null, undefined, 'recovery')).toBe('/reset-password');
    expect(resolveAuthNext('/app', '/app', 'recovery')).toBe('/reset-password');
    expect(resolveAuthNext('https://evil.example', undefined, 'email')).toBe('/app');
  });
  it('uses the remembered cookie: signup -> /app, recovery -> /reset-password', () => {
    expect(resolveAuthNext(null, '/app')).toBe('/app');
    expect(resolveAuthNext(null, '/reset-password')).toBe('/reset-password');
  });
  it('an explicit next query param (token_hash templates) wins over the cookie', () => {
    expect(resolveAuthNext('/reset-password', '/app')).toBe('/reset-password');
  });
  it('defaults to /app and blocks open redirects from either source', () => {
    expect(resolveAuthNext(null, undefined)).toBe('/app');
    expect(resolveAuthNext('//evil.com', '/reset-password')).toBe('/app');
    expect(resolveAuthNext(null, 'https://evil.com')).toBe('/app');
    expect(resolveAuthNext('', '/\\evil.com')).toBe('/app');
  });
});
