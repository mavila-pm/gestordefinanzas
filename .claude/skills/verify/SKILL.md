---
name: verify
description: Choose and run the right Velsuno verification level (N0–N4) for the current diff and report compact evidence. Use before claiming VERIFIED, before a push, or when unsure which tests a change needs.
---
# verify
1. `scripts/qa/risk.sh [base]` → required level + reasons (base = HEAD for uncommitted, or the last pushed commit).
2. Run every level up to the required one (definitions and commands: `docs/qa.md`), each through
   `scripts/qa/run.sh <label> -- <cmd>` so the full log stays in `.qa/` and the real exit code is kept:
   - N0 `npx vitest run <affected tests>` · N1 `npm run check` (+ `npm run test:db` for SQL/persistence)
   - N2 `npm run build` (or covered by `scripts/e2e.sh`, which builds) · N3 seed → `scripts/e2e.sh <touched suites>` → cleanup
   - N4 seed → `scripts/e2e.sh` (all suites) → cleanup (`docs/runbooks/e2e.md`; cleanup must return 0|0)
3. On failure: debug per `docs/agent-workflow.md#debugging` (reproduce → classify app/test/data/env → evidence →
   one hypothesis → change → re-run). A second run must look for new evidence, not repeat a guess.
   E2E suites mutate their seed users: re-running after a partial run needs a reseed of those pairs.
4. Do not re-run a level that already passed on the same relevant state.
5. Output (nothing else):
   ```
   level: N<x> (<reasons>)
   <label>: exit=<code> <summary line>   # one line per command
   failures: <file:test — cause> | none
   state: VERIFIED at N<x> | NOT VERIFIED (<what is missing>)
   ```
Never call something VERIFIED from a lower level than risk.sh requires. Provider-real or bank-real behavior is
never VERIFIED with fixtures/synthetic data.
