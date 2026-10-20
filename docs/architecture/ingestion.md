# Ingestion pipeline (implemented)

```
Provider payload -> FinancialEventSource.toRawEvent()   src/ingestion/sources/  (email_bridge, android_sms)
RawFinancialEvent (untrusted)
  -> size limit / HTML->text            src/ingestion/sanitize.ts
       (drops head/title/script/style/comments; fixed entity list + BMP numeric refs, never control chars)
  -> L1 dedupe: (user, channel, externalEventId)   (SMS without id: sha256 of content)
  -> AdapterRegistry.parse()            src/ingestion/adapter-registry.ts
       verified sender decides the bank; else every claiming adapter is tried (header-named bank first);
       two banks reading it -> ambiguous_institution (unresolved)
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
- Delivered channels (Email Bridge, future Android SMS) pass `requireVerifiedTemplate`: a SYNTHETIC_UNVERIFIED
  template is read but never auto-confirmed (`template_unverified` → review_required), even from a verified sender.
- Duplicated field labels or text appended to an SMS → rejected, not guessed.
- One bad event never aborts a batch.

## Parser coverage status
Every parser is `SYNTHETIC_UNVERIFIED`. BCP evidence: `docs/architecture/bcp-evidence.md`. BBVA: nothing observed
(invented wording, EMPTY sender allowlists → every BBVA event is `sender_not_verified` → review); never claim coverage.

| Parser | Templates | Status |
|---|---|---|
| BCP_EMAIL_V1 | statement (non-tx, observed); purchase credit/debit; "operación con tu tarjeta" (PO structure); card payment; refund; reversal; transfer; withdrawal; deposit | IMPLEMENTED · UNVERIFIED |
| BCP_SMS_V1 | security alert (non-tx, observed); purchase credit/debit; card payment | IMPLEMENTED · UNVERIFIED |
| BBVA_EMAIL_V1 | purchase credit/debit (PEN/USD); card payment; refund; reversal; transfer; ATM withdrawal (transfer_to_cash); deposit; non-tx security/OTP/statement/marketing-without-amount | IMPLEMENTED · SYNTHETIC (nothing observed) |
| BBVA_SMS_V1 | `BBVA:` prefix: purchase credit/debit; card payment; transfer; ATM withdrawal; deposit; non-tx OTP/security/marketing | IMPLEMENTED · SYNTHETIC (nothing observed) |
| BBVA_PUSH_V1 | app notification pasted as SMS (first line `BBVA`): purchase credit/debit; card payment; transfer; deposit | IMPLEMENTED · SYNTHETIC (nothing observed) |
| INTERBANK_EMAIL_V1 · INTERBANK_SMS_V1 | SCAFFOLD: zero templates; claims messages naming Interbank so they are never misread by another bank → unresolved | SCAFFOLD · not supported |

Replacing synthetic templates with real ones: `tests/fixtures/bcp/samples/README.md` (same for `bbva/samples/`).

Copy naming the banks we read ("BCP y BBVA") comes from `supportedInstitutions()` (registry, scaffolds excluded) via
`supportedBanksText()`; app notifications are pasted in the "SMS o notificación de la app" field and labelled
"notificación de la app" (`sourceOriginLabel`, from the `_PUSH_` parser version).

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
