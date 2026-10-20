/**
 * Response security headers decided per request (pure; unit-tested). The static ones (frame, sniffing, referrer,
 * permissions, COOP) live in next.config.ts; proxy.ts adds these to every response it handles.
 */

/** HSTS: two years, subdomains included, no preload (preload is a separate, hard-to-undo owner decision). */
export const HSTS = 'max-age=63072000; includeSubDomains';

/**
 * Only answers that really travelled over https carry HSTS (browsers ignore it on http anyway; this keeps local
 * http servers clean). Vercel terminates TLS and forwards the scheme in x-forwarded-proto.
 */
export function isHttps(forwardedProto: string | null | undefined, protocol: string): boolean {
  const first = forwardedProto?.split(',')[0]?.trim().toLowerCase();
  return first ? first === 'https' : protocol === 'https:';
}
