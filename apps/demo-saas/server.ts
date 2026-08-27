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
      databasePath: process.env.REFERENCE_DATABASE_PATH ?? resolve(process.cwd(), '.local/reference.sqlite'),
      stagingEnabled: process.env.STAGING_ENABLED === 'true',
      adapterToken: required('TARGET_ADAPTER_TOKEN'),
      webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
      replaySecret: required('LOCAL_REPLAY_SECRET'),
      priceId: required('STRIPE_PRICE_ID'),
      buildId: required('TARGET_BUILD_ID'),
      stripeKey: process.env.STRIPE_SECRET_KEY,
    });
    return await target.app.fetch(request);
  } catch {
    return Response.json({ error: 'REFERENCE_CONFIGURATION_REQUIRED' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
