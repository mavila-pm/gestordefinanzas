import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const config: NextConfig = {
  poweredByHeader: false,
  // capjs-core lazily imports esbuild (only for its optional instrumentation, unused here): load it from node_modules
  // at runtime instead of bundling a native binary.
  serverExternalPackages: ['capjs-core'],
  // Camera reads send up to 3 images, downscaled to ~1600px JPEG in the browser (ADR-0006).
  experimental: { serverActions: { bodySizeLimit: '4mb' } },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
