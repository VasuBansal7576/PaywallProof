# Implementation decisions

## 2026-08-27: Verify the released local TrueForge sandbox

The owner prohibits monetary charges and allows specification changes while preserving functionality. TrueForge's published sandbox page describes Daytona as its only provider. Inspection of the released `@truefoundry/trueforge@0.1.4` package found its supported standalone local sandbox fallback, implemented with `@anthropic-ai/sandbox-runtime@0.0.71`.

The local server started on `127.0.0.1:8790`, created its database inside the ignored `.local` directory, and reported `Local sandbox fallback is available` on macOS. No Daytona account or provider was configured. The existing Ollama model was registered through the official SDK as a local OpenAI-compatible provider.

This verifies startup and configuration only. Successful model tool execution, generated-code isolation, approval, reconnect, and product behavior still need verification. Until those checks pass, do not claim the sandbox integration is complete.

Once validated, the local provider is an additional permitted implementation of the required TrueForge sandbox, preserving the generated-code execution and safety requirements. Daytona remains an alternative only if no-charge operation is independently established. The original Daytona-specific statements in PRD sections 2, 7, 10, and 17 are superseded for the local configuration by this verified provider option, not by execution of generated code in an unrestricted worker.

Sources: https://trueforge.dev/sandbox, https://trueforge.dev/models, https://github.com/truefoundry/trueforge/blob/main/packages/trueforge/src/sandbox/localRuntime.ts, and the pinned installed package.

The first actual sandbox execution failed during venv creation. Direct reproduction found a missing libexpat symbol in the machine's existing Homebrew Python 3.14, outside the sandbox. The startup probe does not check venv creation and therefore did not catch this. Bundled Python 3.12 creates a venv successfully, but TrueForge 0.1.4 uses a fixed command lookup path and has no supported interpreter override. Do not change system Python symlinks or broaden sandbox access to the user's home directory. A narrowly scoped, reviewed interpreter compatibility fix must preserve sandbox restrictions and be retested with a new session.

## 2026-08-27: Independent contract review before implementation

An agent with no inherited conversation read only PRD.md and docs/public-contracts.md. It identified missing feature-configuration binding, ambiguous leak verdicts, escaped-marker handling, validation bounds, and precedence rules. The public contract now specifies these before test authoring or product implementation. No expectations were changed to accommodate an implementation.
