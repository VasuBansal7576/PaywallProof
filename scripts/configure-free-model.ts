import { randomBytes } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { FREE_GATEWAY_ORIGIN, FREE_MODEL_ID, FREE_RUNTIME_MODEL, verifyFreeModel } from '../packages/adapters/src/free-model.ts';
import { freeModelPaths, readModelSecret } from './free-model-config.ts';

// Key creation is a separate explicit operator action. This script never
// purchases credits, changes a spend limit or generates model tokens.
try {
  const apiKey = await readModelSecret(freeModelPaths.key);
  const verified = await verifyFreeModel(apiKey);
  let gatewayToken: string;
  try { gatewayToken = await readModelSecret(freeModelPaths.gatewayToken); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    gatewayToken = randomBytes(32).toString('hex');
    await writeFile(freeModelPaths.gatewayToken, gatewayToken, { mode: 0o600, flag: 'wx' });
  }
  const client = new TrueForge({ baseUrl: 'http://127.0.0.1:8790', maxRetries: 0, timeoutInSeconds: 15 });
  await client.settings.modelProviders.createOrUpdate({ manifest: {
    type: 'custom', name: 'paywallproof-free', baseUrl: `${FREE_GATEWAY_ORIGIN}/v1`, auth: { apiKey: gatewayToken },
    models: [{ name: 'gemma-4-31b', modelId: FREE_MODEL_ID, properties: { contextLength: verified.contextLength, maxOutputTokens: 8192 } }],
  } });
  const { data: providers } = await client.settings.modelProviders.list();
  const registered = providers.find(provider => provider.name === 'paywallproof-free');
  if (registered?.manifest.type !== 'custom' || registered.manifest.baseUrl !== `${FREE_GATEWAY_ORIGIN}/v1`
    || registered.manifest.models.length !== 1 || registered.manifest.models[0]?.modelId !== FREE_MODEL_ID) throw new Error('FREE_MODEL_REGISTRATION_MISMATCH');
  const temporary = `${freeModelPaths.selection}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify({ model: FREE_RUNTIME_MODEL }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, freeModelPaths.selection);
  process.stdout.write('Free hosted model configured. No inference was performed. Start pnpm dev:model before starting a run.\n');
} catch {
  // SDK exceptions may contain request headers. Never print them.
  process.stderr.write('Free model setup blocked. Check the private key file, its zero-dollar limit with BYOK included, current free model availability and local TrueForge. No paid fallback was attempted.\n');
  process.exitCode = 1;
}
