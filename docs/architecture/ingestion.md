# Ingestion pipeline (implemented)

```
Provider payload -> FinancialEventSource.toRawEvent()   src/ingestion/sources/  (email_bridge, android_sms)
RawFinancialEvent (untrusted)
  -> size limit / HTML->text            src/ingestion/sanitize.ts
       (drops head/title/script/style/comments; fixed entity list + BMP numeric refs, never control/format/bidi/
       zero-width chars, line separators or noncharacters; only "\n" ends a line, so text inside one field can never
       start a new "Label: value" line; every pattern linear on the 64 KB cap)
  -> L1 dedupe: (user, channel, externalEventId)   (SMS without id: sha256 of content)
  -> AdapterRegistry.parse()            src/ingestion/adapter-registry.ts
       verified sender decides the bank; else, if the sender/subject names a bank, only that bank can be the result
       (another bank reading the body -> ambiguous_institution); with no bank in the header every claiming adapter
       decides and two banks reading it -> ambiguous_institution (unresolved). All fail -> malformed >
       unknown_template > non_transactional ("just a notice" only when every deciding adapter says so)
  -> BankAdapter.parse()                src/ingestion/adapters/<bank>/<bank>-<channel>-vN.ts
  -> NormalizedFinancialEvent           src/domain/types.ts
  -> L1b dedupe: same bank operation id (forwarded twice)
  -> L2/L3 dedupe: same kind + amount + currency + institution in ±30 min window
       strong (same card last4, ±10 min, compatible merchant, other channel) -> merge source
       anything weaker                                                      -> possible_duplicate
  -> non_transactional (statement, security alert) -> traced, no transaction
  -> resolve with user context: transfers (own account -> internal_transfer, else review);
     card kind unknown -> registered credit card => credit_card_purchase, unregistered => review
  -> link refund/reversal to original purchase
  -> deposit + outgoing/internal transfer of ANOTHER bank, same amount and currency, ±30 min -> 'possible_own_transfer'
       (suggestion only: stays review_required, type never changed; existing findCandidates port, one query per other
       bank, so in-memory, PostgreSQL and the Supabase import path all support it without an RPC). Only checked when the
       deposit arrives after the transfer; a deposit already stored is not re-flagged when the transfer comes later.
  -> categorize (normalize merchant -> user rule -> global rule)   src/engine/categorizer.ts
  -> status: high -> confirmed, medium -> review_required; parse failure -> unresolved (no transaction)
  -> TransactionRepository.insert / addSource; every event traced via recordEvent
```

## Rules enforced by tests (`tests/`)
- Same event ×5 → 1 transaction. Email + SMS of the same purchase → 1 transaction, 2 sources.
- Card payment never counts as expense. Internal transfer never changes income/expenses.
- ATM withdrawal is `transfer_to_cash`, not expense (ADR-0002). Metrics use `financialEffect()`.
- Refund/reversal reduce expenses, never income. PEN and USD never mixed.
- Unverified sender, unknown deposit origin, unknown transfer destination → review, never auto-confirmed.
- `requireVerifiedTemplate` is ON BY DEFAULT for every delivered channel (Email Bridge, future Android SMS, any new
  one): a SYNTHETIC_UNVERIFIED template is read but never auto-confirmed (`template_unverified` → review_required),
  even from a verified sender. Only an explicit `false` opts out (engine tests: `tests/fixtures/engine.ts`).
  Golden samples run with the options production uses, so the statuses they pin are the real ones.
- Duplicated field labels, a label value over 200 chars, more than one movement headline (promo line, quoted
  original inside a refund) or text appended to an SMS → rejected (malformed), not guessed.
- One bad event never aborts a batch.

## Parser coverage status
Every parser is `SYNTHETIC_UNVERIFIED`. BCP evidence: `docs/architecture/bcp-evidence.md`. BBVA: nothing observed
(invented wording, EMPTY sender allowlists → every BBVA event is `sender_not_verified` → review); never claim coverage.

