---
name: task-close
description: Close a Velsuno work block (TASK) compactly — confirm evidence, update docs/status.md, commit and push to the authorized branch, and state the next step. Use when a deliverable is finished or before ending a session.
---
# task-close
1. `git status --short` and `git diff --stat` — know exactly what is in the block; nothing unrelated, no secrets
   (`scripts/qa/secrets.sh`), no `.env*` or `.qa/` files staged.
2. Evidence: reuse the `verify` result if the relevant state did not change since; otherwise run `verify`.
3. Docs (compact, only what changed):
   - `docs/status.md`: update the TASK row (state + evidence + pending) and "Next work". Current state, not a diary.
   - New decision → ADR (short). New operation → runbook. Applied migration → `docs/runbooks/supabase-migrations.md`.
4. Commit: coherent message (what + why), attribution lines required by the session. Push only to the authorized
   branch (`git push -u origin <branch>`, retry on network errors only). Never main, never force.
5. Report (≤ 12 lines): done · evidence (level + counts) · commits · push · working tree · next step · blockers.
6. Session: if the next work needs different context, write the handoff (`docs/agent-workflow.md#handoff`) and
   suggest a new session instead of dragging this one.
