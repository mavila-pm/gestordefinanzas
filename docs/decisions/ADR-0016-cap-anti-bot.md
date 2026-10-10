# ADR-0016 — Cap anti-bot on the public auth forms

Status: accepted (2026-10-10, PO request). Complements, never replaces, the login lockout (migrations 033/034).

## Decision
Cap (trycap.dev, Apache-2.0) proof-of-work CAPTCHA, self-hosted: `@cap.js/widget@0.1.58` in the browser,
`capjs-core@0.1.3` on the server (exact pins; versions ≥ 2 weeks old when added). No third-party service, no CDN: the
solver wasm (`@cap.js/wasm@0.0.8`, sha256 `e4f3c002…06a9`) is served from `public/cap/`.

Protected server actions: `login`, `signup` (magic link and its resend), `requestPasswordReset`. Each checks Cap
first, before the lockout counter or Supabase Auth, so a bot can neither send emails nor lock a real person's email.

## How a request is verified
1. `POST /api/cap/<login|signup|recovery>/challenge` → capjs-core signed challenge (HS256 with `CAP_SECRET`, scope bound, 5 min).
2. The widget solves it (on first interaction, so the tap answers at once) and `POST …/redeem` → capjs-core checks the
   proof of work, signature, scope and expiry, and spends the challenge signature once (`cap_spend('c:…')`).
   Answer: our redeem token `v1.<scope>.<id>.<exp>.<HMAC>` (key derived from `CAP_SECRET`, 10 min).
3. The action verifies MAC (timing-safe), scope, expiry and spends `r:<id>` once. Any failure — missing, malformed,
   forged, other scope, expired, reused, store error, `CAP_SECRET` absent — refuses with
   "No pudimos verificarte. Intenta otra vez." (fail closed). Logs carry the reason code only.

Replay store: `cap_spent` (migration 040) keeps SHA-256 hashes + expiry; RLS on, no table grants; `cap_spend()` is
SECURITY DEFINER for anon/authenticated (the app has no service role). An anon caller can at most spend random keys
(table growth, bounded per key to 600 s by migration 041); it cannot mint a valid token without `CAP_SECRET`.
Open (PO, contains DELETE): purge expired rows, e.g. `delete from public.cap_spent where expires_at < now() - interval '1 hour';`
on a schedule, together with the pending login_throttle purge (…035). The PoW is cheap for a native solver: Cap adds
friction and stops email sending by scripts; the login lockout remains the brute-force control.

## Consequences
- `CAP_SECRET` must exist in every environment, or nobody can sign in, sign up or recover a password.
- The widget shows a small "Cap" attribution (the library enforces it); its troubleshooting link is hidden.
- `capjs-core` is a server external package (it lazily imports esbuild only for instrumentation, which is not used).
