import { parseAmountToMinor, parseCurrencyMarker, type Currency } from '../../../domain/money';

/**
 * SYNTHETIC TEMPLATES. The BCP patterns in this folder were written from general knowledge of
 * BCP notifications, not from validated real samples. They must be calibrated against real,
 * anonymized notifications before any claim of production coverage (see docs/architecture/ingestion.md).
 */
export const BCP_EMAIL_SENDER_DOMAINS = ['notificacionesbcp.com.pe', 'bcp.com.pe'];
export const BCP_SMS_SENDERS = ['BCP'];

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
