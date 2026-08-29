import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { POLAR_API_VERSION } from '#integrations/polar';
import { redact } from '#evidence';

const credentialsPath = '.local/polar-sandbox-setup/credentials.json';
const receiptPath = '.local/polar-sandbox-setup/webhook.json';
const credentialsSchema = z.object({
  environment: z.literal('sandbox'),
  organizationId: z.uuid(),
  workerToken: z.string().regex(/^polar_oat_[A-Za-z0-9_-]+$/),
  workerScopes: z.array(z.string()),
});
const endpointSchema = z.object({
  id: z.uuid(),
  url: z.url(),
  secret: z.string().min(16),
  organization_id: z.uuid(),
  events: z.array(z.string()),
  enabled: z.literal(true),
});
const events = [
  'order.paid',
  'subscription.created',
  'subscription.updated',
  'subscription.active',
  'subscription.canceled',
];

const credentials = credentialsSchema.parse(JSON.parse(await readFile(credentialsPath, 'utf8')));
if (!credentials.workerScopes.includes('webhooks:write'))
  throw new Error('POLAR_WEBHOOK_WRITE_SCOPE_REQUIRED');
const url = z
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.endsWith('.trycloudflare.com') &&
      parsed.pathname === '/api/polar/webhook' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  }, 'POLAR_WEBHOOK_RELAY_URL_REQUIRED')
  .parse(process.env.PAYWALLPROOF_POLAR_WEBHOOK_URL);
const response = await fetch('https://sandbox-api.polar.sh/v1/webhooks/endpoints', {
  method: 'POST',
  redirect: 'error',
  headers: {
    Authorization: `Bearer ${credentials.workerToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Polar-Version': POLAR_API_VERSION,
  },
  body: JSON.stringify({
    url,
    format: 'raw',
    events,
    name: 'PaywallProof temporary lifecycle verification',
  }),
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) {
  const detail: unknown = await response.json().catch(() => null);
  const safeDetail = JSON.stringify(redact(detail, [credentials.workerToken])).replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '[REDACTED_ID]',
  );
  throw new Error(`POLAR_WEBHOOK_CREATE_HTTP_${response.status}:${safeDetail}`);
}
const endpoint = endpointSchema.parse(await response.json());
if (
  endpoint.url !== url ||
  endpoint.organization_id !== credentials.organizationId ||
  !events.every((event) => endpoint.events.includes(event))
)
  throw new Error('POLAR_WEBHOOK_ENDPOINT_MISMATCH');
await writeFile(
  receiptPath,
  JSON.stringify({ ...endpoint, environment: 'sandbox', createdAt: new Date().toISOString() }),
  { mode: 0o600, flag: 'wx' },
);
process.stdout.write(
  `${JSON.stringify({ status: 'created', environment: 'sandbox', events: endpoint.events.length, receiptPath })}\n`,
);
