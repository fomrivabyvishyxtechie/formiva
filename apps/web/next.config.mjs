// CSP note: Next.js App Router emits inline bootstrap scripts, so script-src needs 'unsafe-inline'
// until a nonce-based CSP is added (tracked in docs/evidence/phase-3/prompt-3.1b-web.md).
const isProd = process.env.NODE_ENV === 'production';

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Separate build folder so `next dev` and the production e2e build never overwrite each other.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  // ESLint runs separately (pnpm run lint); the build must not run a second, different lint.
  eslint: { ignoreDuringBuilds: true },
  reactStrictMode: true,
  transpilePackages: ['@formiva/contracts'],
  webpack: (config) => {
    // The contracts package uses NodeNext-style "./x.js" imports that point at .ts files.
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
  async headers() {
    const base = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ];
    return [
      {
        source: '/:path*',
        headers: isProd ? [...base, { key: 'Content-Security-Policy', value: csp }] : base,
      },
    ];
  },
};

export default nextConfig;
