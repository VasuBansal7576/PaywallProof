import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['better-sqlite3'],
  // Next 16.3's development React debug stream otherwise waits on HMR before
  // hydration. Access probes intentionally block websockets and need no debugger.
  experimental: { reactDebugChannel: false },
};

export default config;
