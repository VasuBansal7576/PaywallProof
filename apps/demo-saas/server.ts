import { resolve } from 'node:path';
import { createReferenceApp } from '../../packages/reference/src/index';

let target: ReturnType<typeof createReferenceApp> | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('REFERENCE_CONFIGURATION_REQUIRED');
  return value;
}

/** Only route handlers import this module. No credential crosses into the client bundle. */
export async function handleReferenceRequest(request: Request): Promise<Response> {
  try {
    target ??= createReferenceApp({
      databasePath: process.env.REFERENCE_DATABASE_PATH ?? resolve(process.cwd(), '.local/reference-v2.sqlite'),
      stagingEnabled: process.env.STAGING_ENABLED === 'true',
      adapterToken: required('TARGET_ADAPTER_TOKEN'),
      webhookSecret: required('POLAR_WEBHOOK_SECRET'),
      replaySecret: required('LOCAL_REPLAY_SECRET'),
      priceId: required('BILLING_PRICE_ID'),
      buildId: required('TARGET_BUILD_ID'),
      polarToken: process.env.POLAR_REFERENCE_TOKEN,
      polarOrganizationId: process.env.POLAR_ORGANIZATION_ID,
      polarProductId: process.env.POLAR_PRODUCT_ID,
    });
    return await target.app.fetch(request);
  } catch {
    return Response.json({ error: 'REFERENCE_CONFIGURATION_REQUIRED' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