| Parser | Templates | Status |
|---|---|---|
| BCP_EMAIL_V1 | statement (non-tx, observed); purchase credit/debit; "operación con tu tarjeta" (PO structure); card payment; refund; reversal; transfer; withdrawal; deposit | IMPLEMENTED · UNVERIFIED |
| BCP_SMS_V1 | security alert (non-tx, observed); purchase credit/debit; card payment | IMPLEMENTED · UNVERIFIED |
| BBVA_EMAIL_V1 | purchase credit/debit (PEN/USD); card payment; refund; reversal; transfer; ATM withdrawal (transfer_to_cash); deposit; non-tx security/OTP/statement/marketing (only when no amount is printed: a movement with the usual security footer stays unresolved) | IMPLEMENTED · SYNTHETIC (nothing observed) |
| BBVA_SMS_V1 | `BBVA:` prefix: purchase credit/debit; card payment; transfer; ATM withdrawal; deposit; non-tx OTP/security/marketing | IMPLEMENTED · SYNTHETIC (nothing observed) |
| BBVA_PUSH_V1 | app notification pasted as SMS (first line `BBVA`): purchase credit/debit; card payment; transfer; deposit | IMPLEMENTED · SYNTHETIC (nothing observed) |
| INTERBANK_EMAIL_V1 · INTERBANK_SMS_V1 | SCAFFOLD: zero templates; claims messages naming Interbank; with Interbank in the sender/subject another bank reading the body → ambiguous_institution → unresolved | SCAFFOLD · not supported |

Replacing synthetic templates with real ones: `tests/fixtures/bcp/samples/README.md` (same for `bbva/samples/`).

Copy naming the banks we read comes from the registry via `bankCoverageText()`: `supportedInstitutions()` = banks with
an adapter marked `observed` (a REAL_ANONYMIZED sample routes to it; `tests/bank-samples.test.ts` refuses the flag
otherwise), then `trialInstitutions()` = invented templates only, shown "en prueba" → today "BCP (BBVA en prueba)".
App notifications are pasted in the "SMS o notificación de la app" field and labelled
"notificación de la app" (`sourceOriginLabel`, from the `_PUSH_` parser version).


## Free plan limits on automatic writes (spec §81)
`assert_auto_allowance` (migrations 032, 048) runs inside the insert transaction of BOTH automatic paths (import RPC,
Email Bridge): per-person advisory lock inside the function, VOLATILE (counts on a snapshot taken after the lock),
42501 when `request_uid()` does not name the person. A rejection is traced as `rejected` with the code and shown in
Conexiones → "Últimos mensajes recibidos" as a plan limit (`describeSyncEvent`), never as "por seguridad".
OPEN (PO decision / Change Request): every created non-manual movement counts, including unverified-sender, synthetic
or later ignored ones, so a forged first email can take the Free bank slot; changing what counts deviates from §81 as
written and is not implemented.

## User import (TASK-006)
`/app/importar`: the user pastes a bank SMS/email text. It runs through the SAME pipeline (adapter, dedupe, category,
confidence) with `persistAs: 'import'`:
- sender is `user-import:<channel>` → never passes the bank's sender verification;
- source channel `import` (provenance label "importado por ti"); cross-source matching uses the source KIND
  (`import:<parser>`), so a pasted SMS + pasted email of the same purchase merge, and a later real SMS merges too;
- always `review_required` (engine adds `user_import`; the DB function refuses a confirmed import);
- persistence through `SupabaseImportRepository` with the user's session: reads under RLS, writes only via
  `import_insert_transaction` / `import_add_source` / `import_record_event` (migration 000007);
- the pasted text is not stored (spec §33).
Ingestion context (own cards, own accounts, learned merchant rules) comes from `loadUserContext` (TASK-005).

## Dedupe after user corrections (TASK-013)
`transactions.reported_amount_minor` / `reported_occurred_at` keep what the source reported; a trigger fills them on
insert and makes them immutable on update (even for the audited write functions). `findCandidates` matches the
current OR the reported values, so a late second source of a corrected movement merges (or is flagged as
possible duplicate) instead of creating a second confirmed movement. The user's corrected values always win.
