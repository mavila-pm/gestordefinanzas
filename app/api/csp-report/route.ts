import { MAX_REPORT_BYTES, parseCspReports, readLimited } from '../../../src/web/csp-report';

/**
 * CSP violation reports (Content-Security-Policy-Report-Only, proxy.ts). Public by nature: any browser, or any script,
 * can post here, so the body is untrusted. At most 8 KB is read (413 above), at most 5 reports are kept, and each one
 * is logged as a single structured line with sanitised fields (src/web/csp-report.ts). Nothing is stored.
 */
const noContent = (status = 204) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_REPORT_BYTES) return noContent(413);
  const raw = await readLimited(request.body, MAX_REPORT_BYTES);
  if (raw === null) return noContent(413);
  for (const v of parseCspReports(raw)) console.warn(JSON.stringify({ event: 'csp_violation', ...v }));
  return noContent();
}
