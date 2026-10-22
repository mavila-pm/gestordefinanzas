import { ingestRawEvent as ingestWithProductionDefaults } from '../../src/engine/ingest';

/**
 * FIXTURE STATUS: SYNTHETIC_FIXTURE helper. Engine-semantics tests use the synthetic BCP templates as stand-ins for
 * future VERIFIED templates, so they opt out EXPLICITLY of the delivered-path default (`requireVerifiedTemplate`,
 * on unless told otherwise). An explicit option passed by a test still wins.
 */
export const ingestAsVerifiedTemplate: typeof ingestWithProductionDefaults = (raw, ctx, repo, registry, opts) =>
  ingestWithProductionDefaults(raw, ctx, repo, registry, { requireVerifiedTemplate: false, ...opts });
