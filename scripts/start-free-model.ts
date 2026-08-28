import { serve } from '@hono/node-server';
import { createFreeModelGateway, verifyFreeModel } from '../packages/adapters/src/free-model.ts';
import { freeModelPaths, readModelSecret } from './free-model-config.ts';

try {
  const apiKey = await readModelSecret(freeModelPaths.key);
  const gatewayToken = await readModelSecret(freeModelPaths.gatewayToken);
  await verifyFreeModel(apiKey);
  const app = createFreeModelGateway({ apiKey, gatewayToken });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 8791 });
  server.on('error', () => { process.stderr.write('Free model gateway could not bind loopback port 8791.\n'); process.exitCode = 1; });
  process.stdout.write('Free model policy gateway on loopback8791. Inference is remote; no model weights are loaded.\n');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
} catch {
  process.stderr.write('Free model gateway blocked. No inference, automatic upgrade or local model startup was attempted.\n');
  process.exitCode = 1;
}
