import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

const artifactId = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.png$/);
const identifier = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value);
const timestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => Number.isSafeInteger(Date.parse(value)) && Date.parse(value) >= 0);
const metadataSchema = z.strictObject({
  id: artifactId,
  runId: identifier,
  observationId: identifier,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.literal('image/png'),
  source: z.literal('browser'),
  collectedAt: timestamp,
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  expiresAt: timestamp.optional(),
});
const repairMetadataSchema = metadataSchema
  .extend({
    repairRunId: z.uuid(),
    repairJobId: z.uuid(),
    phase: z.enum(['before', 'after']),
  })
  .refine((value) => value.repairRunId !== value.runId);

/** Only the worker's complete repair annotation may be removed at the download boundary. */
export function artifactDownloadMetadata(stored: unknown): unknown {
  const repair = repairMetadataSchema.safeParse(stored);
  // Keep malformed records intact so the strict download service rejects them.
  return repair.success ? metadataSchema.strip().parse(repair.data) : stored;
}
const inputSchema = z.strictObject({ runId: identifier, artifactId });
const configurationSchema = z.strictObject({
  rootDirectory: z.string().min(1).refine(isAbsolute),
  retentionMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxBytes: z
    .number()
    .int()
    .min(8)
    .max(50 * 1024 * 1024),
});
const messages = {
  ARTIFACT_INPUT_INVALID: 'The artifact request is invalid.',
  ARTIFACT_NOT_FOUND: 'No screenshot receipt was recorded for this artifact.',
  ARTIFACT_RUN_MISMATCH: 'This screenshot does not belong to the requested run.',
  ARTIFACT_EXPIRED: 'This screenshot has expired under the artifact retention policy.',
  ARTIFACT_MISSING: 'The recorded screenshot is no longer available in storage.',
  ARTIFACT_METADATA_INVALID: 'The stored screenshot receipt could not be verified.',
  ARTIFACT_UNSAFE_FILE: 'The screenshot storage location is not safe to read.',
  ARTIFACT_TOO_LARGE: 'The screenshot exceeds the allowed download size.',
  ARTIFACT_CORRUPT: 'The screenshot bytes do not match their recorded receipt.',
  ARTIFACT_UNAVAILABLE: 'Screenshot storage is unavailable. No image was returned.',
  ARTIFACT_CONFIGURATION_INVALID: 'The artifact service configuration is invalid.',
};
const statuses = {
  ARTIFACT_INPUT_INVALID: 400,
  ARTIFACT_NOT_FOUND: 404,
  ARTIFACT_RUN_MISMATCH: 403,
  ARTIFACT_EXPIRED: 410,
  ARTIFACT_MISSING: 404,
  ARTIFACT_METADATA_INVALID: 422,
  ARTIFACT_UNSAFE_FILE: 422,
  ARTIFACT_TOO_LARGE: 413,
  ARTIFACT_CORRUPT: 422,
  ARTIFACT_UNAVAILABLE: 503,
  ARTIFACT_CONFIGURATION_INVALID: 500,
} satisfies Record<keyof typeof messages, 400 | 403 | 404 | 410 | 413 | 422 | 500 | 503>;
export class ArtifactError extends Error {
  readonly status: (typeof statuses)[keyof typeof statuses];
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.status = statuses[code];
  }
}
export function artifactRetentionFromDays(value: unknown): number {
  const parsed = z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .positive()
        .max(Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000)),
    )
    .safeParse(value === undefined ? '7' : value);
  if (!parsed.success) throw new ArtifactError('ARTIFACT_CONFIGURATION_INVALID');
  return parsed.data * 86_400_000;
}
export type ArtifactMetadata = z.infer<typeof metadataSchema>;
export type ArtifactServiceOptions = {
  rootDirectory: string;
  lookup: (artifactId: string) => unknown | Promise<unknown>;
  now?: () => number;
  retentionMs?: number;
  maxBytes?: number;
};

function storageError(error: unknown): ArtifactError {
  if (error instanceof ArtifactError) return error;
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'ENOENT') return new ArtifactError('ARTIFACT_MISSING');
    if (['ELOOP', 'ENOTDIR', 'EISDIR', 'ENXIO'].includes(String(error.code)))
      return new ArtifactError('ARTIFACT_UNSAFE_FILE');
  }
  return new ArtifactError('ARTIFACT_UNAVAILABLE');
}

