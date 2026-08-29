# Authenticated screenshot artifact contract

This contract is written before implementation for independent verification. Artifact bytes are evidence only when they match a stored receipt for the requested run. The service never invents an image or substitutes a missing screenshot.

## Module boundary

`apps/worker/src/artifacts.ts` exports `createArtifactService(options)` and `ArtifactError`.

Options:

```ts
{
  rootDirectory: string;
  lookup: (artifactId: string) => unknown | Promise<unknown>;
  now?: () => number;
  retentionMs?: number;
  maxBytes?: number;
}
```

`rootDirectory` is an absolute, operator-configured artifact directory, never a request parameter. `lookup` reads persisted artifact metadata from the authoritative store; it must not accept metadata supplied by a browser or model. `now` returns real Unix milliseconds and defaults to `Date.now`. Default retention is seven days. Default maximum file size is 10 MiB. Optional limits must be positive safe integers; `maxBytes` must be at least eight bytes and no greater than 50 MiB. Invalid configuration throws `ArtifactError` with code `ARTIFACT_CONFIGURATION_INVALID` and status 500.

The worker accepts `ARTIFACT_RETENTION_DAYS` as a positive whole-number string. `pnpm dev` selects 60 days for the owner's judging setup unless explicitly overridden. Starting the worker directly retains the seven-day default. A longer retention window never overrides an earlier receipt-specific `expiresAt`, changes collection times, or extends a Stripe sandbox. Files remain local and authenticated; this setting does not publish them or guarantee backup availability.

The returned object exposes:

```ts
read(input: unknown): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  metadata: {
    id: string;
    runId: string;
    observationId: string;
    sha256: string;
    contentType: 'image/png';
    source: 'browser';
    collectedAt: string;
    sizeBytes?: number;
    expiresAt?: string;
  };
}>;
```

Input must be exactly `{runId, artifactId}`. Run IDs are nonempty, unpadded strings of at most 255 characters. Artifact IDs are canonical lowercase UUID filenames with an RFC UUID version of 1 through 8 and RFC variant, followed by `.png`. Paths, separators, encoded separators, uppercase variants, NULs, extra suffixes, and unknown input fields are rejected before lookup or filesystem access.

## Stored metadata

Required fields are `id`, `runId`, `observationId`, lowercase SHA-256 `sha256`, `contentType: 'image/png'`, `source: 'browser'`, and ISO 8601 `collectedAt` with a timezone. Optional fields are positive integer `sizeBytes` and ISO 8601 `expiresAt` with a timezone. Unknown fields are invalid; in particular, a metadata path cannot select a file. Observation IDs use the same nonempty, unpadded identifier rule as run IDs.

The receipt ID must equal the requested artifact ID, and its run must equal the requested run. Missing metadata is unavailable, even if an identically named file exists. Another run's artifact is never returned. Metadata is returned as a detached validated record, not the original callback object.

An artifact expires at the earlier of `collectedAt + retentionMs` and optional `expiresAt`. At the exact expiry boundary it is expired. Collection times more than ten seconds in the future are invalid. Collection and expiry timestamps must be finite, nonnegative real milliseconds. An expiry before collection is invalid.

## Filesystem and content checks

The service resolves only `<trusted root>/<validated UUID>.png`. The configured root must exist when the factory is called. The factory synchronously pins its canonical path and directory identity. The configured root itself must be a regular directory and must not be a symbolic link. Its identity is checked before and after metadata lookup and around the file read; parent aliases such as the operating system's `/tmp` are allowed only through canonical resolution. A renamed, removed, or replaced root must not return bytes, including a replacement between factory creation and the first read. The service never silently repins another directory. The worker creates the trusted directory before constructing the service.

The trusted root is created by startup before constructing the service. Its canonical directory identity is pinned at service construction, not first use. Replacing or renaming the root before the first read, or during an authoritative lookup/read, must fail closed even if a replacement directory contains identical filenames and bytes.

