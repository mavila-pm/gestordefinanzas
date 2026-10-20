import { createHash } from 'node:crypto';
import type { RawFinancialEvent } from '../domain/types';

/** Hard cap for untrusted message bodies. Anything larger is rejected, not truncated. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Fixed list of named entities seen in Spanish bank emails. Anything else is left as written (never guessed). */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  NBSP: ' ', AMP: '&', LT: '<', GT: '>', QUOT: '"',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iexcl: '¡', iquest: '¿',
};

/**
 * Numeric references: BMP only, never control characters or surrogates. A decoded "&#10;" could otherwise turn text
 * inside one field into a new "Label: value" line.
 */
function decodeCodePoint(cp: number): string | null {
  if (!Number.isInteger(cp) || cp > 0xffff) return null;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  return String.fromCharCode(cp);
}

/** Single pass (so "&amp;lt;" becomes "&lt;", not "<"). Unknown or forbidden references stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (whole, ref: string) => {
    if (ref[0] !== '#') return Object.hasOwn(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref]! : whole;
    const hex = ref[1] === 'x' || ref[1] === 'X';
    return decodeCodePoint(hex ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)) ?? whole;
  });
}

/**
 * Converts an untrusted HTML/text body into plain text. HTML is never rendered or executed:
 * comments and script/style/head/title blocks are dropped, remaining tags are removed, then entities are decoded
 * (after tag removal, so an encoded "&lt;b&gt;" stays text).
 */
export function toPlainText(body: string): string {
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(stripped)
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function isWithinSizeLimit(raw: RawFinancialEvent): boolean {
  return Buffer.byteLength(raw.body, 'utf8') <= MAX_BODY_BYTES
    && Buffer.byteLength(raw.subject ?? '', 'utf8') <= 1024;
}

/** Stable id for sources that do not provide one (e.g. SMS): hash of the exact content. */
export function deriveExternalEventId(raw: RawFinancialEvent): string {
  if (raw.externalEventId) return raw.externalEventId;
  const h = createHash('sha256').update(`${raw.channel}\u0000${raw.sender}\u0000${raw.body}`).digest('hex');
  return `sha256:${h}`;
}
