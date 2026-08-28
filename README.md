# PaywallProof

Check whether subscription state and access to a paid feature agree. Reproduce failures, collect evidence, and prepare a tested repair for approval.

A recorded complete local-replay scan passed through TrueForge and the real browser. Real Polar payment lifecycle and generated-repair acceptance remain pending. The full requirements are in [PRD.md](PRD.md).

## Boundaries

- Authorized staging applications and isolated provider sandbox resources only.
- No live billing, automatic merge, or production deployment.
- Zero external spending. Integrations stay blocked until their no-charge operation is verified.
- Test fixtures and local replay never count as real provider evidence.
- Existing independent tests were authored from public contracts without implementation access. New migration tests are labeled implementation-aware.

## Qodo review evidence

[Implementation PR #1](https://github.com/VasuBansal7576/PaywallProof/pull/1) has received Qodo review. No substantive implementation PR has been merged yet.

The [Qodo review thread](https://github.com/VasuBansal7576/PaywallProof/pull/1#issuecomment-5441252429) identified runtime cancellation races, unsafe path collisions, and stale timestamps after cold browser startup. Follow-up changes address those findings and require another review before merge. Earlier missing-entrypoint, secret-permission and invoice-handling findings were resolved in the implementation.

Current executed checks and remaining acceptance gaps are recorded in [verification status](docs/verification-status.md). Unit test counts and installation probes do not establish a completed product run.

The [judging access notes](docs/judging-access.md) distinguish the 60-day local evidence window from provider access. Polar sandbox tokens expire November 26, 2026. No paid hosting is used.

## Billing provider migration

The owner authorized replacing Stripe on August 28. The runtime, target, UI and contracts now use Polar's isolated sandbox. Organization, product and both token scopes have passed actual read-only preflight. The paid lifecycle remains unverified. Do not continue Stripe onboarding. See the [migration requirements](docs/billing-provider-migration.md).

`pnpm test:polar` performs only a read-only organization/product/price preflight. It requires server-side `POLAR_ACCESS_TOKEN`, `POLAR_ORGANIZATION_ID`, `POLAR_PRODUCT_ID` and `POLAR_PRICE_ID`. Do not put these values in chat or tracked files. Missing or rejected configuration exits with code 2. Even a successful preflight explicitly reports `lifecycleVerified: false`; it does not verify checkout, webhooks, access scenarios or repair.

## Development disclosure

The owner uses Codex for implementation, independent test authoring, and verification. Human review and understanding remain required. Test and integration results will be recorded only after execution.

## Run locally

`pnpm dev` starts the operator UI on port 3000, reference target on 3001 and worker on 8787. The operator token is in `.local/operator-token`. TrueForge must already be running on loopback port 8790. Ollama is not required: the [free hosted model connection](docs/free-model.md) moves inference off the Mac without loading local weights. Activation requires a dedicated $0-capped OpenRouter key; live inference on this new path remains unverified. There is no automatic fallback to a paid or local model.

Local replay needs no provider account. It exercises the actual application and browser using explicitly synthetic billing events. New schema-v2 runs use `control-v2.sqlite` and `reference-v2.sqlite`; old databases and evidence are preserved without relabeling.

The operator workspace provides searchable run history, an attention queue, responsive navigation and keyboard-accessible report tabs. Humans can inspect each recorded assertion and screenshot; agents can use the authenticated structured reports, exact identifiers and policy hashes. The UI never substitutes presentation fixtures for saved evidence.

For Polar runs, configure `POLAR_ACCESS_TOKEN`, `POLAR_REFERENCE_TOKEN`, `POLAR_ORGANIZATION_ID`, `POLAR_PRODUCT_ID`, `BILLING_PRICE_ID`, `POLAR_WEBHOOK_SECRET` and an explicitly authorized `POLAR_TEST_CUSTOMER_EMAIL` in the server environment. The test mailbox is used with a unique run alias and sent to Polar. It is not inferred from account sign-in. Configure real webhook delivery to `/api/polar/webhook`. Only sandbox checkout URLs are permitted; use official test payment details, never a real card. The authenticated run page exposes the private checkout link while the runner waits for payment confirmation.

| Command | What it checks |
| --- | --- |
| `pnpm typecheck` | TypeScript |
| `pnpm lint` | ESLint |
| `pnpm test` | Local contracts, security, replay and browser tests |
| `pnpm test:acceptance` | Local reference integration tests |
| `pnpm test:polar` | Real read-only Polar preflight; not lifecycle acceptance |
| `pnpm test:runtime` | TrueForge installation and approval behavior |
| `pnpm model:configure` | Verify a zero-spend key and register the free hosted connection; no inference |
| `pnpm dev:model` | Start the authenticated zero-price gateway; no local model weights |
| `pnpm test:repair` | Isolated fault injection, model-generated repair and unchanged before/after oracle |
| `pnpm exec tsx scripts/verify-local-workflow.ts` | Full local-replay product run through TrueForge |
| `pnpm demo:reset` | Stop inventoried runs and clean only their owned fixtures |

Provider audit records are retained honestly. An active or unexpired checkout that cannot be safely removed remains a reported leftover. A retained report never becomes a fresh verification merely because it is still accessible.

`pnpm test:repair` requires the real `.local/local-workflow-report.json` produced by the local workflow verifier and at least 4 GiB free. It copies committed source into an isolated repository, injects a scheduled-cancellation fault, reproduces it through the real application, then asks the selected no-charge model to repair it. Only the explicit application-source allowlist reaches the model, never this script or the host evaluator. Results remain under `.local/full-repair-*/`; failures are preserved. It makes no billing-provider, publication or paid model call and does not modify the working application. The free hosted connection sends model prompts and sanitized tool results to OpenRouter; billing replay stays local.
