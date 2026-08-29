import { constants } from 'node:fs';
import { open, lstat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CODEX_RUNTIME_MODEL } from '#integrations/codex-subscription';

export const modelPaths = {
  gatewayToken: resolve('.local/codex-model-gateway-token'),
};

export async function privateLocalDirectory() {
  const directory = resolve('.local');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
    throw new Error('MODEL_STATE_DIRECTORY_MUST_BE_PRIVATE');
}

export async function readModelSecret(path: string) {
  await privateLocalDirectory();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 4096 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error('MODEL_SECRET_MUST_BE_AN_OWNED_PRIVATE_FILE');
    const value = (await file.readFile('utf8')).trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new Error('MODEL_SECRET_INVALID');
    return value;
  } finally {
    await file.close();
  }
}

/** The selected connection never falls back to a paid API or another model. */
export async function runtimeModel() {
  return process.env.TRUEFORGE_MODEL ?? CODEX_RUNTIME_MODEL;
}
