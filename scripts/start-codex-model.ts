import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { createCodexModelGateway } from '../packages/adapters/src/codex-model.ts';
import { verifyCodexSubscription, withCodexClient } from '../packages/adapters/src/codex-subscription.ts';
import { readModelSecret } from './free-model-config.ts';

try {
  const token = await readModelSecret(resolve('.local/codex-model-gateway-token'));
  await withCodexClient(AbortSignal.timeout(30000), verifyCodexSubscription);
  const app = createCodexModelGateway(token);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 8792 });
  server.on('error', () => { process.stderr.write('Codex gateway could not bind loopback port 8792.\n'); process.exitCode = 1; });
  process.stdout.write('Codex Luna subscription bridge on loopback8792. TrueForge retains tool execution. No local model weights.\n');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
} catch {
  process.stderr.write('Codex bridge blocked. No paid API fallback, credit purchase or model download attempted.\n');
  process.exitCode = 1;
}
