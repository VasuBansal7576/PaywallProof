import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactError, createArtifactService } from '../../apps/worker/src/artifacts.ts';

// Independent public service tests using only this test's temporary files.
// PNG data is synthetic fixture data, never a claimed browser screenshot.

const originalTime = 1_800_000_000_000;
const sevenDays = 7 * 24 * 60 * 60 * 1_000;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZfkAAAAASUVORK5CYII=',
  'base64',
);
const runId = 'run_owned';
let directory: string;
let rootDirectory: string;
let artifactId: string;
let now: number;

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    id: artifactId,
    runId,
    observationId: 'browser_observation_owned',
    sha256: createHash('sha256').update(png).digest('hex'),
    contentType: 'image/png',
    source: 'browser',
    collectedAt: new Date(originalTime).toISOString(),
    ...overrides,
  };
}

function service(receipt: unknown = metadata(), overrides: Record<string, unknown> = {}) {
  return createArtifactService({
    rootDirectory,
    lookup: () => receipt,
    now: () => now,
    ...overrides,
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return { runId, artifactId, ...overrides };
}

function fixture(bytes: Uint8Array = png, id = artifactId) {
  writeFileSync(join(rootDirectory, id), bytes);
}

async function errorFrom(action: () => unknown, code: string, status: number) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toBeInstanceOf(ArtifactError);
  expect(caught).toMatchObject({ code, status });
  if (caught instanceof Error) {
    expect(caught.message).not.toContain(directory);
    expect(caught.message).not.toContain('SYNTHETIC_PRIVATE_LOOKUP_VALUE');
  }
  return caught;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'paywallproof-independent-artifacts-'));
  rootDirectory = join(directory, 'artifacts');
  mkdirSync(rootDirectory);
  artifactId = `${randomUUID()}.png`;
  now = originalTime;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('independent artifact: exact input and receipt ownership', () => {
  it('returns exactly the verified bytes and a detached receipt', async () => {
    fixture();
    const receipt = metadata({ sizeBytes: png.length });
    const reader = service(receipt);
    const result = await reader.read(input());
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result.bytes)).toEqual(png);
    expect(result.metadata).toEqual(receipt);
    try {
      Object.assign(result.metadata, { observationId: 'changed-output' });
    } catch {
      /* Frozen is acceptable. */
    }
    expect(receipt.observationId).toBe('browser_observation_owned');
    receipt.runId = 'changed-input';
    expect(result.metadata.runId).toBe(runId);
  });

  it('does not let mutation of returned bytes alter a subsequent verified read', async () => {
    fixture();
    const reader = service();
    const first = await reader.read(input());
    first.bytes[0] = 0;
    expect(Buffer.from((await reader.read(input())).bytes)).toEqual(png);
  });

  it.each(['1', '2', '3', '4', '5', '6', '7', '8'])(
    'accepts a canonical RFC UUID version %s filename',
    async (version) => {
      artifactId = `01234567-89ab-${version}def-8abc-0123456789ab.png`;
      fixture();
      expect(Buffer.from((await service().read(input())).bytes)).toEqual(png);
    },
  );

  it.each([
    '',
    'file.png',
    '../file.png',
    '/tmp/file.png',
    'folder/file.png',
    'folder\\file.png',
    '%2fetc%2fpasswd.png',
    '%2Fetc%2Fpasswd.png',
    '%5cfile.png',
    'file\0.png',
    '01234567-89AB-4DEF-8ABC-0123456789AB.png',
    '01234567-89ab-0def-8abc-0123456789ab.png',
    '01234567-89ab-9def-8abc-0123456789ab.png',
    '01234567-89ab-4def-cabc-0123456789ab.png',
    '01234567-89ab-4def-8abc-0123456789ab.png.exe',
    '01234567-89ab-4def-8abc-0123456789ab.png.png',
    '01234567-89ab-4def-8abc-0123456789ab.PNG',
    'https://example.invalid/image.png',
  ])('rejects invalid artifact name %s before lookup', async (invalidId) => {
    let lookups = 0;
    const reader = service(metadata(), {
      lookup: () => {
        lookups += 1;
        return metadata();
      },
    });
    await errorFrom(
      () => reader.read(input({ artifactId: invalidId })),
      'ARTIFACT_INPUT_INVALID',
      400,
    );
    expect(lookups).toBe(0);
  });

  it.each(['', ' ', ' padded', 'padded ', 'x'.repeat(256)])(
    'rejects invalid run ID %s before lookup',
    async (invalidRun) => {
      let lookups = 0;
      const reader = service(metadata(), {
        lookup: () => {
          lookups += 1;
          return metadata();
        },
      });
      await errorFrom(
        () => reader.read(input({ runId: invalidRun })),
        'ARTIFACT_INPUT_INVALID',
        400,
      );
      expect(lookups).toBe(0);
    },
  );

  it('rejects replacement metadata and paths in request input before lookup', async () => {
    let lookups = 0;
    const reader = service(metadata(), {
      lookup: () => {
        lookups += 1;
        return metadata();
      },
    });
    await errorFrom(
      () => reader.read(input({ path: join(directory, 'outside.png') })),
      'ARTIFACT_INPUT_INVALID',
      400,
    );
    await errorFrom(
      () => reader.read(input({ metadata: metadata() })),
      'ARTIFACT_INPUT_INVALID',
      400,
    );
    expect(lookups).toBe(0);
  });

  it('requires both request IDs and a record-shaped input', async () => {
    const reader = service();
    for (const malformed of [null, undefined, [], {}, { runId }, { artifactId }, 'artifact']) {
      await errorFrom(() => reader.read(malformed), 'ARTIFACT_INPUT_INVALID', 400);
    }
  });

  it('does not serve an orphan file without persisted metadata', async () => {
    fixture();
    await errorFrom(() => service(null).read(input()), 'ARTIFACT_NOT_FOUND', 404);
    await errorFrom(
      () => service(null, { lookup: () => undefined }).read(input()),
      'ARTIFACT_NOT_FOUND',
      404,
    );
  });

  it('does not serve another run receipt', async () => {
    fixture();
    await errorFrom(
      () => service(metadata({ runId: 'run_other' })).read(input()),
      'ARTIFACT_RUN_MISMATCH',
      403,
    );
  });

  it('rejects a receipt for a different artifact ID', async () => {
    fixture();
    await errorFrom(
      () => service(metadata({ id: `${randomUUID()}.png` })).read(input()),
      'ARTIFACT_METADATA_INVALID',
      422,
    );
  });

  it.each<[string, unknown]>([
    ['observationId', ''],
    ['observationId', ' padded'],
    ['observationId', 'x'.repeat(256)],
    ['sha256', 'A'.repeat(64)],
    ['sha256', 'not-a-hash'],
    ['contentType', 'image/jpeg'],
    ['source', 'api_probe'],
    ['sizeBytes', 0],
    ['sizeBytes', 1.5],
    ['sizeBytes', '100'],
    ['path', '/untrusted/file.png'],
    ['extra', true],
  ])('rejects invalid stored metadata field %s', async (key, value) => {
    fixture();
    await errorFrom(
      () => service(metadata({ [key]: value })).read(input()),
      'ARTIFACT_METADATA_INVALID',
      422,
    );
  });

  it.each(['id', 'runId', 'observationId', 'sha256', 'contentType', 'source', 'collectedAt'])(
    'requires metadata field %s',
    async (key) => {
      fixture();
      const receipt: Record<string, unknown> = metadata();
      delete receipt[key];
      await errorFrom(() => service(receipt).read(input()), 'ARTIFACT_METADATA_INVALID', 422);
    },
  );

  it('supports an asynchronous authoritative lookup and sanitizes lookup errors', async () => {
    fixture();
    const requested: string[] = [];
    const reader = service(null, {
      lookup: async (id: string) => {
        requested.push(id);
        return metadata();
      },
    });
    expect(Buffer.from((await reader.read(input())).bytes)).toEqual(png);
    expect(requested.length).toBeGreaterThan(0);
    expect(new Set(requested)).toEqual(new Set([artifactId]));
    const failing = service(null, {
      lookup: async () => {
        throw new Error(`${directory} SYNTHETIC_PRIVATE_LOOKUP_VALUE`);
      },
    });
    await errorFrom(() => failing.read(input()), 'ARTIFACT_UNAVAILABLE', 503);
  });
});