/** Read-only service. The caller authenticates the operator and verifies the run exists. */
export function createArtifactService(options: ArtifactServiceOptions) {
  if (!options || typeof options !== 'object')
    throw new ArtifactError('ARTIFACT_CONFIGURATION_INVALID');
  const parsed = configurationSchema.safeParse({
    rootDirectory: options.rootDirectory,
    retentionMs: options.retentionMs ?? 7 * 24 * 60 * 60 * 1000,
    maxBytes: options.maxBytes ?? 10 * 1024 * 1024,
  });
  if (
    !parsed.success ||
    typeof options.lookup !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    !constants.O_NOFOLLOW ||
    !constants.O_DIRECTORY
  )
    throw new ArtifactError('ARTIFACT_CONFIGURATION_INVALID');
  const config = parsed.data;
  // Bind the directory now. A later read cannot silently adopt a replacement directory.
  const root = (() => {
    try {
      const configuredStat = lstatSync(config.rootDirectory);
      if (!configuredStat.isDirectory() || configuredStat.isSymbolicLink())
        throw new ArtifactError('ARTIFACT_UNSAFE_FILE');
      const canonical = realpathSync(config.rootDirectory);
      const canonicalStat = lstatSync(canonical);
      if (
        !canonicalStat.isDirectory() ||
        canonicalStat.isSymbolicLink() ||
        canonicalStat.dev !== configuredStat.dev ||
        canonicalStat.ino !== configuredStat.ino
      )
        throw new ArtifactError('ARTIFACT_UNSAFE_FILE');
      return { canonical, dev: canonicalStat.dev, ino: canonicalStat.ino };
    } catch (error) {
      throw storageError(error);
    }
  })();
  async function verifyRoot() {
    try {
      const configured = await lstat(config.rootDirectory);
      const canonical = await lstat(root.canonical);
      if (
        !configured.isDirectory() ||
        configured.isSymbolicLink() ||
        !canonical.isDirectory() ||
        canonical.isSymbolicLink() ||
        configured.dev !== root.dev ||
        configured.ino !== root.ino ||
        canonical.dev !== root.dev ||
        canonical.ino !== root.ino
      )
        throw new ArtifactError('ARTIFACT_UNSAFE_FILE');
    } catch (error) {
      // A bound directory disappearing is a root replacement, not a new trusted root.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new ArtifactError('ARTIFACT_UNSAFE_FILE');
      throw storageError(error);
    }
  }
  const now = options.now ?? Date.now;
  return {
    async read(
      input: unknown,
    ): Promise<{ bytes: Uint8Array<ArrayBuffer>; metadata: ArtifactMetadata }> {
      const request = inputSchema.safeParse(input);
      if (!request.success) throw new ArtifactError('ARTIFACT_INPUT_INVALID');
      await verifyRoot();
      let stored: unknown;
      try {
        stored = await options.lookup(request.data.artifactId);
      } catch {
        throw new ArtifactError('ARTIFACT_UNAVAILABLE');
      }
      await verifyRoot();
      if (stored === null || stored === undefined) throw new ArtifactError('ARTIFACT_NOT_FOUND');
      const receipt = metadataSchema.safeParse(stored);
      if (!receipt.success || receipt.data.id !== request.data.artifactId)
        throw new ArtifactError('ARTIFACT_METADATA_INVALID');
      const metadata = receipt.data;
      if (metadata.runId !== request.data.runId) throw new ArtifactError('ARTIFACT_RUN_MISMATCH');
      let currentTime: number;
      try {
        currentTime = now();
      } catch {
        throw new ArtifactError('ARTIFACT_CONFIGURATION_INVALID');
      }
      if (!Number.isSafeInteger(currentTime) || currentTime < 0)
        throw new ArtifactError('ARTIFACT_CONFIGURATION_INVALID');
      const collectedAt = Date.parse(metadata.collectedAt);
      const explicitExpiry = metadata.expiresAt
        ? Date.parse(metadata.expiresAt)
        : Number.MAX_SAFE_INTEGER;
      if (collectedAt > currentTime + 10_000 || explicitExpiry < collectedAt)
        throw new ArtifactError('ARTIFACT_METADATA_INVALID');
      const retentionExpiry =
        collectedAt > Number.MAX_SAFE_INTEGER - config.retentionMs
          ? Number.MAX_SAFE_INTEGER
          : collectedAt + config.retentionMs;
      if (currentTime >= Math.min(retentionExpiry, explicitExpiry))
        throw new ArtifactError('ARTIFACT_EXPIRED');
      const path = join(root.canonical, metadata.id);
      // NONBLOCK prevents a malicious FIFO from hanging open before fstat can reject it.
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        throw storageError(error);
      }
      let result:
        | { kind: 'verified'; bytes: Uint8Array<ArrayBuffer> }
        | { kind: 'failed'; error: ArtifactError };
      try {
        await verifyRoot();
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1) throw new ArtifactError('ARTIFACT_UNSAFE_FILE');
        if (!Number.isSafeInteger(before.size) || before.size > config.maxBytes)
          throw new ArtifactError('ARTIFACT_TOO_LARGE');
        if (
          before.size < 8 ||
          (metadata.sizeBytes !== undefined && metadata.sizeBytes !== before.size)
        )
          throw new ArtifactError('ARTIFACT_CORRUPT');
        const bytes = new Uint8Array(before.size);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const result = await file.read(bytes, offset, bytes.byteLength - offset, offset);
          if (result.bytesRead === 0) throw new ArtifactError('ARTIFACT_CORRUPT');
          offset += result.bytesRead;
        }
        const growth = await file.read(new Uint8Array(1), 0, 1, bytes.byteLength);
        if (growth.bytesRead !== 0) throw new ArtifactError('ARTIFACT_CORRUPT');
        const after = await file.stat();
        if (
          !after.isFile() ||
          after.nlink !== 1 ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new ArtifactError('ARTIFACT_CORRUPT');
        await verifyRoot();
        const signature = [137, 80, 78, 71, 13, 10, 26, 10];
        if (
          !signature.every((value, index) => bytes[index] === value) ||
          createHash('sha256').update(bytes).digest('hex') !== metadata.sha256
        )
          throw new ArtifactError('ARTIFACT_CORRUPT');
        result = { kind: 'verified', bytes };
      } catch (error) {
        result = { kind: 'failed', error: storageError(error) };
      }
      let closeError: ArtifactError | undefined;
      try {
        await file.close();
      } catch (error) {
        closeError = storageError(error);
      }
      if (result.kind === 'failed') throw result.error;
      if (closeError) throw closeError;
      return { bytes: result.bytes, metadata };
    },
  };
}
