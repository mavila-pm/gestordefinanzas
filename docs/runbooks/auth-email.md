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
Verified 2026-10-08 on the real project with Brevo SMTP: a NEW address receives "Confirm signup"; an existing one
receives "Magic Link"; recovery receives "Reset Password". The `token_hash` link format of these templates was
opened in a fresh browser (other-device case): signup → password → profile → bienvenida, recovery → new password →
login; a reused link → `/login?error=link`.

## 2. Settings (Authentication → Sign In / Providers → Email, and URL Configuration)
- Email provider enabled · Confirm email ON · Secure email change ON.
- Minimum password length **12**; password requirements **letters and digits** (the app enforces the same).
- Email OTP / link expiration: **1800 s** (30 min) recommended.
- Redirect URLs: `http://localhost:3000/auth/confirm`, `https://<preview-branch-url>/auth/confirm`, `https://<domain>/auth/confirm`.
- Site URL: production domain when it exists.

## 3. SMTP (Authentication → Emails → SMTP Settings) — connected (Brevo, 2026-10-08)
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
- Logs never contain passwords, tokens or links.
