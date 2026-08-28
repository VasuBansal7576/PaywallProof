import { randomBytes } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { CODEX_GATEWAY_ORIGIN, CODEX_MODEL_ID, CODEX_RUNTIME_MODEL, verifyCodexSubscription, withCodexClient } from '../packages/adapters/src/codex-subscription.ts';
import { freeModelPaths, privateLocalDirectory, readModelSecret } from './free-model-config.ts';

try {
  await privateLocalDirectory();
  await withCodexClient(AbortSignal.timeout(30000), verifyCodexSubscription);
  const tokenPath = resolve('.local/codex-model-gateway-token');
  let token: string;
  try { token = await readModelSecret(tokenPath); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    token = randomBytes(32).toString('hex');
    await writeFile(tokenPath, token, { mode: 0o600, flag: 'wx' });
  }
  const client = new TrueForge({ baseUrl: 'http://127.0.0.1:8790', maxRetries: 0, timeoutInSeconds: 15 });
  await client.settings.modelProviders.createOrUpdate({ manifest: {
    type: 'custom', name: 'paywallproof-codex', baseUrl: `${CODEX_GATEWAY_ORIGIN}/v1`, auth: { apiKey: token },
    // Conservative protocol envelope, not a claim about the model's maximum.
    models: [{ name: 'luna', modelId: CODEX_MODEL_ID, properties: { contextLength: 65536, maxOutputTokens: 8192 } }],
  } });
  const { data } = await client.settings.modelProviders.list();
  const provider = data.find(item => item.name === 'paywallproof-codex');
  if (provider?.manifest.type !== 'custom' || provider.manifest.baseUrl !== `${CODEX_GATEWAY_ORIGIN}/v1`
    || provider.manifest.models.length !== 1 || provider.manifest.models[0]?.modelId !== CODEX_MODEL_ID) throw new Error('CODEX_REGISTRATION_MISMATCH');
  const temporary = `${freeModelPaths.selection}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify({ model: CODEX_RUNTIME_MODEL }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, freeModelPaths.selection);
  process.stdout.write('Codex Luna subscription selected. No inference or billing change performed. Start pnpm dev:codex-model.\n');
} catch {
  process.stderr.write('Codex setup blocked. Requires signed-in ChatGPT Plus/Pro, available Luna allowance, zero extra credits and local TrueForge. No paid fallback attempted.\n');
  process.exitCode = 1;
}
