import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['better-sqlite3'],
};

export default config;