describe('independent artifact: retention and trusted configuration', () => {
  it('expires at exactly seven days by default', async () => {
    fixture();
    const reader = service();
    now = originalTime + sevenDays - 1;
    expect(Buffer.from((await reader.read(input())).bytes)).toEqual(png);
    now += 1;
    await errorFrom(() => reader.read(input()), 'ARTIFACT_EXPIRED', 410);
  });

  it('uses the earlier of explicit expiry and configured retention', async () => {
    fixture();
    const early = service(metadata({ expiresAt: new Date(originalTime + 1_000).toISOString() }), {
      retentionMs: 2_000,
    });
    now = originalTime + 999;
    await early.read(input());
    now += 1;
    await errorFrom(() => early.read(input()), 'ARTIFACT_EXPIRED', 410);
    const retained = service(
      metadata({ expiresAt: new Date(originalTime + 5_000).toISOString() }),
      { retentionMs: 2_000 },
    );
    now = originalTime + 2_000;
    await errorFrom(() => retained.read(input()), 'ARTIFACT_EXPIRED', 410);
  });

  it('accepts at most ten seconds of collection clock skew', async () => {
    fixture();
    await service(metadata({ collectedAt: new Date(now + 10_000).toISOString() })).read(input());
    await errorFrom(
      () => service(metadata({ collectedAt: new Date(now + 10_001).toISOString() })).read(input()),
      'ARTIFACT_METADATA_INVALID',
      422,
    );
  });

  it.each([
    'invalid-time',
    '2027-01-01T00:00:00',
    '1969-12-31T23:59:59.999Z',
    '',
    1_800_000_000_000,
  ])('rejects invalid collection timestamp %s', async (collectedAt) => {
    fixture();
    await errorFrom(
      () => service(metadata({ collectedAt })).read(input()),
      'ARTIFACT_METADATA_INVALID',
      422,
    );
  });

  it('rejects invalid explicit expiry and expiry earlier than collection', async () => {
    fixture();
    for (const expiresAt of [
      'invalid-time',
      '2027-01-01T00:00:00',
      new Date(originalTime - 1).toISOString(),
    ]) {
      await errorFrom(
        () => service(metadata({ expiresAt })).read(input()),
        'ARTIFACT_METADATA_INVALID',
        422,
      );
    }
  });

  it.each<[string, unknown]>([
    ['retentionMs', 0],
    ['retentionMs', -1],
    ['retentionMs', 1.5],
    ['retentionMs', NaN],
    ['retentionMs', Infinity],
    ['retentionMs', Number.MAX_SAFE_INTEGER + 1],
    ['maxBytes', 7],
    ['maxBytes', 50 * 1024 * 1024 + 1],
    ['maxBytes', 10.5],
    ['maxBytes', Infinity],
    ['rootDirectory', 'relative/artifacts'],
    ['rootDirectory', ''],
  ])('rejects invalid trusted option %s', async (key, value) => {
    await errorFrom(
      () => service(metadata(), { [key]: value }),
      'ARTIFACT_CONFIGURATION_INVALID',
      500,
    );
  });

  it.each([NaN, Infinity, -1])('rejects invalid real-time clock value %s', async (value) => {
    fixture();
    await errorFrom(
      () => service(metadata(), { now: () => value }).read(input()),
      'ARTIFACT_CONFIGURATION_INVALID',
      500,
    );
  });
});

