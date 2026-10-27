/**
 * Money is always represented as integer minor units (céntimos / cents).
 * Never use floating point arithmetic for amounts.
 */
export type Currency = 'PEN' | 'USD';

export interface Money {
  /** Positive integer amount in minor units. Meaning comes from type/direction. */
  readonly amountMinor: number;
  readonly currency: Currency;
}

const AMOUNT_RE = /^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^\d+(?:\.\d{1,2})?$/;

/**
 * Parses a Peruvian bank amount string ("1,234.56", "100", "82.5") into minor units
 * using string arithmetic only. Returns null when the string is not an unambiguous amount.
 */
export function parseAmountToMinor(raw: string): number | null {
  const s = raw.trim();
  if (!AMOUNT_RE.test(s)) return null;
  const [intPart = '', decPart = ''] = s.replace(/,/g, '').split('.');
  const minor = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor <= 0) return null;
  return minor;
}

/** Maps a currency marker as printed by Peruvian banks to an ISO code. */
export function parseCurrencyMarker(raw: string): Currency | null {
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (s === 'S/' || s === 'S/.' || s === 'PEN') return 'PEN';
  if (s === 'US$' || s === '$' || s === 'USD') return 'USD';
  return null;
}

export function formatMoney(m: Money): string {
  const sign = m.currency === 'PEN' ? 'S/' : 'US$';
  const units = Math.trunc(m.amountMinor / 100).toLocaleString('en-US');
  const cents = String(m.amountMinor % 100).padStart(2, '0');
  return `${sign} ${units}.${cents}`;
}
