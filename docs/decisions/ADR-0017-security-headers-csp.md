# ADR-0017 — Security headers, report-only CSP and session cookies

Status: accepted (2026-10-20, FRONT A auth/security audit). CSP stays **report-only** until the step below.

## Decision
- **Static headers** (`next.config.ts`, every path): `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, geolocation off),
  `Cross-Origin-Opener-Policy: same-origin`; `poweredByHeader: false`.
- **Per request** (`proxy.ts`, `src/web/security-headers.ts`): `Strict-Transport-Security: max-age=63072000;
  includeSubDomains` only when the request came over https (`x-forwarded-proto`, else the URL). No `preload`: that
  is a hard-to-undo owner decision for the production domain.
- **CSP** `Content-Security-Policy-Report-Only` with a fresh 128-bit nonce per request. The proxy replaces any
  client-sent `x-nonce` / `content-security-policy` request header, puts the nonce on the request (Next.js 16 reads it
  from the request CSP header, report-only included, to tag its own scripts; `app/layout.tsx` reads `x-nonce` for the
  theme script) and the policy on the response:
  `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic' 'wasm-unsafe-eval' <culqi>; style-src 'self'
  'unsafe-inline' <culqi>; img-src 'self' data: blob: <culqi>; font-src 'self'; connect-src 'self' <culqi>;
  frame-src <culqi>; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self';
  form-action 'self'; frame-ancestors 'none'; report-uri /api/csp-report; report-to csp-endpoint`
  (`<culqi>` = `https://checkout.culqi.com https://js.culqi.com https://*.culqi.com`, allowed ahead of the card
  checkout). Dev builds add `'unsafe-eval'` (React refresh) only.
- **Reports**: `POST /api/csp-report` (public, untrusted): ≤ 8 KB read (413 above), ≤ 5 reports per request, one
  `csp_violation` JSON line each with `document`, `blocked`, `directive`, `disposition`, `source`, `line`, `column`;
  URLs keep scheme + host + path only (auth links carry `token_hash`), control characters removed, values ≤ 200 chars,
  script samples never logged. Nothing is stored.
- **Session cookies**: `authCookieOptions()` (`httpOnly`, `Secure` in production, `SameSite=Lax`, `path=/`) on both
  `createServerClient` calls. No browser Supabase client exists; only the `vs-*` preference cookies are read by scripts.

## Evidence
Unit: `tests/csp.test.ts`, `tests/security-headers.test.ts`, `tests/auth-cookies.test.ts`. Local `next build` +
`next start` + Playwright (Chromium 1194) on `/login`, `/signup`, `/forgot-password`, `/`, `/terminos`, `/privacidad`:
0 `securitypolicyviolation` events, Cap solved on `/login`, no console errors. `/app` and `/bienvenida` need a real
session: covered by the E2E listener (`tests/e2e/lib.ts` adds a "CSP (report-only): no violations" check to every
suite) on the next run against the project.

## Enforcing (next step, not in this block)
1. Deploy to Preview, browse every screen (Cap, camera reads, Vels, Ajustes), run the E2E suites.
2. Read the Vercel logs for `csp_violation` for a few days. Expected noise on Preview only: the Vercel toolbar
   (`vercel.live`), which can be turned off in the project settings.
3. When clean, change `CSP_HEADER` to `Content-Security-Policy` (one line) and keep the report endpoint.

## Consequences
- Every HTML response is dynamic already (the root layout reads cookies), so the per-request nonce costs nothing extra.
- A new third-party script, frame or API host needs a policy change and a test update in the same diff.
