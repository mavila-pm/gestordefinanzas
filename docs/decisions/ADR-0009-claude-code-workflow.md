# ADR-0009 — Claude Code workflow optimization (2026)

Status: ACCEPTED · Date: 2026-09-28 · Scope: agent workflow only (no product behavior change).

**Problem.** Every session re-sent large master prompts; CLAUDE.md mixed permanent rules, test ladder, brand notes and a
docs index; `docs/status.md` had become a diary. Context was spent re-reading instead of working; QA choices depended on
the prompt of the day.

**Decision.** Memory by layer, one home per rule:
core `CLAUDE.md` (always loaded, ~40 lines) · `.claude/rules/*.md` scoped by `paths` (financial, database, frontend,
auth-security) · project skills for repeatable procedures (`verify`, `task-close`, `financial-safety`) · one read-only
subagent (`security-reviewer`) for sensitive diffs · deterministic scripts (`scripts/qa/`: risk, run, secrets,
test-guard) and one PreToolUse hook (`guard-bash.sh`: no main, no force push, no prod deploy, no remote db push/reset) ·
`docs/qa.md` (N0–N4) · `docs/agent-workflow.md` (autonomy, debugging, sessions, handoff) · ADRs for decisions ·
`docs/status.md` as current state only. No third-party skills/plugins installed (audit below); Agent Teams off.

**External candidates (audited, not installed).** Supabase / Postgres best-practice skills and Vercel React / web design
skills: overlap with our rules and would add always-on descriptions; revisit only if a real gap appears. Playwright CLI
skill: we already drive Playwright via `tests/e2e/lib.ts`. TypeScript LSP plugin: useful for symbol navigation but not
available in this cloud image; optional locally. Gitleaks: not in the image; `scripts/qa/secrets.sh` uses it when present,
else a fixed-pattern scan with redacted output. MCP: account-level connectors (not repo config); GitHub MCP is the only
GitHub path here (no `gh`), Supabase MCP is the only DB path (no DB password) — both kept; Canva/Notion/Gmail/Calendar/
Drive/Docs are unrelated to this repo and should be disabled for these sessions in claude.ai connector settings.

**Consequences.** Less permanent context (CLAUDE.md 63 → ~36 lines, 5.0 → ~3.0 KB; status 78 lines / 9.5 KB → see file);
rules load only when matching files are touched; procedures load on demand. Cost: rules/skills must be kept in sync with
the code (update them in the same commit as the behavior they describe).
