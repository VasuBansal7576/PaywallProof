import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const credentials = z
  .object({
    environment: z.literal('sandbox'),
    organizationId: z.uuid(),
    productId: z.uuid(),
    priceId: z.uuid(),
    workerToken: z.string(),
    referenceToken: z.string(),
    ownerEmail: z.email(),
  })
  .parse(JSON.parse(await readFile('.local/polar-sandbox-setup/credentials.json', 'utf8')));
const webhook = z
  .object({
    environment: z.literal('sandbox'),
    secret: z.string().min(16),
    enabled: z.literal(true),
  })
  .parse(JSON.parse(await readFile('.local/polar-sandbox-setup/webhook.json', 'utf8')));

const child = spawn('pnpm', ['dev'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    POLAR_ACCESS_TOKEN: credentials.workerToken,
    POLAR_REFERENCE_TOKEN: credentials.referenceToken,
    POLAR_ORGANIZATION_ID: credentials.organizationId,
    POLAR_PRODUCT_ID: credentials.productId,
    BILLING_PRICE_ID: credentials.priceId,
    POLAR_WEBHOOK_SECRET: webhook.secret,
    POLAR_TEST_CUSTOMER_EMAIL: credentials.ownerEmail,
  },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