The file is opened with `O_NOFOLLOW`; symbolic links are never followed. It must be a regular file, not a directory, device, FIFO, or socket. Hard-linked files are rejected. The configured size cap is checked before allocating the read buffer. Reads are bounded by the original validated size plus a one-byte growth check, so a concurrent writer cannot force an unbounded allocation. File descriptor metadata is checked again after reading. A size, inode, link count, or modification change rejects the download. Descriptor cleanup occurs on every success and failure path.

The returned bytes must have the PNG signature and a SHA-256 equal to the stored receipt. Optional `sizeBytes` must match. Hash validation covers the same bytes returned to the route; it does not hash a path and then reopen it. No file content, absolute path, database value, or internal error is included in error messages.

## Errors

All service failures reject with `ArtifactError`, an Error instance with stable `code` and numeric `status`:

| Code                             | Status | Meaning                                                           |
| -------------------------------- | ------ | ----------------------------------------------------------------- |
| `ARTIFACT_INPUT_INVALID`         | 400    | Invalid request input or filename                                 |
| `ARTIFACT_NOT_FOUND`             | 404    | No persisted metadata for the artifact                            |
| `ARTIFACT_RUN_MISMATCH`          | 403    | Receipt belongs to another run                                    |
| `ARTIFACT_EXPIRED`               | 410    | Retention or explicit expiry elapsed                              |
| `ARTIFACT_MISSING`               | 404    | Persisted artifact file or directory is missing                   |
| `ARTIFACT_METADATA_INVALID`      | 422    | Malformed or contradictory stored receipt                         |
| `ARTIFACT_UNSAFE_FILE`           | 422    | Symlink, nonregular file, hard link, or unsafe/replaced root      |
| `ARTIFACT_TOO_LARGE`             | 413    | File exceeds the configured maximum                               |
| `ARTIFACT_CORRUPT`               | 422    | Size, PNG signature, SHA-256, or concurrent modification mismatch |
| `ARTIFACT_UNAVAILABLE`           | 503    | Storage/lookup failure that prevents verification                 |
| `ARTIFACT_CONFIGURATION_INVALID` | 500    | Invalid trusted configuration or clock                            |

## Root HTTP integration

The worker owns `GET /api/runs/:id/artifacts/:artifactId`. It authenticates the operator before calling the service, verifies the run exists, and passes only the two route IDs. The service is not an authorization substitute.

Repair records retain three provenance fields for the report: `repairRunId`, `repairJobId`, and `phase`. Before download, the worker validates the complete record against the base receipt plus two UUIDs and a phase of `before` or `after`. The repair run must differ from its parent run. Only then may the worker remove those three fields for the unchanged strict service schema. Partial annotations, unknown fields, malformed receipts, and parent-run mismatches still fail. Stored provenance is never removed from the report.

A valid download returns 200 with the verified bytes and these headers:

- `Content-Type: image/png`
- `Content-Disposition: attachment; filename="<artifactId>"`
- `Content-Length: <verified byte length>`
- `Cache-Control: no-store`
- `X-Content-Type-Options: nosniff`

Service errors return its status and `{error:{code,message}}` with a generic, nonsecret message. The Next.js proxy preserves content type, disposition, status, and authentication cookies. No arbitrary filesystem route or remote artifact URL is accepted.

## UI and report integration

Run detail and reports expose the stored `artifacts` metadata array scoped to that run. A screenshot is associated with a scenario only through its `observationId` belonging to that scenario's recorded browser observations. The UI does not infer a screenshot from a scenario name or construct an ID when none is recorded.

Scenario presentation shows recorded provider state, stored application state, API status/body facts, and browser status/body facts alongside the immutable policy's expected rule. It identifies the run, policy hash, target build, observation references, and real observation times. Missing or malformed observations are labeled unavailable; verdicts remain those returned by the worker. The presentation never runs its own access evaluator or converts an HTTP 200 into a pass.

Screenshot controls fetch the authenticated artifact endpoint, show explicit missing/expired/corrupt errors, and offer a download only after bytes are returned successfully. Local replay stays labeled as synthetic billing replay. A suspected source-code cause remains unverified until a repair's evidence establishes it.
