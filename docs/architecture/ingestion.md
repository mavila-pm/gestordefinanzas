# Ingestion pipeline (implemented)

```
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
  -> resolve transfers (own account last4 -> internal_transfer, else review)
  -> link refund/reversal to original purchase
  -> categorize (normalize merchant -> user rule -> global rule)   src/engine/categorizer.ts
  -> status: high -> confirmed, medium -> review_required; parse failure -> unresolved (no transaction)
  -> TransactionRepository.insert / addSource; every event traced via recordEvent
```

## Rules enforced by tests (`tests/`)
- Same event ×5 → 1 transaction. Email + SMS of the same purchase → 1 transaction, 2 sources.
- Card payment never counts as expense. Internal transfer never changes income/expenses.
- Refund/reversal reduce expenses, never income. PEN and USD never mixed.
- Unverified sender, unknown deposit origin, unknown transfer destination → review, never auto-confirmed.
- Duplicated field labels or text appended to an SMS → rejected, not guessed.
- One bad event never aborts a batch.

## Parser coverage status
| Parser | Templates | Status |
|---|---|---|
| BCP_EMAIL_V1 | purchase (credit/debit), card payment, refund, reversal, transfer out, withdrawal, deposit | IMPLEMENTED on **synthetic** templates — NOT VERIFIED against real BCP emails |
| BCP_SMS_V1 | purchase (credit/debit), card payment | IMPLEMENTED on **synthetic** templates — NOT VERIFIED against real BCP SMS |
| BBVA / Interbank | — | MISSING |

Calibrating a parser: add real **anonymized** samples as fixtures (replace names, card/account digits,
operation numbers, amounts if sensitive), adjust the template or create a new `_V2` adapter, keep the old one.
