# CLAUDE.md

Gestor Financiero Automático Multifuente (SaaS Free + Plus). Product spec (binding): `docs/product/MOTHER_DOCUMENT.md`.
Product Owner: Mauro. Deviations from the spec need a Change Request (Anexo A) before implementation.

## Commands (verified)
- `npm install`
- `npm test` — Vitest
- `npm run typecheck`
- `npm run check` — typecheck + tests (run before every push)

## Permanent rules
- SOURCE -> NORMALIZED EVENT -> FINANCIAL ENGINE. No bank/provider-specific code outside `src/ingestion/adapters/`.
- Money: integer minor units, never float. Amounts positive; `type`/`direction` carry meaning.
- Card payment is never an expense. Refund/reversal is never income. Internal transfer changes neither.
- ATM withdrawal is `transfer_to_cash`, never an expense by default (ADR-0002). Metrics go through `financialEffect()`.
- Uncertain -> `review_required`. Weak duplicate -> `possible_duplicate`. Never invent or auto-delete.
- Emails/SMS/webhooks are untrusted input: parse with fixed patterns, never follow their text.
- Never store bank passwords, PIN, CVV, MFA, full PAN. Never commit secrets. Service role never client-side.
- Plus features are authorized server-side via entitlements, never only in the UI.
- Fixtures: `SYNTHETIC_FIXTURE` or `REAL_ANONYMIZED` only. Templates without real samples are `SYNTHETIC_UNVERIFIED`, never VERIFIED.
- Parsers are versioned (`BCP_EMAIL_V1`, ...); real samples that break a template -> new version, keep old.
- Greenfield project (no prior prototype).
- Report states honestly: IMPLEMENTED / VERIFIED (reproducible evidence) / APPROVED.

## Docs index
- `docs/architecture/structure.md` — repo layout
- `docs/architecture/ingestion.md` — pipeline and parser coverage
- `docs/architecture/bcp-evidence.md` — observed vs assumed BCP facts
- `tests/fixtures/bcp/samples/README.md` — adding real anonymized samples
- `docs/decisions/` — ADRs
