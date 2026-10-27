# Runbook — First production launch (PO executes; the agent never deploys production)

Preconditions: every P0 in `docs/MVP.md` checked, CI green on the release commit, full E2E (N4) green on that commit.

## 1. Decisions and accounts (PO)
- Domain (e.g. `velsuno.pe`) bought and added in Vercel → Settings → Domains (production).
- SMTP provider for auth emails (Supabase → Authentication → Emails → SMTP Settings) with a sender on that domain.
- Contact mailbox for `SUPPORT_EMAIL`; privacy/terms text approved.

## 2. Database (same project `jeloegnvaxlfqjntbbyy`)
- Every file in `supabase/migrations/` applied (check `docs/runbooks/supabase-migrations.md`; none PENDING).
- Supabase → Authentication → URL Configuration: Site URL = `https://<domain>`; Redirect URLs add `https://<domain>/auth/confirm`
  (exact, no query string). Email templates use `token_hash` (`docs/architecture/auth.md`).
- Advisors (security) reviewed: only the documented intended WARNs.
- Synthetic E2E users removed (`tests/e2e/cleanup.sql` → `0 | 0`) — run in the SQL Editor (contains DELETE).

## 3. Vercel environment: Production
| Variable | Type | Value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | config | `https://jeloegnvaxlfqjntbbyy.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | config | `sb_publishable_…` (never a secret key) |
| `NEXT_PUBLIC_SITE_URL` | config | `https://<domain>` (if unset, the Vercel production domain is used) |
| `SUPPORT_EMAIL` | config | contact mailbox |
| `GEMINI_API_KEY` (+ `AI_PRICES` for the model) | secret / config | only if AI goes live (privacy decision: paid tier, no training on prompts); otherwise leave unset |
| `DATABASE_URL`, `INBOUND_EMAIL_SECRET`, `INGEST_EMAIL_DOMAIN` | secret | only when the Email Bridge provider exists |
Do NOT set `AI_FIXTURE` on Vercel (ignored on Preview and production anyway).

## 4. Release
1. PO approves and merges the release branch into `main` (PR mavila-pm/gestordefinanzas#1); Vercel builds Production.
2. Smoke test on `https://<domain>` (5 min): `/` loads · signup with a real inbox → email arrives < 1 min → link opens
   `/auth/confirm` → `/bienvenida` · finish onboarding · `/app` shows Dinero libre · add a manual movement · log out / log in ·
   password recovery email arrives · `/privacidad` shows the contact.
3. If any step fails: Vercel → Deployments → previous production deployment → **Promote** (instant rollback); DB migrations are
   additive, so the previous build keeps working.

## 5. First week
Watch Vercel logs (`account_delete_failed`, `inbound_email_failed`, `ai_test_chat`), Supabase Auth logs (email errors) and
advisors. Data issues → `review_required` items in "Por revisar", never manual DB edits on real accounts.
