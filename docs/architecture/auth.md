# Authentication (Supabase Auth + Next.js 16)

- Identity: Supabase Auth (email + password). **Registration (block 042) is email-first**: `/signup` asks only the
  email → `signInWithOtp` (Supabase signs, expires and single-uses the link; no custom tokens) → `/auth/confirm` →
  `/crear-cuenta` → password (12+, letters + numbers, ≤ 72 bytes) → profile (names, E.164 phone, birth date 18+,
  Terms + Privacy acceptance of the current versions) → `/bienvenida`. Steps are decided in SQL (`my_registration`,
  `finish_registration`, migration 049, which replaced `complete_registration` of 029: final once complete, capped
  `phone_taken` answers; the password step by the trigger `on_auth_password_changed`, 031); `lib/registration.ts` gates `/app` and `/bienvenida`
  pages and `lib/supabase/proxy.ts` refuses POSTs from unfinished accounts (403). Accounts created before
  2026-10-08 05:00 UTC are grandfathered. Emails, SMTP and dashboard settings: `docs/runbooks/auth-email.md`.
- Session: `@supabase/ssr` cookies, `httpOnly`, `Secure` in production, `SameSite=Lax` (`authCookieOptions()`, ADR-0017).
  `proxy.ts` refreshes the session on every request and redirects `/app/*` and `/bienvenida` to `/login` when
  `auth.getClaims()` (JWT signature checked locally, ES256) has no user; `app/app/layout.tsx` re-validates on every
  protected render (defense in depth). Password flows keep `getUser()`. A revoked access token stays valid until it
  expires (default 1 h): accepted.
- Data access from the app uses the **publishable key + the user's session**: every query is subject to RLS.
  The service role key is not used by the web app and must never be.
- Server actions (`app/auth/actions.ts`): login, signup, logout, password reset request, password update.
  Messages never reveal whether an email is registered. New passwords 12–72 bytes with letters and numbers (bcrypt limit; longer is refused, never truncated).
  `logout` signs out this device only (`scope: 'local'`); a new password from a recovery link signs out the other
  devices (`scope: 'others'`). Login: Cap, then the lockout counter, then Supabase (ADR-0016; the lock text offers
  the email link and recovery).
- Signed-in password change (Ajustes → Cuenta, `changePassword`, `src/web/password-change.ts`): same rules as new
  passwords; `getUser()` → `updateUser({ password })`. If Supabase answers `reauthentication_needed` ("Secure password
  change" on + session older than 24 h), `reauthenticate()` emails a code and the next submit sends it as `nonce`.
  Success signs out other sessions (`signOut({ scope: 'others' })`). The app never checks the current password itself.
- A `type=recovery` link always lands on `/reset-password`, whatever `next` or the cookie say (TASK-015).
- Email links land on `/auth/confirm`, which accepts `token_hash`+`type` (works across devices) or `code` (PKCE,
  same browser only). `next` is restricted to same-origin paths (open-redirect guard, unit-tested).
- `emailRedirectTo` / `redirectTo` are EXACTLY `<site>/auth/confirm` (`authCallbackUrl()`), with no query string:
  Supabase matches the redirect against the Redirect URLs allow list as a whole string, and an unmatched redirect
  silently falls back to the Site URL (root cause of the 2026-09-27 Preview failure: `…/auth/confirm?next=/app`
  vs entry `…/auth/confirm` → `http://localhost:3000/?code=…`). The destination after the link (`/crear-cuenta` or
  `/reset-password`) is kept in the httpOnly cookie `gf_auth_next` (path `/auth`, 1 h, consumed on success).
  Signing up again with a registered address sends Supabase's Magic Link ("Si ya tenías cuenta…"); the link enters
  the account, which shows a one-time "Ya tenías una cuenta" notice on `/app` (`/signup` answers the same either way).
- Password recovery always answers with the same neutral message (`src/web/password-reset.ts`). Supabase returns
  429 `over_email_send_rate_limit` only for REGISTERED emails (unknown ones get 200 and no email), so surfacing it
  would enumerate accounts. The failure is logged server-side as `password_reset_request_failed` (status + code,
  never the email). Test: `tests/password-reset.test.ts` (action-level, Supabase stubbed, no emails).
- Email delivery: custom SMTP (Brevo) since 2026-10-08; sender/domain setup pending (`docs/runbooks/auth-email.md` §3).
- Security headers (ADR-0017): X-Frame-Options DENY, nosniff, strict referrer, restrictive Permissions-Policy, COOP
  same-origin, HSTS over https, nonce-based CSP in report-only mode (`/api/csp-report`).

## Supabase dashboard settings (manual, Product Owner)
Single source: `docs/runbooks/auth-email.md` (§1 templates, §2 settings, §3 SMTP, §5 current state and owners).
