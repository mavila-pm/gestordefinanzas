import { createHash } from 'node:crypto';
import type { RawFinancialEvent } from '../domain/types';

/** Hard cap for untrusted message bodies. Anything larger is rejected, not truncated. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Converts an untrusted HTML/text body into plain text. HTML is never rendered or executed:
 * script/style blocks are dropped and remaining tags are removed.
 */
export function toPlainText(body: string): string {
  return body
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
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
