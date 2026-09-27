# Runbook — Vercel Preview (manual validation, not production)

Scope: only the `gestordefinanzas` Vercel project, Preview environment. No production domain yet.

## Security rules (CLAUDE.md / Prompt Madre)
- Only public values in Vercel env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
  Never the service role / `sb_secret_` key (the app refuses it at runtime, `lib/env.ts`).
- Scope env vars to **Preview** only. Keep Vercel Deployment Protection (Vercel Authentication) on.
- `NEXT_PUBLIC_SITE_URL` is NOT needed on Preview: `siteUrl()` uses the stable branch URL
  (`VERCEL_BRANCH_URL`, a Vercel system variable), so auth email links point at the preview.

## Steps
1. Vercel → Add New → Project → import GitHub `mavila-pm/gestordefinanzas` (framework: Next.js, defaults).
2. Settings → Environment Variables → add the two public vars above, environment **Preview** only.
3. Settings → Environments → Production branch stays `main`; branch `claude/beautiful-keller-ikxlrj` builds as Preview
   (redeploy it after adding the env vars if the first build ran without them).
4. Copy the **branch URL** of the deployment (`gestordefinanzas-git-claude-beautiful-keller-ikxlrj-<team>.vercel.app`),
   not the per-commit URL: it is stable across pushes and is the one Supabase must allow.

## Supabase (Authentication → URL Configuration)
- Redirect URLs: add `https://<branch-url>/auth/confirm`. Keep `http://localhost:3000/auth/confirm`.
- Site URL: leave `http://localhost:3000` (the app sends an explicit `redirectTo` that the allow list accepts).
- Remove the preview Redirect URL when validation ends.
