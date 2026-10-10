import { capSecretInfo } from '../../../../lib/cap-core';

/**
 * GET /api/cap/status — is the anti-bot check usable in this deployment? For diagnosis (PO, support): says whether a
 * signing secret is present and where it comes from; never the secret or anything derived from it.
 */
export function GET() {
  const { source } = capSecretInfo();
  return Response.json({ ready: source !== 'missing', source }, { headers: { 'Cache-Control': 'no-store' } });
}
