# Ingestion pipeline (implemented)

```
Provider payload -> FinancialEventSource.toRawEvent()   src/ingestion/sources/  (email_bridge, android_sms)
RawFinancialEvent (untrusted)
  -> size limit / HTML->text            src/ingestion/sanitize.ts
  -> L1 dedupe: (user, channel, externalEventId)   (SMS without id: sha256 of content)
  -> AdapterRegistry.resolve()          src/ingestion/adapter-registry.ts
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
- Duplicated field labels or text appended to an SMS → rejected, not guessed.
- One bad event never aborts a batch.

## Parser coverage status
All BCP parsers are `SYNTHETIC_UNVERIFIED`. Evidence: `docs/architecture/bcp-evidence.md`.

| Parser | Templates | Status |
|---|---|---|
| BCP_EMAIL_V1 | statement (non-tx, observed); purchase credit/debit; "operación con tu tarjeta" (PO structure); card payment; refund; reversal; transfer; withdrawal; deposit | IMPLEMENTED · UNVERIFIED |
| BCP_SMS_V1 | security alert (non-tx, observed); purchase credit/debit; card payment | IMPLEMENTED · UNVERIFIED |
| BBVA / Interbank | — | MISSING |

Replacing synthetic templates with real ones: `tests/fixtures/bcp/samples/README.md`.
