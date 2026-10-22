import type { RawFinancialEvent } from '../../domain/types';

export type SourceKind = 'email_bridge' | 'gmail' | 'android_sms';

export type SourceParseResult =
  | { ok: true; event: RawFinancialEvent }
  | { ok: false; error: string };

/**
 * A FinancialEventSource turns a provider-specific payload (inbound email webhook, Gmail API
 * message, Android SMS upload) into a RawFinancialEvent. It validates shape and size only;
 * it knows nothing about banks. Authentication/signature of the transport is the caller's job
 * (webhook handler) and happens BEFORE this.
 */
export interface FinancialEventSource<Payload = unknown> {
  readonly kind: SourceKind;
  toRawEvent(payload: Payload): SourceParseResult;
}

export const LIMITS = { sender: 320, subject: 1024, body: 64 * 1024, id: 512 } as const;

export function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

export function isoTimestamp(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
