# Implementation decisions

## 2026-08-30: Separate lifecycle portability from repair trust

PaywallProof now uses one versioned HTTP contract for owned staging targets. Adapter Doctor performs at most three read-only requests before fixture creation. It validates the target description, exact source-build identity, staging authentication, separation between the adapter credential and ordinary feature access, response type, cache policy, and one bounded feature descriptor. PaywallProof does not load executable adapter code from the target repository.

This decision makes the lifecycle runner reusable without widening the repair boundary. Automated repair remains limited to the trusted `reference_v1` checkout, launcher, editable paths, and host-owned oracle. A target ID, origin, or repository override disables repair by default. Lifecycle compatibility cannot authorize source reads, model work, publication recovery, or a GitHub write.

The second owned target was treated as an acceptance checkpoint, not evidence by its existence. On August 30, the generic runner bound Revenue Intelligence OS commit `49e69922c37446bc229ea14571bba58db34a56ce` to a compatible Doctor receipt, passed all twelve SC01 through SC04 assertions, and confirmed both users deleted. The run was labeled `local_replay`; it proves lifecycle portability but not Polar delivery or repair portability.

## 2026-08-27: Verify the released local TrueForge sandbox

The owner prohibits monetary charges and allows specification changes while preserving functionality. TrueForge's published sandbox page describes Daytona as its only provider. Inspection of the released `@truefoundry/trueforge@0.1.4` package found its supported standalone local sandbox fallback, implemented with `@anthropic-ai/sandbox-runtime@0.0.71`.

The local server started on `127.0.0.1:8790`, created its database inside the ignored `.local` directory, and reported `Local sandbox fallback is available` on macOS. No Daytona account or provider was configured. The existing Ollama model was registered through the official SDK as a local OpenAI-compatible provider.

The first probe verified startup and configuration only. Subsequent fresh sessions executed a sandbox Python command with output 42, exercised a restricted MCP approval and continuation, rejected a stale approval, and resumed the same turn after disconnect. Separate file-transfer and reverse Unix-socket probes verified actual bytes, HTTP responses and exit codes while TCP bind remained denied. These establish runtime capabilities, not complete product acceptance or a verified repair.

PRD version 1.2 now explicitly permits the verified local provider as an additional implementation of the required TrueForge sandbox. The owner authorized specification changes and forbids charges; no product capability or acceptance requirement is removed. Daytona remains an alternative only if no-charge operation is independently established. Generated code must never run in an unrestricted worker. This corrects the earlier mismatch between this decision record and the authoritative PRD identified by Qodo.

Sources: https://trueforge.dev/sandbox, https://trueforge.dev/models, https://github.com/truefoundry/trueforge/blob/main/packages/trueforge/src/sandbox/localRuntime.ts, and the pinned installed package.

The first actual sandbox execution failed during venv creation. Direct reproduction found a missing libexpat symbol in the machine's existing Homebrew Python 3.14, outside the sandbox. The startup probe does not check venv creation and therefore did not catch this. Bundled Python 3.12 creates a venv successfully, but TrueForge 0.1.4 uses a fixed command lookup path and has no supported interpreter override. Do not change system Python symlinks or broaden sandbox access to the user's home directory. A narrowly scoped, reviewed interpreter compatibility fix must preserve sandbox restrictions and be retested with a new session.

The pinned pnpm patch adds explicit absolute Python and Command Line Tools overrides and grants read access only to those validated runtime roots. It also prepends the exact Command Line Tools `usr/bin` directory so macOS does not invoke the developer-tools shim at `/usr/bin/git`. Fresh-session execution passed with the bundled Python 3.12, and a live review advanced past Git skill mounting. No system interpreter, home-directory mount, or network permission was changed. Machine-specific probe artifacts remain in ignored `.local`; reproducible installation verification is `pnpm test:runtime`.

## 2026-08-27: Independent contract review before implementation

An agent with no inherited conversation read only PRD.md and docs/public-contracts.md. It identified missing feature-configuration binding, ambiguous leak verdicts, escaped-marker handling, validation bounds, and precedence rules. The public contract now specifies these before test authoring or product implementation. No expectations were changed to accommodate an implementation.
