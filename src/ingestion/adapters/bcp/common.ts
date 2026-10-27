/**
 * Evidence register (see docs/architecture/bcp-evidence.md).
 *
 * OBSERVED (real anonymized samples provided by the Product Owner, 2026-09-27):
 * - Email domain `notificacionesbcp.com.pe` (sender estadodecuenta@..., DKIM signed by that domain).
 * - SMS sender `19896`, prefix "BCP Alertas:", security alert "Detectamos una operación inusual...".
 *
 * SYNTHETIC_UNVERIFIED: every transactional template (purchase, payment, refund, transfer...).
 * They exist to develop the architecture and must be replaced by templates calibrated on real
 * samples, as a new parser version, before any production claim.
 */
export const BCP_EMAIL_SENDER_DOMAINS = ['notificacionesbcp.com.pe'];
export const BCP_SMS_SENDERS = ['19896'];
