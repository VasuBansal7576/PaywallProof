# PaywallProof

Check whether subscription state and access to a paid feature agree. Reproduce failures, collect evidence, and prepare a tested repair for approval.

A complete local-replay scan and a generated application repair passed through TrueForge and the real browser. The repair reproduced the original failure, then passed all twelve scenario assertions and fourteen security controls under the same frozen evaluator. Real Polar payment lifecycle acceptance remains pending. The full requirements are in [PRD.md](PRD.md).

[Recorded local-replay sample](examples/recorded-local-replay.json) contains an explicitly reduced projection of the actual Luna run, including scenario outcomes, screenshot hashes, cleanup and the source receipt hash. It is not a Polar transaction or a fabricated demonstration report.

[Recorded repair acceptance](examples/recorded-repair.json) preserves the actual before/after outcomes and cleanup for an isolated injected fault. It is not a discovered production bug, provider payment or published repair PR.

## Boundaries

- Authorized staging applications and isolated provider sandbox resources only.
- No live billing, automatic merge, or production deployment.
- Zero external spending. Integrations stay blocked until their no-charge operation is verified.
- Test fixtures and local replay never count as real provider evidence.
- Existing independent tests were authored from public contracts without implementation access. New migration tests are labeled implementation-aware.

## Qodo Code Review Evidence

[Implementation PR #1](https://github.com/VasuBansal7576/PaywallProof/pull/1) has received Qodo review. No substantive implementation PR has been merged yet.

The [Qodo review thread](https://github.com/VasuBansal7576/PaywallProof/pull/1#issuecomment-5441252429) identified cancellation races, unsafe path collisions, stale browser timestamps and missing live-gateway checks; those were fixed and received follow-up reviews. Its latest useful finding added browser coverage for OpenRouter consent, while incorrect turn-ordering and artifact-metadata findings were checked against source and executable tests rather than applied blindly.

The organizer requires a representative **merged** reviewed PR. PR #1 is still open, so that submission requirement is not yet satisfied. No merge or deployment is implied by a passing test or completed review.

Current executed checks and remaining acceptance gaps are recorded in [verification status](docs/verification-status.md). Unit test counts and installation probes do not establish a completed product run.

[Submission material](docs/submission.md) includes the architecture, a reproducible recording command and the remaining merge and upload requirements. Original project code uses the [MIT license](LICENSE); dependencies retain their own licenses.

The [judging access notes](docs/judging-access.md) distinguish the 60-day local evidence window from provider access. Polar sandbox tokens expire November 26, 2026. No paid hosting is used.

## Billing provider migration

The owner authorized replacing Stripe on August 28. The runtime, target, UI and contracts now use Polar's isolated sandbox. Organization, product and both token scopes have passed actual read-only preflight. The paid lifecycle remains unverified. Do not continue Stripe onboarding. See the [migration requirements](docs/billing-provider-migration.md).

`pnpm test:polar` performs only a read-only organization/product/price preflight. It requires server-side `POLAR_ACCESS_TOKEN`, `POLAR_ORGANIZATION_ID`, `POLAR_PRODUCT_ID` and `POLAR_PRICE_ID`. Do not put these values in chat or tracked files. Missing or rejected configuration exits with code 2. Even a successful preflight explicitly reports `lifecycleVerified: false`; it does not verify checkout, webhooks, access scenarios or repair.

## Development disclosure

The owner uses Codex for implementation, independent test authoring, and verification. Human review and understanding remain required. Test and integration results will be recorded only after execution.

## How TrueForge is used

TrueForge runs the persistent agent session, invokes the run-scoped MCP tools and pauses fixture creation and publication for approval. The controller binds each operation to a saved policy, target build and run identity. API probes, real browser sessions and application-state reads produce separate observations for free access, paid access, scheduled cancellation and expiry.

For a confirmed failure, TrueForge transfers allowlisted application source into its sandbox and executes the agent's proposed repair commands. A separate host evaluator runs the original and patched application against the same frozen checks; the repair agent cannot edit or read those tests. Publication requires approval of the exact verified diff and destination. The Codex bridge supplies model decisions only: it does not execute the application tools or replace TrueForge's approval and sandbox controls.

## Run locally

The exercised environment is macOS with Node.js 22.20, pnpm 10.32, Python 3.11+ and Codex CLI 0.147.0 signed in with an entitled ChatGPT account. The local repair sandbox currently requires macOS; do not assume another platform is verified.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
mkdir -p .local
chmod 700 .local
```

Start TrueForge in one terminal:

```sh
HOST=127.0.0.1 SQLITE_PATH=.local/trueforge.sqlite pnpm exec trueforge --port 8790
```

If Python is not discoverable, set `PAYWALLPROOF_LOCAL_PYTHON` to the absolute path of your existing Python 3.11+ executable before starting TrueForge. The committed runtime patch adds only that interpreter prefix to sandbox reads; it does not permit arbitrary host access.

In a second terminal, register the guarded subscription connection and keep its bridge running:

```sh
pnpm model:codex
pnpm dev:codex-model
```

In a third terminal, run `pnpm dev`. Read the operator token from the local file named below and enter it in the workspace sign-in form; never commit or share it. Run `pnpm test:runtime` before starting a workflow on a new machine. No model weights or Ollama installation are needed.

`pnpm dev` starts the operator UI on port 3000, reference target on 3001 and worker on 8787. The operator token is in `.local/operator-token`. TrueForge must already be running on loopback port 8790. Ollama is not required. The selected [Codex subscription connection](docs/codex-subscription.md) uses Luna with included allowance and rejects extra-credit balances. The [free hosted alternative](docs/free-model.md) requires a dedicated $0-capped OpenRouter key. Both have passed actual inference, sandbox and approval-transport checks; these are not full repair or provider-lifecycle acceptance. There is no automatic fallback to a paid or local model.

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
| `pnpm model:codex` | Check subscription allowance and register Luna; no inference or billing change |
| `pnpm dev:codex-model` | Start the local bridge to the signed-in Codex CLI |
| `pnpm test:repair` | Isolated fault injection, model-generated repair and unchanged before/after oracle |
| `pnpm exec tsx scripts/verify-local-workflow.ts` | Full local-replay product run through TrueForge |
| `pnpm demo:reset` | Stop inventoried runs and clean only their owned fixtures |

Provider audit records are retained honestly. An active or unexpired checkout that cannot be safely removed remains a reported leftover. A retained report never becomes a fresh verification merely because it is still accessible.

The local workflow verifier saves each receipt under `.local/workflow-<run-id>/`, checks all twelve scenario assertions and both fixture deletions, and preserves the previous successful report before updating the repair seed. On failure it requests cancellation and records whether that request was confirmed.

`pnpm test:repair` requires the real `.local/local-workflow-report.json` produced by the local workflow verifier and at least 4 GiB free. It copies committed source into an isolated repository, injects a scheduled-cancellation fault, reproduces it through the real application, then asks the selected no-charge model to repair it. Only the explicit application-source allowlist reaches the model, never this script or the host evaluator. Results remain under `.local/full-repair-*/`; failures are preserved. It makes no billing-provider or publication call and does not modify the working application. The selected connection sends model prompts and sanitized results to OpenAI through Codex, or to OpenRouter when explicitly configured; billing replay stays local.
