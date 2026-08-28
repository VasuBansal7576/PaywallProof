# Run with a Codex subscription

PaywallProof can use the signed-in Codex CLI with `gpt-5.6-luna`. No Ollama process or model download is needed. TrueForge still owns workflow execution and sandboxing; Qodo remains the external code review integration.

## Setup

The integration was exercised with official Codex CLI `0.147.0`, signed in with ChatGPT. Start local TrueForge, then run:

```sh
pnpm model:codex
pnpm dev:codex-model
```

Setup checks metadata and registers `paywallproof-codex/luna`; it does not generate tokens or change billing. The bridge binds `127.0.0.1:8792` and requires a private capability. Restart the worker after changing model selection. OpenRouter remains an explicitly selectable option; neither connection falls back to the other.

## Spending policy

This uses included subscription allowance, not a free or unlimited public API. Each turn requires managed ChatGPT sign-in, Plus/Pro, available included quota and an explicit zero extra-credit balance. Missing, conflicting, exhausted or unfamiliar billing state blocks generation. Checks run before and after each turn.

API credentials and provider override environment variables are excluded from the child process. Luna is pinned and provider fallback disabled. No purchase, billing-change, reset-credit redemption, API-key login or upgrade calls exist. Account-wide billing is unchanged: concurrent account changes elsewhere can invalidate a preflight check, and the bridge rejects changed state when it next observes it.

## Execution and privacy

The bridge uses the official `codex app-server` stdio interface. Codex manages its login; PaywallProof never reads or forwards authentication tokens. This version-sensitive, experimental integration is a local operator option, not a public service sharing the owner's subscription. Other operators need their own entitled account.

Each request uses an ephemeral Codex thread with no selected environments, workspace roots or dynamic tools. Shell, browser, computer, image, plugin, app, memory, subagent and hook capabilities are disabled, along with configured MCP servers. An empty temporary directory replaces the project checkout. Unexpected tool or approval events fail the request.

Luna receives the ordered TrueForge conversation and tool schemas. The current instruction is separated from earlier history. Its structured answer proposes calls; TrueForge checks permissions and executes them. For the controller's complete exact-exec instruction grammar, the output schema requires the exact command and prohibits further calls after its actual result, including failures. Proposed commands are validated before forwarding, without manufacturing a model answer. Host tests, the repair evaluator and exact-command receipts remain separate and unchanged. Selected source and sanitized observations go to OpenAI, as disclosed in project consent.

Structured final output is buffered before returning JSON or SSE; interim commentary is excluded. Reported Codex token counts are forwarded when available and omitted otherwise. Completion IDs contain actual Codex thread and turn IDs. Only one request runs at a time, with a 2 MiB input limit, 8 MiB protocol output limit and 180-second cancellation. Processes and temporary directories are cleaned up on completion or failure.

Ordinary decisions require nonempty content in the requested schema. If a completed generation nevertheless contains neither text nor a tool proposal, the bridge requests one replacement under the same deadline and guards. It never synthesizes an acknowledgment or dispatches a tool from the empty response. A second empty response, transport failure, billing rejection or unauthorized proposal still fails. Combined usage is reported only when both generations supplied actual usage receipts; otherwise it is omitted.

Sandbox `exec` proposals use structured command arguments, including an explicit working directory or null. The bridge serializes them once for TrueForge and omits a null directory. This avoids the malformed nested JSON escaping reproduced in a real Luna response. Other tools retain their existing argument format. Exact single-command operations must stop after their recorded result; multi-step source repairs may continue inspecting and editing until the requested work is complete.

Preflight contacts the authenticated gateway health endpoint; a saved TrueForge registration alone cannot establish readiness. TrueForge masks credentials in its provider listing, so this probe reads the separate owned, private local capability file, not an API key or Codex authentication file.

## Verification

`pnpm test:runtime` checks actual execution and approval transport. `pnpm test:repair` introduces a labelled fault in an isolated source copy and requires the unchanged host evaluator to accept a generated repair. Unit fixtures are synthetic, not live acceptance evidence. See [verification status](verification-status.md) for actual outcomes.

Official references: [authentication](https://learn.chatgpt.com/docs/auth), [pricing and limits](https://learn.chatgpt.com/docs/pricing), [app-server](https://learn.chatgpt.com/docs/app-server).
