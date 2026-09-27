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

export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
}
