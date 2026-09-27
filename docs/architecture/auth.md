# Authentication (Supabase Auth + Next.js 16)

- Identity: Supabase Auth (email + password). Plans/entitlements are a separate layer (not yet built).
- Session: `@supabase/ssr` cookies. `proxy.ts` refreshes the session on every request and redirects
  `/app/*` to `/login` when `auth.getUser()` (server-validated JWT) returns no user. `app/app/layout.tsx`
  re-validates on every protected render (defense in depth).
- Data access from the app uses the **publishable key + the user's session**: every query is subject to RLS.
  The service role key is not used by the web app and must never be.
- Server actions (`app/auth/actions.ts`): login, signup, logout, password reset request, password update.
  Messages never reveal whether an email is registered. Password 8–72 chars (bcrypt limit).
- Email links land on `/auth/confirm`, which accepts `token_hash`+`type` (works across devices) or `code` (PKCE,
  same browser only). `next` is restricted to same-origin paths (open-redirect guard, unit-tested).
- Security headers: X-Frame-Options DENY, nosniff, strict referrer, restrictive Permissions-Policy.

## Supabase dashboard settings (manual, Product Owner) — Authentication section
| Setting | Value | Why |
|---|---|---|
| URL Configuration → Site URL | `http://localhost:3000` now; production domain later | base for email links |
| URL Configuration → Redirect URLs | `http://localhost:3000/auth/confirm` (+ Vercel preview/prod later) | links outside this list are rejected |
| Providers → Email → Minimum password length | 8 | matches app validation server-side in Supabase too |
| Email templates (Confirm signup, Reset password) | link `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/app` (signup) and `…&type=recovery&next=/reset-password` (reset) | cross-device links; optional, `code` flow works in the same browser |
| SMTP | default Supabase SMTP is rate-limited (beta only); custom SMTP before public launch | deliverability |
