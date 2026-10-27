/**
 * Culqi values that are safe in the browser (no Node imports, no secrets): the Checkout script and the origins it
 * talks to. Everything else about Culqi is server-only (src/billing/culqi.ts, lib/culqi.ts). ADR-0019.
 */

/** Culqi Checkout Custom (v4). It opens Culqi's own window and returns a card token (tkn_…); card data never reaches Velsuno. */
export const CULQI_CHECKOUT_SCRIPT = 'https://js.culqi.com/checkout-js'; // CONFIRMED (culqi-php README); behaviour UNVERIFIED

/**
 * Origins the Content-Security-Policy must allow for the checkout (src/web/security-headers.ts, report-only, ADR-0018;
 * tests/csp.test.ts checks they are allowed). UNVERIFIED beyond js.culqi.com (script) and secure.culqi.com (tokens,
 * from the official SDK): confirm in the sandbox with the browser console (CSP reports) before enforcing the CSP.
 */
export const CULQI_CSP = {
  'script-src': ['https://js.culqi.com', 'https://3ds.culqi.com'],
  'frame-src': ['https://js.culqi.com', 'https://checkout.culqi.com', 'https://3ds.culqi.com'],
  'connect-src': ['https://secure.culqi.com', 'https://api.culqi.com', 'https://js.culqi.com', 'https://3ds.culqi.com'],
  'img-src': ['https://*.culqi.com'],
  'style-src': ['https://js.culqi.com'],
} as const;
