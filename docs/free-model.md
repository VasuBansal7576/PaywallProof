# Run without Ollama

The owner rejected Ollama because it made this Mac slow. Do not reinstall it or replace it with another large local model. TrueForge, the application, sandbox and browser checks can still run locally while inference runs remotely. Qodo and every access/repair requirement stay in place.

## Selected connection

The selected connection is `paywallproof-free/north-mini-code`, backed by OpenRouter's `cohere/north-mini-code:free`. The public catalog on August 28, 2026 lists zero prompt/completion prices, tool calling and a 256,000-token context. The earlier Gemma selection returned HTTP 429 from its provider in both a runtime probe and a minimal connectivity diagnostic. Switching to North Mini Code was an explicit configuration change, not an automatic fallback. The gateway rejects requests naming the earlier model.

TrueForge calls an authenticated policy gateway on `127.0.0.1:8791`. The gateway forwards to exactly `https://openrouter.ai/api/v1/chat/completions`. It does not load model weights. The OpenRouter credential stays in a private local file, outside TrueForge agent specs, prompts and repair checkouts. TrueForge stores only a separate gateway capability.

Before every generation, the gateway checks the key and current catalog. It requires a $0 key limit, BYOK usage included in that limit, and zero recorded usage. The selected model must still have zero prices and tool support. Every forwarded request also sets `max_price` to zero for prompt, completion, request and image pricing, disables provider fallbacks and denies providers that collect data. Only text and client function tools are accepted. Routing overrides, paid models, plugins, server tools, presets and external media are rejected.

There are no paid or local-model fallbacks and no automatic retries. Quota exhaustion, changed pricing, unsupported privacy settings or unavailable free capacity stop the run. No account top-up, paid trial, billing upgrade or BYOK credential is created by these scripts. A provider refusing a $0-capped key remains a blocker, never permission to raise the limit.

Only one generation can be active through the gateway. Requests are bounded to 2 MiB and 8,192 output tokens; responses to 8 MiB. Cancellation closes the upstream request. The 180-second request limit does not replace the existing product run and repair limits.

## Activation

1. Explicitly approve creating a dedicated OpenRouter API key named `PaywallProof free only`, with a $0 credit limit and BYOK included. Do not reuse an unrestricted existing key. Browser key creation and credential handling require action-time confirmation.
2. Save it to `.local/openrouter-api-key` with file mode `0600`, inside a `0700` `.local` directory. Do not paste it into chat, source, command arguments or reports.
3. Run `pnpm model:configure`. This checks account/catalog metadata, registers the local gateway with TrueForge and saves the selected model. It performs no inference. TrueForge must already be running on loopback8790.
4. Run `pnpm dev:model`, then restart `pnpm dev` to load the saved selection. The gateway is a separate small Node process, not a model server. `TRUEFORGE_MODEL` can explicitly override the saved choice, but service failure never changes it automatically.
5. Connect a project with consent for OpenRouter to process its selected source and sanitized observations. These prompts and tool results leave the Mac. The host evaluator and independent tests remain excluded. Run `pnpm test:runtime`, the full local workflow and `pnpm test:repair`, preserving each real result.

The original local-model connector remains available for other installations. None of these commands downloads, installs, starts or restores Ollama. Existing sessions keep their original model; do not relabel an old Ollama run as hosted inference. Start a fresh session for new verification.

## Verification status

On August 28, the owner approved creating the dedicated key. The OpenRouter UI created it with a $0 limit, but the authenticated metadata response reported `include_byok_in_limit: false`. Both usage counters and the remaining limit were zero. `pnpm model:configure` refused activation, and no inference request was sent at that checkpoint.

The key editor exposed no BYOK inclusion control. With separate owner approval, a temporary management key updated only the dedicated key to include BYOK in its $0 cap and re-enabled it. Authenticated readback confirmed both limits and both usage counters were zero. The management key was immediately deleted; a subsequent request returned HTTP 401, and its private local credential file was removed. Existing keys and account billing settings were untouched. The project credential remains in the ignored, mode-0600 key file. `pnpm model:configure` then completed successfully.

North Mini Code performed a real sandbox exec and returned 42. Its next model call exposed a gateway compatibility bug: the installed TrueForge SDK includes prior assistant `reasoning_content` during tool continuation. A regression failed before the fix and passed afterward. Only assistant text is accepted in that field, within the unchanged request-size budget. Routing metadata and unknown fields remain rejected. The 72 focused gateway tests pass.

A fresh actual runtime check then passed sandbox execution, stream reconnection, exactly-once approved execution, denied execution staying at zero, and stale-approval rejection. Its receipt is `.local/runtime-verification-2026-08-28T18-26-39-324Z.json`. A subsequent authenticated account check still reported both usage counters at zero. The full suite passes 1,726 tests across 25 files with no failures or skips. These results establish the connection and runtime installation, not a completed application repair or a provider-backed payment lifecycle.

The full hosted repair attempt is `.local/full-repair-7d5f49fb-1ff1-4a01-bdec-a5c5a7e92700/acceptance.json`. Its actual fault baseline reproduced the scheduled-cancellation access failure, passed the other scenarios and all fourteen security controls, and deleted both disposable users. During repair attachment transfer, the model replayed an earlier exec command and made additional tool calls despite the transfer-only instruction. The unchanged runner rejected it with `UNEXPECTED_RUNTIME_TOOL`. No generated patch or repaired result is claimed.

A separate attempt to validate the stronger free GLM 5.2 endpoint returned HTTP 429 before sandbox execution. That receipt remains `.local/runtime-verification-2026-08-28T18-33-31-363Z.json`. The selected configuration was explicitly restored to North Mini Code, which passed the actual installation checks. No paid fallback, quota purchase or cap increase was attempted. The final suite passes 1,727 tests across 25 files, including 73 focused gateway tests. Synthetic tests verify code behavior, not future provider availability or repair quality. Keep all failed receipts unchanged.

## Sources

- [OpenRouter free model variants](https://openrouter.ai/docs/guides/routing/model-variants/free)
- [Current public model catalog](https://openrouter.ai/api/v1/models)
- [North Mini Code free endpoint](https://openrouter.ai/cohere/north-mini-code:free)
- [Price caps and provider privacy restrictions](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Key metadata and quota behavior](https://openrouter.ai/docs/api_reference/limits)
- [Update a key, including its BYOK spending limit](https://openrouter.ai/docs/api/api-reference/api-keys/update-keys)
- [Why `auto:free` can still charge](https://openrouter.zendesk.com/hc/en-us/articles/51679572756123-I-used-openrouter-auto-free-or-auto-and-still-got-charged)
