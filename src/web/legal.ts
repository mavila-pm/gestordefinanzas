/**
 * Published versions of the legal documents (must exist in public.legal_documents; registration records which
 * version each person accepted). Publishing a new version = new migration row + bump here + new page text.
 */
export const TERMS_VERSION = '2026-10-08';
export const PRIVACY_VERSION = '2026-10-08';
export const LEGAL_UPDATED = '8 de octubre de 2026';
/**
 * The published Terms describe charges, renewals, cancellation and refunds (ADR-0019). The 2026-10-08 version says
 * "Hoy Velsuno no realiza cobros": while this is false, LIVE card payments stay disabled (src/billing/config.ts);
 * sandbox (test keys) still works. Set to true only together with the new Terms text + version approved by the PO.
 */
export const TERMS_COVER_BILLING = false;
