# BBVA sample bank (golden fixtures) — ALL SYNTHETIC

No real BBVA Perú email, SMS or app notification has been provided yet. Every file here is `SYNTHETIC_FIXTURE`
(invented wording, `.example` sender domain) and only proves the multi-bank pipeline; it says nothing about real
BBVA coverage. Same format and procedure as `tests/fixtures/bcp/samples/README.md`; run by `tests/bank-samples.test.ts`.

To start real coverage: add `<channel>-<case>.real-anonymized.json` files from real, redacted messages, write a new
parser version calibrated on them (e.g. `BBVA_EMAIL_V2`), add the observed sender to the allowlist, and only then
consider `VERIFIED` (the samples test refuses a VERIFIED adapter without a real `created` sample).
