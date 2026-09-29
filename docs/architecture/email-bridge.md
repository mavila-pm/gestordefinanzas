# Email Bridge (TASK-009) — foundation IMPLEMENTED, real integration BLOCKED

Flow (spec §6): bank → user's mailbox → selective forwarding → private address `f_<24 base32>@<domain>` →
inbound email provider → `POST /api/inbound/email` → FinancialEventSource → adapters → dedupe → DB → dashboard.

## Implemented and verified locally (tests/db/email-bridge.test.ts, tests/email-webhook.test.ts)
- `email_connections`: one active address per user, 120-bit random local part generated in the DB
  (`rotate_email_connection`), rotation revokes the previous one; users read only their own; no client can choose one.
- `inbound_deliveries`: server-only ledger (no client privileges) — replay protection `(provider, delivery_id)`.
- Webhook security (§35): HMAC-SHA256 over `timestamp.body` (server secret), constant-time compare, ±5 min window,
  256 KB cap, strict envelope schema, unknown/revoked addresses answer the same 202 (no enumeration),
  per-address rate limit (120/hour), Message-ID Level-1 dedupe, body never stored, hostile text never executed.
- Processing uses a privileged server connection (`DATABASE_URL`, server-only) with explicit `user_id` filters
  (`PgTransactionRepository`), same pipeline as every source.

## BLOCKED — needs Product Owner decisions/secrets (spec §78 "Proveedor inbound email", "Dominio")
1. Choose the inbound provider (Postmark / Mailgun / SendGrid Inbound Parse / Cloudflare Email Workers). Each needs
   its own `InboundEmailProvider` (signature scheme + payload mapping). Only `generic_hmac` exists (simulator/tests).
2. Domain + MX records for `INGEST_EMAIL_DOMAIN`.
3. Server env vars in Vercel (never `NEXT_PUBLIC_`): `INBOUND_EMAIL_SECRET` (≥32 chars), `DATABASE_URL`
   (Supabase connection string), `INGEST_EMAIL_DOMAIN`. Until then the endpoint answers 503 `not_configured`.
4. Gmail forwarding verification (Gmail sends a confirmation code to the new address): design the in-app display.
5. Real forwarded samples to verify sender checks after forwarding and to move parsers from SYNTHETIC_UNVERIFIED.
