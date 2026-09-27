# Task status log

States: IMPLEMENTED (code exists) / VERIFIED (reproducible evidence) / APPROVED (Product Owner).

| Task | State | Evidence | Pending |
|---|---|---|---|
| TASK-003 — Auth + RLS dashboard on real Supabase | **VERIFIED** · **NOT APPROVED** | E2E 11/11 against project `jeloegnvaxlfqjntbbyy` (2026-09-27, `docs/runbooks/e2e.md`) | PO manual test via Vercel Preview (after 2FA access is recovered): signup + email confirmation, password recovery + password change, login. Full regression re-run after migration 000004 (see below). |
| TASK-004 — Review queue, manual entry, secure writes | **APPROVED** (PO, 2026-09-27) | Migration `20260927215130_secure_transaction_writes` applied and checked complete; E2E 46/46 on the real project; `npm run test:db` 39/39; unit tests | PO manual browser walkthrough (below). |
| TASK-005 | Not started — design options under PO review | — | PO decision between route A and route B |

## Open items
- **TASK-003 manual email validation** — signup/confirmation and recovery/password change with a real inbox through
  the Vercel Preview (`docs/runbooks/vercel-preview.md`). Blocks TASK-003 APPROVED.
- **TASK-004 manual validation** — PO reviews in a browser the "Por revisar" queue, a correction and a manual entry
  once a Preview exists. Does not reopen the approval unless a defect is found.
- **Regression pending** — `tests/e2e/auth-dashboard.e2e.ts` (TASK-003) has NOT been re-run in full after migration
  000004. The TASK-004 E2E covers login, dashboard figures and isolation, but not logout, the anti-enumeration
  messages or recovery; it does not replace the TASK-003 run.

## Backlog (known debt, not scheduled)
| Item | Origin | Note |
|---|---|---|
| Accounts creation/management UI | TASK-004 | Account linking works only for existing accounts |
| Fingerprint / dedupe after a correction | TASK-004 | Fingerprint keeps the original event; a corrected amount may stop a late SMS from matching |
| History display when currency changes | TASK-004 | Both amounts are shown in the current currency |
| Direct-edit policy for cards/accounts/categories | TASK-004, ADR-0003 | Still client-writable under RLS (own rows); decide whether to move behind functions |
| Movement deletion vs "Ignorar" | TASK-004, spec §10 | Deletion not offered; "Ignorar" excludes without destroying |

## External blockers
- 2026-09-27: Vercel access was temporarily locked by 2FA — **resolved**. The PO created the Vercel project
  `gestordefinanzas` (Git: `mavila-pm/gestordefinanzas`) with the two public `NEXT_PUBLIC_SUPABASE_*` variables scoped
  to Preview. The first `main` deployment failed because `main` does not contain the Next.js app yet (expected; no
  merge to `main` until approved). Next: Preview deployment of `claude/beautiful-keller-ikxlrj` for the TASK-003
  manual email test.
