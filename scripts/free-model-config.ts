import { constants } from 'node:fs';
import { open, lstat, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { FREE_RUNTIME_MODEL } from '../packages/adapters/src/free-model.ts';

export const freeModelPaths = {
  key: resolve('.local/openrouter-api-key'),
  gatewayToken: resolve('.local/free-model-gateway-token'),
  selection: resolve('.local/runtime-model.json'),
};

export async function privateLocalDirectory() {
  const directory = resolve('.local');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('MODEL_STATE_DIRECTORY_MUST_BE_PRIVATE');
}

export async function readModelSecret(path: string) {
  await privateLocalDirectory();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096 || stat.uid !== process.getuid?.()) throw new Error('MODEL_SECRET_MUST_BE_AN_OWNED_PRIVATE_FILE');
    const value = (await file.readFile('utf8')).trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new Error('MODEL_SECRET_INVALID');
    return value;
  } finally { await file.close(); }
}

/** A saved selection never silently falls back when its service is unavailable. */
export async function runtimeModel() {
  if (process.env.TRUEFORGE_MODEL) return process.env.TRUEFORGE_MODEL;
  try {
    const selection = z.strictObject({ model: z.literal(FREE_RUNTIME_MODEL) }).parse(JSON.parse(await readFile(freeModelPaths.selection, 'utf8')));
    return selection.model;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return 'paywallproof-local/qwen3-4b-instruct';
  }
}
