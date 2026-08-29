import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { createControlApp } from './http.ts';
import { artifactRetentionFromDays } from './artifacts.ts';
function required(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}; use pnpm dev to configure local services.`);
  return value;
}
const control = createControlApp({
  databasePath: process.env.CONTROL_DATABASE_PATH ?? resolve('.local/control-v2.sqlite'),
  artifactDirectory: resolve('.local/artifacts'),
  artifactRetentionMs: artifactRetentionFromDays(process.env.ARTIFACT_RETENTION_DAYS),
  targetOrigin: process.env.TARGET_ORIGIN ?? 'http://127.0.0.1:3001',
  workerOrigin: 'http://127.0.0.1:8787',
  webOrigin: 'http://127.0.0.1:3000',
  adapterToken: required('TARGET_ADAPTER_TOKEN'),
  replaySecret: required('LOCAL_REPLAY_SECRET'),
  operatorToken: required('OPERATOR_TOKEN'),
  repository: process.env.PROJECT_REPOSITORY ?? 'VasuBansal7576/PaywallProof',
  defaultRef: required('TARGET_BUILD_ID'),
  priceId: required('BILLING_PRICE_ID'),
  polarToken: process.env.POLAR_ACCESS_TOKEN,
  polarOrganizationId: process.env.POLAR_ORGANIZATION_ID,
  polarProductId: process.env.POLAR_PRODUCT_ID,
  testCustomerEmail: process.env.POLAR_TEST_CUSTOMER_EMAIL,
  runtimeUrl: 'http://127.0.0.1:8790',
  model: process.env.TRUEFORGE_MODEL ?? 'paywallproof-local/qwen3-4b-instruct',
});
const server = serve({ fetch: control.app.fetch, hostname: '127.0.0.1', port: 8787 });
void control.controller.recover();
process.stderr.write('PaywallProof worker listening on http://127.0.0.1:8787\n');
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close(() => {
      control.close();
      process.exit(0);
    });
  });
