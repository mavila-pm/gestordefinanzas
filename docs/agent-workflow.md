# Agent workflow (autonomy, sessions, handoff)

## Autonomy contract
May do without asking (within the session's permissions): explore, edit, refactor, run tests, fix bugs, write safe
migrations and apply them to `jeloegnvaxlfqjntbbyy` after `npm run test:db`, commit, push to the authorized branch.
Resolve reversible decisions yourself and say which default you took.
Do not stop for: a failing test, a bug, naming, a refactor, a reversible choice, a missing AI key while other work exists.
Stop and ask for: production, `main`, a missing secret/credential, spending money, choosing/contracting an external
provider, irreversible operations (deleting real data), a material product decision (spec change → Change Request),
a serious risk you cannot resolve. `.claude/hooks/guard-bash.sh` blocks the mechanical cases.

## Debugging
Reproduce → classify (app / test / data / env) → collect evidence (log, query, screenshot, exact input) → one
hypothesis → smallest change → re-run the same check. A second attempt must bring new evidence; no fail→guess loops.
E2E-specific: a failing check after a partial run is often stale seed data — reseed before blaming the app.

## Token discipline
`rg`/grep and line ranges before whole files; `git diff`/`--stat`; command output through `scripts/qa/run.sh` or filtered
(never lose the exit code); logs stay in `.qa/`. Re-read a file only when it changed or current evidence is needed.
No per-step narration; no repeating invariants (they load from `.claude/rules/`); no full E2E after small changes.
Subagents only for separable work (`security-reviewer` for sensitive diffs, Explore for wide searches). Agent Teams: off.

## Sessions
Keep the session while the next step needs the same context. Compact when the goal stays but exploration piled up.
New session when a deliverable is done at a clean checkpoint, the front changes, or the context carries dead weight.

## Handoff (200–400 words)
task · status (IMPLEMENTED/VERIFIED + level) · repo/branch · last commit · uncommitted work (should be none) · done ·
evidence (commands + counts) · invariants at risk in the next step · next step · blockers · authorizations in force.
No history narrative, no secrets. The durable part goes to `docs/status.md`; the rest lives in git/ADRs.

## Short prompts that work
"Continúa TASK-XXX desde docs/status.md. Implementa <resultado>. Usa las rules/Skills aplicables. Verifica según riesgo.
Resuelve decisiones reversibles. No main ni producción. Detente solo ante bloqueo real."
