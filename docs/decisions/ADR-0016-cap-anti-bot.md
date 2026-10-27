# ADR-0016 — Cap anti-bot on the public auth forms

Status: accepted (2026-10-10, PO request). Complements, never replaces, the login lockout (migrations 033/034).

## Decision
Cap (trycap.dev, Apache-2.0) proof-of-work CAPTCHA, self-hosted: `@cap.js/widget@0.1.58` in the browser,
`capjs-core@0.1.3` on the server (exact pins; versions ≥ 2 weeks old when added). No third-party service, no CDN: the
solver wasm (`@cap.js/wasm@0.0.8`, sha256 `e4f3c002…06a9`) is served from `public/cap/`.

Protected server actions: `login`, `signup` (magic link and its resend), `requestPasswordReset`. Each checks Cap
first, before the lockout counter or Supabase Auth, so a bot using the app's forms can neither send emails nor lock a
real person's email. Cap guards the forms only, not the endpoints behind them: see "Limits" below.

## How a request is verified
1. `POST /api/cap/<login|signup|recovery>/challenge` → capjs-core signed challenge (HS256 with the Cap key: `CAP_SECRET`,
   else derived, see the 2026-10-10 update; scope bound, 5 min).
2. The widget solves it (on first interaction, so the tap answers at once) and `POST …/redeem` → capjs-core checks the
   proof of work, signature, scope and expiry, and spends the challenge signature once (`cap_spend('c:…')`).
   Answer: our redeem token `v1.<scope>.<id>.<exp>.<HMAC>` (key derived from the Cap key, 10 min).
3. The action verifies MAC (timing-safe), scope, expiry and spends `r:<id>` once. Any failure — missing, malformed,
   forged, other scope, expired, reused, store error, no Cap key (`source: missing`) — refuses with
   "No pudimos verificarte. Intenta otra vez." (fail closed). Logs carry the reason code only.

Replay store: `cap_spent` (migration 040) keeps SHA-256 hashes + expiry; RLS on, no table grants; `cap_spend()` is
SECURITY DEFINER for anon/authenticated (the app has no service role). An anon caller can at most spend random keys
(table growth, bounded per key to 600 s by migration 041); it cannot mint a valid token without `CAP_SECRET`.
Open (PO, contains DELETE): purge expired rows, e.g. `delete from public.cap_spent where expires_at < now() - interval '1 hour';`
on a schedule, together with the pending login_throttle purge (…035). The PoW is cheap for a native solver: Cap adds
friction and stops email sending by scripts; the login lockout remains the brute-force control.

## Consequences
- Every environment needs a Cap key — `CAP_SECRET`, or `GEMINI_API_KEY` to derive one (2026-10-10 update) — or
  nobody can sign in, sign up or recover a password.
- The widget shows a small "Cap" attribution (the library enforces it); its troubleshooting link is hidden.
- `capjs-core` is a server external package (it lazily imports esbuild only for instrumentation, which is not used).

## Update 2026-10-10 — access restored on Preview
Cause: the Preview deployment had no usable `CAP_SECRET` (no Cap redeem and no login attempt ever reached the database
from it: `cap_spent` and the API logs only show local runs), so `/api/cap/*` answered 503 and every login failed
closed. Fix: `CAP_SECRET` is trimmed and accepted from 16 chars (capjs-core's minimum); while a deployment lacks it,
the signing key is derived (HMAC-SHA256, label `velsuno:cap:secret:v1`) from `GEMINI_API_KEY`, a server-only secret
already present in every deployed environment. Verification is unchanged; nothing is skipped; neither secret → still
fail closed. `GET /api/cap/status` says `ready` and the source (`cap_secret` | `derived` | `missing`), never a secret.
Set `CAP_SECRET` anyway: rotating the Gemini key would otherwise also rotate Cap's key (tokens live ≤ 10 min).
UX: the widget keeps a short label; the full message and "Intentar otra vez" wrap below it.

## Update 2026-10-20 — limits (auth/security audit, FRONT A)
Cap protects the app's forms. It does not protect what the publishable key can reach directly:
- `public.login_attempt` (the lockout counter, migrations 033/034) is executable by `anon` (Supabase advisor 0028).
  Anyone with the publishable key can call `/rest/v1/rpc/login_attempt` three times per window and keep any email
  locked for **password** sign-in (5 → 15 → 30 min, repeating), without Cap. The earlier claim that a bot "cannot lock
  a real person's email" was wrong. Mitigation shipped: the lock message is the same for every email and offers the
  ways in that do not use the password, "Recibir un enlace para entrar" (`/signup?modo=enlace`, magic link) and
  "¿Olvidaste tu contraseña?" (`src/web/login.ts` `LOCKOUT_LINKS`). The publishable key is not in the client bundle,
  which raises the bar but is not a control.
  Planned fix (owner decision, not done): run the counter with a server-only credential (`DATABASE_URL` pool in
  Vercel) and revoke `EXECUTE` from `anon`/`authenticated`; or accept the risk in writing here.
  Until then `login_attempt` and `cap_spend` are the documented exceptions in `tests/db/rls.test.ts` (anon EXECUTE
  allowlist) and `docs/security/rls.md`.
- Supabase Auth endpoints (`/auth/v1/otp`, `/recover`, `/token`) also accept direct calls with the publishable key;
  they are limited only by Supabase's own rate limits (Dashboard → Authentication → Rate Limits).
- `cap_spend` is executable by `anon`: table growth only (no token can be minted without the secret); expired rows
  still need the purge above.
- `CAP_SECRET`: still not set on Preview; Cap runs on the derived key (`GET /api/cap/status` → `"source":"derived"`).

## Update 2026-10-20 — state after FRONT A (single statement; PO to confirm the Dashboard parts)
- Cap key source: `derived` on Preview (`CAP_SECRET` not set); `cap_secret` once the PO sets it; `missing` = fail closed.
- Function grants are now guarded (`tests/db/rls.test.ts`, migration 049, live once applied): anon may execute only
  `cap_spend` and `login_attempt`, both listed with their reason; trigger functions are executable by no client role.
- Still open: the server-only lockout gate (owner decision above), the `login_throttle` (035) and `cap_spent` purges
  (contain DELETE, PO), and the Supabase Auth rate limits (`docs/runbooks/auth-email.md` §2, §5).
