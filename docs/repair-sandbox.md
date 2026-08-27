# Repair sandbox runner contract

`packages/repair/src/sandbox.ts` exports `RepairSandboxRunner`, `SandboxRunError`, and their input/result types. This module does not create repair verification receipts, approve publication, or call GitHub or Stripe. Only the trusted controller may construct its inputs.

```ts
const runner = new RepairSandboxRunner({ baseUrl?, model?, nodeExecutable?,
  commandTimeoutSeconds?, operationTimeoutSeconds? });
await runner.run({
  sessionId, previousTurnId, files, allowedPaths,
  setupCommands?: [{ interpreter: 'node' | 'python', script, args?: string[] }],
  fixedCommand: { interpreter: 'node' | 'python', script, args?: string[] },
  target?: { routes: [{ method: 'GET' | 'POST' | 'DELETE', path }],
    allowNextStatic?: true,
    onReady: async ({ origin, adapterToken, replaySecret, webhookSecret, registerRoutes }) => observation },
  signal?, onState?: async state => persist(state)
});
await runner.prepare({ sessionId, previousTurnId, files, allowedPaths,
  instructions, signal?, onState? });
```

Files are `{ path, bytes: Uint8Array, role: 'source' | 'dependency' | 'launcher' }`. Source paths must belong to the explicit repair allowlist and pass the repair package's protected-path policy. Dependencies must be under `node_modules/`; launchers under `_trusted/`. All paths are relative, have no traversal, control characters, symlinks, environment files, credentials, or oracle/test inputs. Files are bytes, never host filesystem paths. Dependencies and launchers are transfer-only and cannot become candidate changes. No package-manager lifecycle command runs. The trusted command names a transferred launcher and is never accepted from HTTP or the model.

`run` stages the exact bytes and executes a generated fixed bootstrap. Up to three setup commands and the final command run in separate turns in the same materialized workspace, preserving build output. The launcher runs inside TrueForge's existing local sandbox. `prepare` stages the bytes and asks the existing session to edit only existing source files; its results are untrusted candidate bytes. Added or deleted source files are not supported. Both return `{ sessionId, operationId, workspace, turnIds, lastTurnId, transferArchiveHash, baselineBindings, candidateBindings, files, execReceipts, observation }`. Bindings contain `{ path, sha256, size }`; returned files contain source paths and bytes. `observation` is the trusted `onReady` return value or `null`, not a verification claim. Exec receipts retain `{ sessionId, turnId, toolCallId, eventId, command, exitCode, output }`. Output is capped and known credentials are redacted. A model statement alone cannot create an exec receipt.

`onState` receives `{ sessionId, operationId, phase, turnId, previousTurnId }` before and after each turn dispatch. A pre-dispatch event has `turnId: null`. Persist it before allowing dispatch. An uncertain create response fails with `RUNTIME_TURN_CREATION_UNKNOWN`, retaining the operation ID; do not automatically retry the operation. Existing session and preceding turn are required. Reconnection only resumes the current stream. Cancellation cancels the existing session, closes the bridge, and rejects. Errors contain a stable code and partial runtime state; they do not contain credentials or model output.

Transfers concatenate file bytes, compress them with gzip, and use official FileContent binary attachments split at 8 MiB. Each transfer turn contains at most 16 MiB before base64 encoding. The extracted limit is 512 MiB across 20,000 files; each editable source file is at most 1 MiB. The bootstrap embeds an exact path/offset/size/hash manifest; it never extracts a tar archive or follows archive links. Every uploaded chunk is downloaded through the SDK and hashed before the bootstrap runs. The bootstrap verifies chunks again, creates a new operation directory, and writes only regular files. After execution a fixed helper checks regular-file paths and exports a compressed byte snapshot, also in 8 MiB chunks. The host downloads that snapshot and verifies every file, including files above TrueForge's 20 MiB single-download limit. `run` rejects changed inputs. `prepare` rejects changed dependency/launcher bytes and returns only allowlisted source bytes. These checks do not make model-generated changes trusted, prevent a malicious target from manipulating its own process, or replace the external oracle. Unexpected tools in a fixed execution turn cause failure; prompts alone do not prevent the model from attempting them.

## Reverse HTTP

The fixed launcher can use the generated CommonJS bridge:

```js
const { serve } = require(process.env.PP_REPAIR_BRIDGE_MODULE);
await serve(requestListener);
```

The listener is a Node HTTP request listener. A Next custom server can supply `app.getRequestHandler()` after `app.prepare()`. A Hono wrapper can supply its Node adapter listener, but such a wrapper is not verification of the Next UI.

