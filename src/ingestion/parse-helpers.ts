import { parseAmountToMinor, parseCurrencyMarker, type Currency } from '../domain/money';
import { limaIso, parseNumericDate } from './lima-time';

/**
 * Bank-agnostic reading helpers shared by every adapter. They only read what is printed: anything unclear returns
 * null/'ambiguous' and the adapter reports malformed. No bank names or templates live here.
 */

/** Currency markers printed by Peruvian banks and apps: S/, S/., US$, $, PEN, USD (case-insensitive). */
export const CURRENCY_MARKER = String.raw`(?:S\/\.?|US\$|\$|PEN|USD)`;
/** Marker + amount ("S/ 1,234.56", "USD 12"), as a regex fragment for whole-message templates. */
export const MONEY_EXPR = String.raw`${CURRENCY_MARKER}\s*[\d,]+(?:\.\d{1,2})?`;

const MONEY_RE = new RegExp(String.raw`^(${CURRENCY_MARKER})\s*([\d,]+(?:\.\d{1,2})?)$`, 'i');

/** "S/ 1,234.56" -> { 123456, PEN }. Rejects "1.234,56", 0, negatives and unknown markers (null, never a guess). */
export function parseMoneyExpr(s: string): { amountMinor: number; currency: Currency } | null {
  const m = MONEY_RE.exec(s.trim());
  if (!m) return null;
  const currency = parseCurrencyMarker(m[1]!);
  const amountMinor = parseAmountToMinor(m[2]!);
  if (!currency || amountMinor === null) return null;
  return { amountMinor, currency };
}

/** Last 4 digits of a masked number ("************4821", "****1234", "•••• 1234"); null when not masked like that. */
export function last4(s: string | undefined): string | null {
  if (!s) return null;
  const m = /[*xX•]+\s*(\d{4})\s*$/.exec(s.trim());
  return m ? m[1]! : null;
}

/** Lower-cased domain of an email sender ("Banco <avisos@banco.example>" -> "banco.example"); null if none. */
export function emailDomain(sender: string): string | null {
  return /@([a-z0-9.-]+)>?\s*$/i.exec(sender.trim())?.[1]?.toLowerCase() ?? null;
}

export function cleanMerchant(s: string | undefined): string | null {
  if (!s) return null;
  const v = s.trim().replace(/\s+/g, ' ').slice(0, 120);
  return v.length ? v : null;
}

/**
 * Reads "Label: value" lines. Each regex must be global/multiline with one capture group. A label that appears more
 * than once (corruption or injected text) makes the whole message ambiguous: the caller must not pick one.
 */
export function readLabels<K extends string>(text: string, labels: Readonly<Record<K, RegExp>>):
  { ok: true; values: Partial<Record<K, string>> } | { ok: false; ambiguous: K } {
  const values: Partial<Record<K, string>> = {};
  for (const key of Object.keys(labels) as K[]) {
    const matches = [...text.matchAll(labels[key])];
    if (matches.length > 1) return { ok: false, ambiguous: key };
    const v = matches[0]?.[1]?.trim();
    if (v !== undefined) values[key] = v;
  }
  return { ok: true, values };
}

/** "15/09/2026" + "20:30" (24 h) -> Lima ISO; null for impossible dates or times. */
export function parseDateAndTime(date: string, time: string): string | null {
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const d = parseNumericDate(`${date.trim()} 00:00`);
  if (!t || !d) return null;
  return limaIso(Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10)), Number(t[1]), Number(t[2]));
}
