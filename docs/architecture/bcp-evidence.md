# BCP evidence register

Only what is observed in real (anonymized) samples is a fact. Everything else is `SYNTHETIC` / `UNVERIFIED`.

| Item | Status | Source |
|---|---|---|
| Email domain `notificacionesbcp.com.pe` (DKIM "firmado por") | OBSERVED | Statement email, 2026-09-24 |
| Email sender `estadodecuenta@notificacionesbcp.com.pe`, subject "Estado de Cuenta de tu Tarjeta …" | OBSERVED | Same |
| SMS sender `19896`, prefix "BCP Alertas:" | OBSERVED | Security alert SMS |
| SMS "Detectamos una operación inusual con tu tarjeta terminada en ****NNNN por S/ …" | OBSERVED (non-transactional) | Same |
| Transactional email sender local part, subject, wording, fields, order | **UNVERIFIED** | Structure proposed by PO only |
| Transactional SMS wording (consumo, pago de tarjeta) | **UNVERIFIED** | Assumed |
| Refund, reversal, transfer, withdrawal, deposit templates | **UNVERIFIED** | Assumed |

## Handling rules derived from evidence
- Statement emails and security alerts are `non_transactional`: traced, never turned into transactions
  (an "operación inusual" alert may refer to a blocked or pending operation).
- Sender allowlists contain only observed senders. Anything else can parse but is capped at `review_required`.
- All BCP parsers declare `templateVerification = 'SYNTHETIC_UNVERIFIED'`, stored on every transaction source.

## Needed to reach VERIFIED
One real anonymized sample per transactional template (credit purchase, debit purchase, card payment,
transfer, deposit, withdrawal; refund/reversal when available). Procedure: `tests/fixtures/bcp/samples/README.md`.
