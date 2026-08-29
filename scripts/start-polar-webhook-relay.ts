import { serve } from '@hono/node-server';
import { createPolarWebhookRelay } from './polar-webhook-relay.ts';

const port = 3901;
const server = serve({ fetch: createPolarWebhookRelay().fetch, hostname: '127.0.0.1', port });
process.stderr.write(
  `Polar webhook relay listening on http://127.0.0.1:${port}/api/polar/webhook\n`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => server.close(() => process.exit(0)));
