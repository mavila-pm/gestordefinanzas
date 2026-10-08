# Authentication (Supabase Auth + Next.js 16)

- Identity: Supabase Auth (email + password). **Registration (block 042) is email-first**: `/signup` asks only the
  email → `signInWithOtp` (Supabase signs, expires and single-uses the link; no custom tokens) → `/auth/confirm` →
  `/crear-cuenta` → password (12+, letters + numbers, ≤ 72 bytes) → profile (names, E.164 phone, birth date 18+,
  Terms + Privacy acceptance of the current versions) → `/bienvenida`. Steps are decided in SQL (`my_registration`,
  `complete_registration`, migration 029; the password step by the trigger `on_auth_password_changed`, 031); `lib/registration.ts` gates `/app` and `/bienvenida`
  pages and `lib/supabase/proxy.ts` refuses POSTs from unfinished accounts (403). Accounts created before
  2026-10-08 05:00 UTC are grandfathered. Emails, SMTP and dashboard settings: `docs/runbooks/auth-email.md`.
- Session: `@supabase/ssr` cookies. `proxy.ts` refreshes the session on every request and redirects
  `/app/*` to `/login` when `auth.getUser()` (server-validated JWT) returns no user. `app/app/layout.tsx`
  re-validates on every protected render (defense in depth).
- Data access from the app uses the **publishable key + the user's session**: every query is subject to RLS.
  The service role key is not used by the web app and must never be.
- Server actions (`app/auth/actions.ts`): login, signup, logout, password reset request, password update.
  Messages never reveal whether an email is registered. New passwords 12–72 bytes with letters and numbers (bcrypt limit; longer is refused, never truncated).
- A `type=recovery` link always lands on `/reset-password`, whatever `next` or the cookie say (TASK-015).
- Email links land on `/auth/confirm`, which accepts `token_hash`+`type` (works across devices) or `code` (PKCE,
  same browser only). `next` is restricted to same-origin paths (open-redirect guard, unit-tested).
- `emailRedirectTo` / `redirectTo` are EXACTLY `<site>/auth/confirm` (`authCallbackUrl()`), with no query string:
  Supabase matches the redirect against the Redirect URLs allow list as a whole string, and an unmatched redirect
  silently falls back to the Site URL (root cause of the 2026-09-27 Preview failure: `…/auth/confirm?next=/app`
  vs entry `…/auth/confirm` → `http://localhost:3000/?code=…`). The destination after the link (`/app` or
  `/reset-password`) is kept in the httpOnly cookie `gf_auth_next` (path `/auth`, 1 h, consumed on success).
- Password recovery always answers with the same neutral message (`src/web/password-reset.ts`). Supabase returns
  429 `over_email_send_rate_limit` only for REGISTERED emails (unknown ones get 200 and no email), so surfacing it
  would enumerate accounts. The failure is logged server-side as `password_reset_request_failed` (status + code,
  never the email). Test: `tests/password-reset.test.ts` (action-level, Supabase stubbed, no emails).
- Built-in Supabase SMTP: project-wide hourly email cap shared by /signup, /recover and /user (observed: the 3rd
  email within an hour was refused on 2026-09-27). Custom SMTP required before public launch (spec §78/§86).
- Security headers: X-Frame-Options DENY, nosniff, strict referrer, restrictive Permissions-Policy.

## Supabase dashboard settings (manual, Product Owner) — Authentication section
| Setting | Value | Why |
|---|---|---|
| URL Configuration → Site URL | `http://localhost:3000` now; production domain later | base for email links |
| URL Configuration → Redirect URLs | `http://localhost:3000/auth/confirm` (+ Vercel preview/prod later) | links outside this list are rejected |
| Providers → Email → Minimum password length | 12, letters and digits | matches app validation server-side in Supabase too |
| Email templates (Confirm signup, Reset password) | link `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/app` (signup) and `…&type=recovery&next=/reset-password` (reset) | cross-device links; optional, `code` flow works in the same browser |
| SMTP | default Supabase SMTP is rate-limited (beta only); custom SMTP before public launch | deliverability |
