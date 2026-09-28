# QA levels (N0–N4)

`scripts/qa/risk.sh [base]` maps a diff to the minimum level; run commands through `scripts/qa/run.sh <label> -- <cmd>`
(full log in `.qa/`, summary + real exit code). The `verify` skill applies this page.

| Level | When | Command(s) |
|---|---|---|
| N0 | while coding; tests/docs only | `npx vitest run <affected>`; `npm run typecheck` if shared types changed |
| N1 | any code change; every TASK close | `npm run check` · plus `npm run test:db` for SQL, persistence, RLS, write functions |
| N2 | UI/app/route/config change | `npm run build` (also done by `scripts/e2e.sh` when sources changed) |
| N3 | block close (2–4 TASKs), migration applied, financial write paths | seed → `scripts/e2e.sh <touched suites>` (+ `visual` / `perf` if UI/latency) → cleanup; one compact SQL verify + advisors after a migration |
| N4 | phase close; shared write paths, dedupe/ingestion, auth/proxy/session | seed → `scripts/e2e.sh` (all suites, 230+ checks) → cleanup |

Must-haves:
- New table / policy / grant / security-definer function → DB test with A/B isolation + privilege guard (`tests/db/`).
- Counters, quotas, settlements, anything "exactly once" → a concurrency test with committed parallel transactions.
- E2E protocol: `docs/runbooks/e2e.md` (seed renders with `scripts/e2e.sh render-seed`; suites mutate their users, so a
  re-run needs a reseed of those pairs; cleanup must return `probe_users=0 | orphan_rows=0`).
- Agent config only (`.claude/`, docs): N0 = validate JSON/frontmatter + `scripts/qa/test-guard.sh`; no app tests.
- Secrets: `scripts/qa/secrets.sh` before pushing new config or env-related code.
- VERIFIED requires the level risk.sh reports. Fixture/synthetic evidence never verifies a real provider or bank template.
