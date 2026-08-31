import { mkdir, readFile, writeFile, chmod, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { z } from 'zod';
import { runtimeModel } from './model-config.ts';

const root = resolve(import.meta.dirname, '..'),
  local = resolve(root, '.local');
await mkdir(local, { recursive: true, mode: 0o700 });
if (!(await lstat(local)).isDirectory())
  throw new Error('Local state directory must not be a symlink.');
await chmod(local, 0o700);
const configPath = resolve(local, 'development-secrets.json');
const schema = z.object({
  adapterToken: z.string(),
  replaySecret: z.string(),
  webhookSecret: z.string(),
  operatorToken: z.string(),
});
let config: z.infer<typeof schema>;
try {
  if (!(await lstat(configPath)).isFile())
    throw new Error('Development secrets must be a regular file.');
  await chmod(configPath, 0o600);
  config = schema.parse(JSON.parse(await readFile(configPath, 'utf8')));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  const secret = () => randomBytes(32).toString('hex');
  config = {
    adapterToken: secret(),
    replaySecret: `whsec_local_${secret()}`,
    webhookSecret: `whsec_unconfigured_${secret()}`,
    operatorToken: secret(),
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
}
const tokenPath = resolve(local, 'operator-token');
try {
  if (!(await lstat(tokenPath)).isFile()) throw new Error('Operator token must be a regular file.');
  await chmod(tokenPath, 0o600);
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
await writeFile(tokenPath, config.operatorToken, { mode: 0o600 });
await chmod(tokenPath, 0o600);
const build = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
process.env.TRUEFORGE_MODEL = await runtimeModel();
const env = {
  ...process.env,
  ARTIFACT_RETENTION_DAYS: process.env.ARTIFACT_RETENTION_DAYS ?? '60',
  STAGING_ENABLED: 'true',
  TARGET_BUILD_ID: build,
  PAYWALLPROOF_REVIEW_SKILL_REF: build,
  TARGET_ADAPTER_TOKEN: config.adapterToken,
  LOCAL_REPLAY_SECRET: config.replaySecret,
  POLAR_WEBHOOK_SECRET: process.env.POLAR_WEBHOOK_SECRET ?? config.webhookSecret,
  OPERATOR_TOKEN: config.operatorToken,
  BILLING_PRICE_ID: process.env.BILLING_PRICE_ID ?? 'price_local_replay_pro',
  REFERENCE_DATABASE_PATH: resolve(local, 'reference-v2.sqlite'),
  CONTROL_DATABASE_PATH: resolve(local, 'control-v2.sqlite'),
  WORKER_ORIGIN: 'http://127.0.0.1:8787',
};
const children = [
  ['exec', 'tsx', 'apps/worker/src/main.ts'],
  ['exec', 'next', 'dev', 'apps/demo-saas', '--hostname', '127.0.0.1', '--port', '3001'],
  ['exec', 'next', 'dev', 'apps/web', '--hostname', '127.0.0.1', '--port', '3000'],
].map((args) => spawn('pnpm', args, { cwd: root, env, stdio: 'inherit' }));
process.stderr.write(
  `Open http://127.0.0.1:3000. Operator token: ${resolve(local, 'operator-token')}\nLocal replay is available without provider credentials. TrueForge must already be running on loopback8790.\n`,
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
for (const child of children)
  child.on('exit', (code) => {
    if (!stopping && code !== 0) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