The host listens on a short Unix socket name inside the validated macOS session sandbox. Other local-provider layouts currently fail closed. It never connects to a sandbox-controlled socket path or executes sandbox files on the host. A fixed host child handles accepted streams and a disposable handshake. The sandbox initiates connections. The parent exposes an ephemeral loopback HTTP origin only for the trusted oracle callback. Exact configured method/path pairs are forwarded, including an optional exact `?runId=<identifier>` query. After parsing a created user's ID, the trusted callback can call `registerRoutes([{method,path}, ...])` for that user's exact paths. The model cannot register routes. `allowNextStatic: true` also permits GET of canonical paths below `/_next/static/`, without queries or traversal. Upgrades, redirects, CONNECT, arbitrary headers and real provider credentials are rejected or stripped. Cookies and privileged fixture authorization are bounded; the latter must equal the generated disposable adapter token. Requests and responses are limited to 4 MiB and requests to 15 seconds. The sandbox target lifetime is the configured command timeout minus three seconds; it defaults to 52 seconds. Requests are serialized. Closing the callback tears down the bridge and target.

The launcher receives only sandbox HOME/TMPDIR/PATH, generated disposable fixture/replay/webhook secrets, staging/database defaults, disabled Next telemetry, and bridge configuration. Public price/build IDs can be embedded in the trusted launcher bytes. It receives no Stripe API key, GitHub token, model-provider key, operator browser cookie, or host environment. The oracle remains outside the sandbox.

## Limits and evidence

TrueForge 0.1.4 local exec defaults to a 60-second foreground timeout. Its internal `LocalSandboxProvider` accepts `defaultExecTimeoutSeconds`, but the shipped runtime factory does not expose it as configuration and the public exec tool has no timeout argument. `SERVER_EXECUTION_TIMEOUT_SECONDS` governs a whole turn, not this exec timeout. The default runner therefore cannot reproduce a 60–300 second synchronization policy and must not claim it can or silently shorten the policy.

The runner accepts trusted `commandTimeoutSeconds` from 5 through 420, default 55, and `operationTimeoutSeconds` from 60 through 900, default 600. Longer commands require the separately documented pinned runtime compatibility patch that passes a bounded host-only `PAYWALLPROOF_LOCAL_EXEC_TIMEOUT_SECONDS` into the existing provider option. Merely setting the runner option does not change the installed runtime. The controller must pass its original run deadline as `signal`; starting a repair must not reset the approved 15-minute run budget. The runner does not modify the oracle's synchronization window.

This runner does not weaken SRT, enable TCP binding, mount the host home, install dependencies, or assume a background daemon survives. Each setup or serving command must fit the configured runtime timeout. Full Next compilation under SRT remains unverified. The installed Next 16.3.3 SWC addon is 85 MiB; chunking handles transfer, but does not prove compile performance or all SRT compatibility. Next custom-server support does not itself prove that every Next development/build subsystem avoids TCP binding. If production mode disables staging hooks, use the actual supported development configuration and verify it; a prebuilt production app or an API-only wrapper is not an equivalent target.

Actual installation probes recorded in `.local/runtime-upload-ipc-probe.json` and `.local/runtime-reverse-ipc-probe.json` confirmed official upload, exec result, denied TCP binding, and sandbox-initiated HTTP over a Unix stream. They are runtime installation evidence only. Implementation-aware tests use clearly identified synthetic runtime data or local Node processes and do not count as product acceptance, Stripe success, or a repaired target.

Official APIs: [Next custom server](https://nextjs.org/docs/pages/guides/custom-server), installed TrueForge SDK `FileContent`, `sessions.createTurn`, `sessions.downloadSandboxFile`, and `sessions.subscribeToTurn`. No private upload API is used.

`downloadSandboxFile` requires an absolute sandbox path. The runner obtains the local root from persisted `sandbox.created` metadata, validates its exact session directory and ownership, and resolves its generated artifact paths beneath that root. The relative `uploads/...` path shown in upload announcements cannot be passed directly to the download API. The first final-runner smoke exposed this integration error before any exec; its failed evidence is retained in `.local/final-runner-smoke.json`.

The second actual smoke, `.local/final-runner-smoke-2.json`, passed both upload/readback phases but did not execute Node. Its execution turn ended with `finishReason: length` after 1,024 output tokens and zero tool calls. The runner rejected `EXACT_EXEC_REQUIRED`; no exec or HTTP success was recorded. Read-only diagnosis confirmed the temporary Unix socket was removed. The completed final runner therefore still lacks an actual end-to-end success receipt; the earlier successful reverse-IPC installation probe and implementation tests do not fill that gap.
