---
name: deploy
description: How Velsuno reaches Vercel Preview (and what production needs), env vars per environment, applying migrations, and post-deploy smoke checks. Use when shipping a change for PO review, changing env vars, or preparing a release.
---
# deploy
Authorized: push to the session branch (Vercel builds it as **Preview**). Never: merge to `main`, deploy production,
change production env, or apply a migration outside `jeloegnvaxlfqjntbbyy` — those need the PO.

1. **Before push**: `npm run check` (+ `npm run test:db` for SQL) + `npm run build`; `scripts/qa/secrets.sh` when config
   or env code changed. CI (`.github/workflows/ci.yml`) re-runs check + test:db + build on every push.
2. **Migrations**: test locally (`npm run test:db`) → apply with the Supabase MCP `apply_migration` (content = the file, name = its suffix) → record it in `docs/runbooks/supabase-migrations.md` → one compact verify query (RLS + grants) + `get_advisors`.
   Apply BEFORE pushing code that depends on it (Preview uses the same database). SQL containing `DELETE` or `DROP` hangs in the
   connector: hand that file to the PO for the Supabase SQL Editor and make the code degrade gracefully until it exists.
3. **Env vars** (Vercel → Settings → Environment Variables, scope Preview first; link to project `gestordefinanzas`):
   public `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; server secrets (type Secret) `GEMINI_API_KEY`,
   `DATABASE_URL`, `INBOUND_EMAIL_SECRET`; config `GEMINI_MODEL` (optional), `AI_PRICES`,
   `INGEST_EMAIL_DOMAIN`. A changed env var needs a **Redeploy**. Never ask the user to paste a secret in chat.
4. **Smoke (Preview)**: branch URL in `docs/runbooks/vercel-preview.md`. Check `/` and `/login` load; sign in with a synthetic
   or PO account (never modify PO data); `/app` renders Dinero libre; Vels answers a question the local rules do not cover (e.g. "¿me da para unas zapatillas de 300?") — "todavía no está activa" means no Gemini key.
   Optional: `scripts/e2e.sh` suites against a local prod build (`docs/runbooks/e2e.md`).
5. **Production** (PO executes `docs/runbooks/production.md`; never the agent): the P0 items in `docs/MVP.md` (domain, SMTP, Supabase Redirect URLs for the domain,
   `NEXT_PUBLIC_SITE_URL`, privacy/terms) + full E2E (N4) + PO approval of the merge.