describe('independent artifact: filesystem identity and byte integrity', () => {
  it('reports persisted-but-missing files and roots without inventing images', async () => {
    await errorFrom(() => service().read(input()), 'ARTIFACT_MISSING', 404);
    await errorFrom(
      () => service(metadata(), { rootDirectory: join(directory, 'missing-root') }).read(input()),
      'ARTIFACT_MISSING',
      404,
    );
  });

  it('rejects a symlinked screenshot even when its target bytes match the receipt', async () => {
    const outside = join(directory, 'outside.png');
    writeFileSync(outside, png);
    symlinkSync(outside, join(rootDirectory, artifactId));
    await errorFrom(() => service().read(input()), 'ARTIFACT_UNSAFE_FILE', 422);
  });

  it('rejects hard-linked screenshot files', async () => {
    const outside = join(directory, 'outside.png');
    writeFileSync(outside, png);
    linkSync(outside, join(rootDirectory, artifactId));
    await errorFrom(() => service().read(input()), 'ARTIFACT_UNSAFE_FILE', 422);
  });

  it('rejects a directory in place of a screenshot', async () => {
    mkdirSync(join(rootDirectory, artifactId));
    await errorFrom(() => service().read(input()), 'ARTIFACT_UNSAFE_FILE', 422);
  });

  it('rejects a symlinked artifact root', async () => {
    fixture();
    const alias = join(directory, 'root-alias');
    symlinkSync(rootDirectory, alias);
    await errorFrom(
      () => service(metadata(), { rootDirectory: alias }).read(input()),
      'ARTIFACT_UNSAFE_FILE',
      422,
    );
  });

  it('rejects a regular file used as the root directory', async () => {
    const invalidRoot = join(directory, 'not-a-directory');
    writeFileSync(invalidRoot, 'synthetic');
    await errorFrom(
      () => service(metadata(), { rootDirectory: invalidRoot }).read(input()),
      'ARTIFACT_UNSAFE_FILE',
      422,
    );
  });

  it('rejects an artifact root replaced after construction even with identical file bytes', async () => {
    fixture();
    const reader = service();
    renameSync(rootDirectory, join(directory, 'original-root'));
    mkdirSync(rootDirectory);
    fixture();
    await errorFrom(() => reader.read(input()), 'ARTIFACT_UNSAFE_FILE', 422);
  });

  it('rejects deterministic root replacement during authoritative lookup', async () => {
    fixture();
    let replaced = false;
    const reader = service(metadata(), {
      lookup: () => {
        if (!replaced) {
          replaced = true;
          renameSync(rootDirectory, join(directory, 'original-root'));
          mkdirSync(rootDirectory);
          fixture();
        }
        return metadata();
      },
    });
    await errorFrom(() => reader.read(input()), 'ARTIFACT_UNSAFE_FILE', 422);
  });

  it('rejects a file replaced by a symlink during authoritative lookup', async () => {
    fixture();
    const outside = join(directory, 'outside.png');
    writeFileSync(outside, png);
    let replaced = false;
    const reader = service(metadata(), {
      lookup: () => {
        if (!replaced) {
          replaced = true;
          rmSync(join(rootDirectory, artifactId));
          symlinkSync(outside, join(rootDirectory, artifactId));
        }
        return metadata();
      },
    });
    await errorFrom(() => reader.read(input()), 'ARTIFACT_UNSAFE_FILE', 422);
  });

  it('rejects a file replaced by a hard link during authoritative lookup', async () => {
    fixture();
    const outside = join(directory, 'outside.png');
    writeFileSync(outside, png);
    let replaced = false;
    const reader = service(metadata(), {
      lookup: () => {
        if (!replaced) {
          replaced = true;
          rmSync(join(rootDirectory, artifactId));
          linkSync(outside, join(rootDirectory, artifactId));
        }
        return metadata();
      },
    });
    await errorFrom(() => reader.read(input()), 'ARTIFACT_UNSAFE_FILE', 422);
  });

  it('validates the PNG signature independently of a matching stored digest', async () => {
    const notPng = Buffer.from('SYNTHETIC_NON_PNG_FILE');
    fixture(notPng);
    await errorFrom(
      () =>
        service(metadata({ sha256: createHash('sha256').update(notPng).digest('hex') })).read(
          input(),
        ),
      'ARTIFACT_CORRUPT',
      422,
    );
  });

  it('rejects modified bytes even when the PNG signature remains present', async () => {
    const modified = Buffer.from(png);
    modified[modified.length - 1] = (modified[modified.length - 1] ?? 0) ^ 1;
    fixture(modified);
    await errorFrom(() => service().read(input()), 'ARTIFACT_CORRUPT', 422);
  });

  it('requires optional recorded size to match the exact returned byte count', async () => {
    fixture();
    await errorFrom(
      () => service(metadata({ sizeBytes: png.length + 1 })).read(input()),
      'ARTIFACT_CORRUPT',
      422,
    );
    expect(
      (await service(metadata({ sizeBytes: png.length })).read(input())).bytes.byteLength,
    ).toBe(png.length);
  });

  it('accepts a file exactly at the configured cap and rejects one byte beyond it', async () => {
    fixture();
    expect(
      (await service(metadata(), { maxBytes: png.length }).read(input())).bytes.byteLength,
    ).toBe(png.length);
    await errorFrom(
      () => service(metadata(), { maxBytes: png.length - 1 }).read(input()),
      'ARTIFACT_TOO_LARGE',
      413,
    );
  });

  it('rejects an oversized sparse file under the default cap', async () => {
    fixture();
    truncateSync(join(rootDirectory, artifactId), 10 * 1024 * 1024 + 1);
    await errorFrom(() => service().read(input()), 'ARTIFACT_TOO_LARGE', 413);
  });

  it('never serves changed bytes introduced by an authoritative lookup callback', async () => {
    fixture();
    const modified = Buffer.from(png);
    modified[modified.length - 1] = (modified[modified.length - 1] ?? 0) ^ 1;
    const reader = service(metadata(), {
      lookup: () => {
        fixture(modified);
        return metadata();
      },
    });
    await errorFrom(() => reader.read(input()), 'ARTIFACT_CORRUPT', 422);
  });
});

describe('independent artifact: bounded local stress', () => {
  it('returns verified bytes across repeated concurrent reads without sharing mutable output', async () => {
    fixture();
    const reader = service();
    for (let batch = 0; batch < 8; batch += 1) {
      const results = await Promise.all(Array.from({ length: 32 }, () => reader.read(input())));
      for (const result of results) expect(Buffer.from(result.bytes)).toEqual(png);
      const first = results[0];
      if (!first) throw new Error('Expected concurrent result');
      first.bytes[0] = 0;
      for (const result of results.slice(1)) expect(Buffer.from(result.bytes)).toEqual(png);
    }
  }, 20_000);

  it('recovers after repeated corrupt-file failures without exhausting later reads', async () => {
    fixture(Buffer.from('SYNTHETIC_CORRUPT_FILE'));
    const reader = service();
    for (let i = 0; i < 128; i += 1)
      await errorFrom(() => reader.read(input()), 'ARTIFACT_CORRUPT', 422);
    fixture();
    expect(Buffer.from((await reader.read(input())).bytes)).toEqual(png);
  }, 20_000);
});
