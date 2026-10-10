/**
 * Secrets never travel further than this function (adenda §16-§17): CVV, PIN, passwords, OTP/verification codes
 * and bank keys are dropped; full card/account numbers keep only their last 4 digits; DNI numbers are dropped.
 * Applied to every user message BEFORE it is stored, logged or sent to Gemini. Fixed patterns only.
 */
const SECRET = /\b(cvv2?|cvc|c[oó]digo de seguridad|pin|clave(?: de internet| digital| token)?|contrase[nñ]a|password|otp|token|c[oó]digo de verificaci[oó]n|c[oó]digo sms)\b\s*(?:es|era|:|=|#)?\s*[A-Za-z0-9*•-]{3,}/gi;
const DNI = /\b(dni|documento)\s*(?:n[°º.]?|nro\.?|:|#)?\s*\d{8}\b/gi;
// 13-19 digits, optionally grouped by spaces or dashes (card PAN) — also long account numbers / CCI (20 digits).
const LONG_NUMBER = /\b\d(?:[ -]?\d){12,19}\b/g;
// BCP-style account: 191-12345678-0-12
const ACCOUNT = /\b\d{3}-\d{7,8}-\d-\d{2}\b/g;

export interface Sanitized { text: string; redacted: boolean }

export function sanitizeUserText(raw: string): Sanitized {
  let redacted = false;
  const mark = (s: string) => { redacted = true; return s; };
  let text = raw.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  text = text.replace(SECRET, (_m, label: string) => mark(`${label} [omitido]`));
  text = text.replace(DNI, (_m, label: string) => mark(`${label} [omitido]`));
  text = text.replace(ACCOUNT, (m) => mark(`•••• ${m.replace(/\D/g, '').slice(-4)}`));
  text = text.replace(LONG_NUMBER, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 13 ? mark(`•••• ${digits.slice(-4)}`) : m;
  });
  return { text: text.trim().slice(0, 1500), redacted };
}
