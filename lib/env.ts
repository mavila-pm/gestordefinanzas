/**
 * Public Supabase config. Only the URL and the PUBLISHABLE key may reach the browser.
 * The service role key must never be referenced from this app (see CLAUDE.md).
 */
export function supabasePublicEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  if (/service_role|sb_secret_/i.test(key)) throw new Error('Refusing to use a secret/service key as the public key');
  return { url, key };
}

/**
 * Base URL for auth email links. Explicit NEXT_PUBLIC_SITE_URL wins; on a Vercel preview it falls back to the
 * stable branch URL (a Vercel system variable, not request input), so links never point at localhost.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.NEXT_PUBLIC_SITE_URL) return env.NEXT_PUBLIC_SITE_URL;
  if (env.VERCEL_ENV === 'preview' && env.VERCEL_BRANCH_URL) return `https://${env.VERCEL_BRANCH_URL}`;
  return 'http://localhost:3000';
}
