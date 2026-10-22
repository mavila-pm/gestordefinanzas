# Runbook — Auth emails, SMTP and registration links (PO, Supabase dashboard)

Registration (block 042): `/signup` asks only the email → Supabase Auth `signInWithOtp` sends a signed, single-use,
expiring link → `/auth/confirm` (`verifyOtp` with `token_hash`, or `code` in the same browser) → `/crear-cuenta`
(password → profile + 18+ + consents) → `/bienvenida`. No custom tokens: expiry, single use and signing are Supabase's.

## 1. Email templates (Authentication → Emails → Templates)
Paste each file's HTML and set the subject. Links use `{{ .RedirectTo }}` (= `<site>/auth/confirm`, the exact
allow-listed callback the app sends), so the same template works on localhost, Preview and production.
| Template | File | Subject |
|---|---|---|
| Confirm signup | `supabase/templates/confirm-signup.html` | Confirma tu correo para continuar · Velsuno |
| Magic Link | `supabase/templates/magic-link.html` | Tu enlace para continuar · Velsuno |
| Reset Password | `supabase/templates/reset-password.html` | Restablece tu contraseña · Velsuno |
| Change Email Address | `supabase/templates/change-email.html` | Confirma tu nuevo correo · Velsuno |
Until they are pasted, Supabase's default (English) templates still work in the same browser (PKCE `code`), not across devices.
**Re-paste Magic Link (changed 2026-10-20):** it now says that a person who already has an account enters it with
this link and can also use the password. Supabase sends it only to addresses that already exist, so the signup
screen stays identical for new and registered addresses (no enumeration); only the inbox owner reads it. After the
link, a finished account lands on `/app?cuenta=existente` and sees once "Ya tenías una cuenta con este correo…"
(`EXISTING_ACCOUNT_NOTICE`); a skipped first conversation is not forced again.
Verified 2026-10-08 on the real project with Brevo SMTP: a NEW address receives "Confirm signup"; an existing one
receives "Magic Link"; recovery receives "Reset Password". The `token_hash` link format of these templates was
opened in a fresh browser (other-device case): signup → password → profile → bienvenida, recovery → new password →
login; a reused link → `/login?error=link`.

## 2. Settings (Authentication → Sign In / Providers → Email, and URL Configuration)
- Email provider enabled · Confirm email ON · Secure email change ON.
- Minimum password length **12**; password requirements **letters and digits** (the app enforces the same; if the
  Dashboard is lower, a direct Auth API call with the person's own session could set a weaker password).
- **Secure password change ON** + fill the **Reauthentication** template: without it a stolen session can change the
  password without a code (`changePassword` already handles `reauthentication_needed`).
- Email OTP / link expiration: **1800 s** (30 min) recommended.
- Rate Limits: every Auth call comes from Vercel's server IPs (no client IP is forwarded), so the per-IP limits for
  sign-ins/sign-ups and token verifications are shared by all users: raise them before launch.
- Redirect URLs: `http://localhost:3000/auth/confirm`, `https://<preview-branch-url>/auth/confirm`, `https://<domain>/auth/confirm`.
- Site URL: production domain when it exists.

## 3. SMTP (Authentication → Emails → SMTP Settings) — connected (Brevo, 2026-10-08); sender setup pending
State as last checked by an agent (2026-10-08, real inbox): custom SMTP via Brevo works. It cannot be read from the
repo since then, so **PO to confirm** in the Dashboard. This runbook is the reference for the SMTP state; other docs
that say "SMTP por defecto" predate 2026-10-08.
Pending on Brevo: authenticate the domain and send from `no-reply@<domain>` (today the sender is the shared
`…@…brevosend.com`), sender name `Velsuno`, and **turn off click and open tracking for transactional email** (Brevo
rewrites the sign-in link through its tracking redirect and adds a pixel: the security link passes through a third
party and some filters distrust it).
Original notes:
Built-in email is rate-limited (≈ 2–3 emails/hour project-wide) and may only deliver to team addresses.
Fill with the chosen provider (Resend, Postmark, Amazon SES, Brevo…): host, port 465/587, user, password (secret, only
in Supabase), sender `no-reply@<domain>`, sender name `Velsuno`. Add the provider's SPF/DKIM (and DMARC) DNS records
on the domain. Then raise Rate Limits → "emails per hour" (e.g. 30) and keep the per-address 60 s limit.

## 4. How the app handles failures (already coded)
- Signup: same "Revisa tu correo" for new and registered addresses; 429 → "Demasiados intentos. Espera un minuto…";
  provider failure → "No pudimos enviar el correo…". Logged as `signup_link_failed` (status + code, never the address).
- Recovery: always the same neutral message (a 429 only happens for registered emails → hiding it avoids enumeration).
- Invalid / expired / used link → `/login?error=link`: "Este enlace ya no sirve… Pide uno nuevo".
- Login lockout (033/034): the same lock text for every email, with "Recibir un enlace para entrar" and
  "¿Olvidaste tu contraseña?" (a third party can keep an email locked for password sign-in: ADR-0016).
- New password from a recovery link: other devices are signed out (`signOut({ scope: 'others' })`). "Cerrar sesión"
  signs out this device only (`scope: 'local'`); Ajustes → "Cerrar otras sesiones" signs out the rest.
- Profile step (`finish_registration`, migration 049): a number already used by another account →
  "Ese número ya está registrado…" at most 5 times per account in 24 h, then "Demasiados intentos. Intenta más
  tarde."; a finished account submitting again goes on to `/bienvenida` and nothing is rewritten.
- Logs never contain passwords, tokens or links.

## 5. Current state (2026-10-20) — what the code relies on, and who closes it
| Item | State | Owner |
|---|---|---|
| Cap key | `GET /api/cap/status` → `source`: `cap_secret` \| `derived` \| `missing`. Preview: `derived` (from `GEMINI_API_KEY`); `missing` refuses every form (fail closed). Set `CAP_SECRET` (`openssl rand -base64 48`, server-only) | PO (Vercel) |
| SMTP / sender | Brevo connected; domain authentication, `no-reply@<domain>`, tracking off pending | PO to confirm |
| Templates | the four files of §1 + Reauthentication; Magic Link re-paste (2026-10-20) | PO |
| Auth settings | §2 values (12 chars, secure password change, OTP 1800 s, redirect URLs, rate limits) | PO to confirm |
| Leaked-password protection | off (advisor WARN); may need a paid plan | PO |
| Purges | `login_throttle` (migration 035, contains DELETE) and expired `cap_spent` rows: not applied | PO (SQL Editor / Cron) |
| Lockout via direct RPC | open; server-only gate = owner decision (ADR-0016) | PO decision |
| Function grants, phone oracle, FK index | migrations 049, 050 in the repo, not applied (`docs/runbooks/supabase-migrations.md`) | agent, after PO approval |
| Advisor exceptions | documented in `docs/security/rls.md` ("Function grants") | — |
