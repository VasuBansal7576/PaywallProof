import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false, agentRules: false, devIndicators: false,
  // The embedded operator browser does not require Next's websocket debugger.
  experimental: { reactDebugChannel: false },
};
export default config;
