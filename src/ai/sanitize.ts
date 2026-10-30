/**
 * Secrets never travel further than this function (adenda §16-§17): CVV, PIN, passwords, OTP/verification codes
 * and bank keys are dropped; full card/account numbers keep only their last 4 digits; identity document numbers
 * (DNI, carné de extranjería, pasaporte, RUC) are dropped. Applied to every user message BEFORE it is stored, logged
 * or sent to Gemini. Fixed patterns only; when in doubt it removes too much rather than too little.
 */
/** A word that announces a secret: "clave", "contraseña", "cvv", "pin", "token", "código de verificación"… */
const LABEL = /\b(cvv2?|cvc|c[oó]digo de seguridad|pin|clave|contrase[nñ]a|password|otp|token|c[oó]digo de verificaci[oó]n|c[oó]digo sms)(?![\p{L}\d])/giu;
/**
 * Words between the label and the secret, skipped (folded): "clave SOL", "clave web es …", "la clave de mi cuenta BCP
 * es …", "contraseña: …". The first other word is the secret ("clave sol MiClave2024" → MiClave2024, never "sol").
 */
const QUALIFIERS = new Set([
  'de', 'del', 'la', 'el', 'lo', 'mi', 'mis', 'su', 'tu', 'es', 'era', 'son', 'seria', 'sera', 'que', 'me', 'te', 'por', 'para', 'actual', 'nueva', 'nuevo',
  'sol', 'web', 'internet', 'online', 'digital', 'token', 'secreta', 'secreto', 'dinamica', 'acceso', 'ingreso', 'banco', 'bancaria', 'bancario', 'banca',
  'tarjeta', 'cuenta', 'app', 'aplicacion', 'virtual', 'personal', 'sms', 'cajero', 'digitos', 'numeros', 'letras', 'llego', 'enviaron', 'mandaron', 'dieron',
  'bcp', 'bbva', 'interbank', 'ibk', 'scotiabank', 'scotia', 'banbif', 'pichincha', 'falabella', 'ripley', 'mibanco', 'yape', 'plin', 'caja',
]);
const TOKEN = /\s*(?:[:=#]\s*)*(\S+)/y;
const TRAIL = /[.,;:!?)\]"'»]+$/;
const foldWord = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** "Me llegó el código 482913", "el código que me llegó es 482913": a short code near "código" (not an amount). */
const CODE = /\b(c[oó]digo)\b((?:\s+[^\s\d]+){0,5}?)(\s*[:=#]?\s*)(\d{4,8})\b(?!\s*(?:soles|sol|d[oó]lares|mil|k\b|lucas?)|[.,]\d)/giu;
const SEP = String.raw`\s*(?:(?:n[°º.]?|nro\.?|n[uú]mero|es|:|#|-)\s*)*`;
const DNI = new RegExp(String.raw`\b(dni|d\.n\.i\.?|documento(?: de identidad)?)${SEP}(\d{8})\b`, 'giu');
const FOREIGN_ID = new RegExp(String.raw`\b(carn[eé]t? de extranjer[ií]a|c\.e\.|ce)${SEP}(\d{6,12})\b`, 'giu');
const PASSPORT = new RegExp(String.raw`\b(pasaporte)${SEP}([a-z]{0,3}\d{5,12})\b`, 'giu');
const RUC = new RegExp(String.raw`\b(ruc)${SEP}(\d{11})\b`, 'giu');
// 13-20 digits, optionally grouped by spaces, dots or dashes (card PAN "4557.8800.1234.5678", long accounts, CCI).
const LONG_NUMBER = /\b\d(?:[ .-]?\d){12,19}\b/g;
// BCP-style account: 191-12345678-0-12
const ACCOUNT = /\b\d{3}-\d{7,8}-\d-\d{2}\b/g;

export interface Sanitized { text: string; redacted: boolean }

/** After each secret label, the first word that is not a connector or qualifier is the secret: it is removed. */
function dropLabelled(text: string, mark: () => void): string {
  let out = '';
  let pos = 0;
  for (const m of text.matchAll(LABEL)) {
    if (m.index! < pos) continue;
    let i = m.index! + m[0].length;
    for (let skipped = 0; skipped <= 6; skipped++) {
      TOKEN.lastIndex = i;
      const t = TOKEN.exec(text);
      if (!t || /^[.,;!?]/.test(t[1]!)) break; // the sentence ended with the label: nothing to drop
      const raw = t[1]!;
      const word = raw.replace(TRAIL, '');
      const start = TOKEN.lastIndex - raw.length;
      const folded = foldWord(word);
      if (QUALIFIERS.has(folded) || /^\d{1,2}$/.test(folded)) {
        if (word !== raw) break; // "clave sol, …": punctuation ends the phrase
        i = TOKEN.lastIndex;
        continue;
      }
      if (word.length >= 3) { out += `${text.slice(pos, start)}[omitido]`; pos = start + word.length; mark(); }
      break;
    }
  }
  return out + text.slice(pos);
}

export function sanitizeUserText(raw: string): Sanitized {
  let redacted = false;
  const mark = (s = '') => { redacted = true; return s; };
  let text = raw.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  // Long numbers first: a card number written next to a label keeps only its last 4 digits, never more.
  text = text.replace(ACCOUNT, (m) => mark(`•••• ${m.replace(/\D/g, '').slice(-4)}`));
  text = text.replace(LONG_NUMBER, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 13 ? mark(`•••• ${digits.slice(-4)}`) : m;
  });
  text = dropLabelled(text, () => mark());
  text = text.replace(CODE, (_m, label: string, words: string, sep: string) => mark(`${label}${words}${sep}[omitido]`));
  for (const re of [DNI, FOREIGN_ID, PASSPORT, RUC]) text = text.replace(re, (m, _label: string, value: string) => mark(`${m.slice(0, m.length - value.length).trimEnd()} [omitido]`));
  return { text: text.trim().slice(0, 1500), redacted };
}
