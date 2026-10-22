import { parseAmountToMinor, parseCurrencyMarker, type Currency } from '../../../domain/money';

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

export function parseMoneyExpr(s: string): { amountMinor: number; currency: Currency } | null {
  const m = /^(S\/\.?|US\$|\$)\s*([\d,]+(?:\.\d{1,2})?)$/i.exec(s.trim());
  if (!m) return null;
  const currency = parseCurrencyMarker(m[1]!);
  const amountMinor = parseAmountToMinor(m[2]!);
  if (!currency || amountMinor === null) return null;
  return { amountMinor, currency };
}

export function last4(s: string | undefined): string | null {
  if (!s) return null;
  const m = /[*xX•]+\s*(\d{4})\s*$/.exec(s.trim());
  return m ? m[1]! : null;
}

export function cleanMerchant(s: string | undefined): string | null {
  if (!s) return null;
  const v = s.trim().replace(/\s+/g, ' ').slice(0, 120);
  return v.length ? v : null;
}
