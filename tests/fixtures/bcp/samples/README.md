# BCP sample bank (golden fixtures)

Each `*.json` file is one message run through the full pipeline by `tests/bcp-samples.test.ts`.

| Field | Meaning |
|---|---|
| `fixtureStatus` | `REAL_ANONYMIZED` (real message, redacted) or `SYNTHETIC_FIXTURE` (assumed wording). Never `VERIFIED_BCP_TEMPLATE` by hand. |
| `evidence` | What was actually observed vs assumed. |
| `raw` | `RawFinancialEvent` as a FinancialEventSource would produce it. |
| `expected` | Pipeline outcome and (optional) partial transaction. |

## Adding a real sample
1. Redact: names, full card/account numbers (keep only last 4), DNI, OTP/keys/tokens, addresses.
   Operation numbers and amounts may be replaced with plausible values.
2. Save as `<channel>-<case>.real-anonymized.json` with the expected result.
3. `npm test`. If it fails, the template is wrong: create a new parser version (e.g. `BCP_EMAIL_V2`)
   instead of editing the old one, and keep old samples passing.
4. A parser may be marked `VERIFIED` only when every template it declares has a passing real sample.

The sensitive-data guard in the test rejects files containing 13–19 digit card numbers, 8-digit DNI
labels, or OTP-like content.
