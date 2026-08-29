import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { POLAR_API_VERSION } from '#integrations/polar';

const credentialsPath = '.local/polar-sandbox-setup/credentials.json';
const receiptPath = '.local/polar-sandbox-setup/webhook.json';
const credentials = z
  .object({
    environment: z.literal('sandbox'),
    organizationId: z.uuid(),
    workerToken: z.string().regex(/^polar_oat_[A-Za-z0-9_-]+$/),
    workerScopes: z.array(z.string()),
  })
  .parse(JSON.parse(await readFile(credentialsPath, 'utf8')));
const endpoint = z
  .object({
    id: z.uuid(),
    environment: z.literal('sandbox'),
    organization_id: z.uuid(),
    url: z.url(),
    events: z.array(z.string()),
    enabled: z.literal(true),
  })
  .parse(JSON.parse(await readFile(receiptPath, 'utf8')));
if (!credentials.workerScopes.includes('webhooks:write'))
  throw new Error('POLAR_WEBHOOK_WRITE_SCOPE_REQUIRED');
if (endpoint.organization_id !== credentials.organizationId)
  throw new Error('POLAR_WEBHOOK_OWNERSHIP_MISMATCH');
const response = await fetch(`https://sandbox-api.polar.sh/v1/webhooks/endpoints/${endpoint.id}`, {
  method: 'DELETE',
  redirect: 'error',
  headers: {
    Authorization: `Bearer ${credentials.workerToken}`,
    Accept: 'application/json',
    'Polar-Version': POLAR_API_VERSION,
  },
  signal: AbortSignal.timeout(20_000),
});
if (![204, 404].includes(response.status))
  throw new Error(`POLAR_WEBHOOK_DELETE_HTTP_${response.status}`);
await writeFile(
  receiptPath,
  JSON.stringify({
    id: endpoint.id,
    environment: endpoint.environment,
    organization_id: endpoint.organization_id,
    url: endpoint.url,
    events: endpoint.events,
    enabled: false,
    deletedAt: new Date().toISOString(),
    providerStatus: response.status,
  }),
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify({ status: 'deleted', providerStatus: response.status })}\n`);
