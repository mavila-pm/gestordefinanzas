import { describe, expect, it } from 'vitest';
import { siteUrl } from '../lib/env';

describe('siteUrl (auth email link base)', () => {
  it('explicit NEXT_PUBLIC_SITE_URL wins', () => {
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: 'https://app.example.pe', VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'x.vercel.app' })).toBe('https://app.example.pe');
  });
  it('Vercel preview falls back to the stable branch URL', () => {
    expect(siteUrl({ VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'gestordefinanzas-git-b-team.vercel.app' })).toBe('https://gestordefinanzas-git-b-team.vercel.app');
  });
  it('outside a preview it never uses Vercel vars; defaults to localhost', () => {
    expect(siteUrl({ VERCEL_ENV: 'production', VERCEL_BRANCH_URL: 'x.vercel.app' })).toBe('http://localhost:3000');
    expect(siteUrl({})).toBe('http://localhost:3000');
  });
});
