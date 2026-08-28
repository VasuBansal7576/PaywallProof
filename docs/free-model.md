# Run without Ollama

The owner rejected Ollama because it made this Mac slow. Do not reinstall it or replace it with another large local model. TrueForge, the application, sandbox and browser checks can still run locally while inference runs remotely. Qodo and every access/repair requirement stay in place.

## Selected connection

The new connection is `paywallproof-free/gemma-4-31b`, backed by OpenRouter's `google/gemma-4-31b-it:free`. The public catalog on August 28, 2026 lists zero prompt/completion prices, tool calling and a 262,144-token context. This is catalog evidence, not a successful inference or repair.

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

The connection is implemented but not activated. No OpenRouter key has been created, no model inference has run through it, and no hosted repair success is claimed. Synthetic gateway tests verify rejection/forwarding behavior, not provider billing or model quality. Keep historical failed repair receipts unchanged.

## Sources

- [OpenRouter free model variants](https://openrouter.ai/docs/guides/routing/model-variants/free)
- [Current public model catalog](https://openrouter.ai/api/v1/models)
- [Price caps and provider privacy restrictions](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Key metadata and quota behavior](https://openrouter.ai/docs/api_reference/limits)
- [Why `auto:free` can still charge](https://openrouter.zendesk.com/hc/en-us/articles/51679572756123-I-used-openrouter-auto-free-or-auto-and-still-got-charged)
