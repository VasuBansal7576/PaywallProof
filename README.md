# PaywallProof

Check whether subscription state and access to a paid feature agree. Reproduce failures, collect evidence, and prepare a tested repair for approval.

A complete local-replay scan and a generated application repair passed through TrueForge and the real browser. The repair reproduced the original failure, then passed all twelve scenario assertions and fourteen security controls under the same frozen evaluator. Real Polar payment lifecycle acceptance remains pending. The full requirements are in [PRD.md](PRD.md).

[Recorded local-replay sample](examples/recorded-local-replay.json) contains an explicitly reduced projection of the actual Luna run, including scenario outcomes, screenshot hashes, cleanup and the source receipt hash. It is not a Polar transaction or a fabricated demonstration report.

[Recorded repair acceptance](examples/recorded-repair.json) preserves the actual before/after outcomes and cleanup for an isolated injected fault. It is not a discovered production bug, provider payment or published repair PR.

## Real application verification

PaywallProof has also passed against the separate user-owned **Kill My SaaS / ProgramFlow** application, using its real Registration & Commerce services and a clean PostgreSQL 17 database. Run `1320a925-a06e-4ae9-9e8a-370fff3e15a3` passed all 12 API, browser and application-state assertions across unpaid checkout, settlement, pending refund and completed refund. It issued and revoked a real ProgramFlow ticket and purchaser-scoped immutable invoice, then deleted both run-owned registrations and every dependent commerce record.

[Inspect the ProgramFlow case study](docs/real-world/programflow/README.md), including its compact machine-readable receipt and one representative browser screenshot. Third-party source, patches, raw reports, and redundant screenshots stay in their owning repository or ignored local evidence.

The payment provider was an explicit signed local test port with zero external calls. This proves integration with a separate real application and its persisted domain state; it does not replace the pending native provider lifecycle gate.

## Boundaries

- Authorized staging applications and isolated provider sandbox resources only.
- No live billing, automatic merge, or production deployment.
- Zero external spending. Integrations stay blocked until their no-charge operation is verified.
- Test fixtures and local replay never count as real provider evidence.
- Existing independent tests were authored from public contracts without implementation access. New migration tests are labeled implementation-aware.

## Qodo Code Review Evidence

[Implementation PR #1](https://github.com/VasuBansal7576/PaywallProof/pull/1) has received Qodo review. No substantive implementation PR has been merged yet.

The [Qodo review thread](https://github.com/VasuBansal7576/PaywallProof/pull/1#issuecomment-5441252429) identified cancellation races, unsafe path collisions, stale browser timestamps, missing live-gateway checks, and a newest-turn pagination bug. Each valid finding now has a focused regression test. The pagination test uses a multi-page SDK iterator so a one-item mock cannot hide the fault again.

The organizer requires a representative **merged** reviewed PR. PR #1 is still open, so that submission requirement is not yet satisfied. No merge or deployment is implied by a passing test or completed review.

Current executed checks and remaining acceptance gaps are recorded in [verification status](docs/verification-status.md). Unit test counts and installation probes do not establish a completed product run.

[Watch the three-minute workspace walkthrough](docs/media/paywallproof-walkthrough.mp4), with an embedded subtitle track and [separate captions](docs/media/paywallproof-walkthrough.srt). It shows a recorded local-replay run, not a live provider payment.

[Submission material](docs/submission.md) includes the architecture, a reproducible recording command and the remaining merge requirement. Original project code uses the [MIT license](LICENSE); dependencies retain their own licenses.

The [judging access notes](docs/judging-access.md) distinguish the 60-day local evidence window from provider access. Polar sandbox tokens expire November 26, 2026. No paid hosting is used.

## Billing provider migration

The owner authorized replacing Stripe on August 28. The runtime, target, UI and contracts now use Polar's isolated sandbox. Organization, product and both token scopes have passed actual read-only preflight. The paid lifecycle remains unverified. Do not continue Stripe onboarding. See the [migration requirements](docs/billing-provider-migration.md).

`pnpm test:polar` performs only a read-only organization/product/price preflight. It requires server-side `POLAR_ACCESS_TOKEN`, `POLAR_ORGANIZATION_ID`, `POLAR_PRODUCT_ID` and `POLAR_PRICE_ID`. Do not put these values in chat or tracked files. Missing or rejected configuration exits with code 2. Even a successful preflight explicitly reports `lifecycleVerified: false`; it does not verify checkout, webhooks, access scenarios or repair.

## Development disclosure

The owner uses Codex for implementation, independent test authoring, and verification. Human review and understanding remain required. Test and integration results will be recorded only after execution.

## How TrueForge is used

TrueForge runs the persistent agent session, invokes the run-scoped MCP tools and pauses fixture creation and publication for approval. The controller binds each operation to a saved policy, target build and run identity. API probes, real browser sessions and application-state reads produce separate observations for free access, paid access, scheduled cancellation and expiry.

After a run completes, the operator can start an independent evidence review. PaywallProof registers the repository's `paywallproof-evidence-review` skill and creates a separate sandboxed TrueForge session with dynamic subagents enabled. That session can only read the bound report and record a bounded review. Two independent reviewers check coverage and binding consistency; their synthesis is stored separately and cannot alter the primary run outcome.

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
HOST=127.0.0.1 \
SQLITE_PATH=.local/trueforge.sqlite \
PAYWALLPROOF_LOCAL_PYTHON=/absolute/path/to/python3 \
PAYWALLPROOF_LOCAL_GIT_ROOT=/Library/Developer/CommandLineTools \
pnpm exec trueforge --port 8790
```

Set `PAYWALLPROOF_LOCAL_PYTHON` to the absolute path of a Python 3.11–3.13 executable with `venv`. On macOS, set `PAYWALLPROOF_LOCAL_GIT_ROOT` to the exact directory returned by `xcode-select -p`; the example shows the default location. The committed runtime patch adds only those validated runtime roots to sandbox reads. It rejects `/`, the home directory, relative paths, and other broad roots.

In a second terminal, register the guarded subscription connection and keep its bridge running:

```sh
pnpm model:codex
pnpm dev:codex-model
```

In a third terminal, run `pnpm dev`. Read the operator token from the local file named below and enter it in the workspace sign-in form; never commit or share it. Run `pnpm test:runtime` before starting a workflow on a new machine. No model weights or Ollama installation are needed.

`pnpm dev` starts the operator UI on port 3000, reference target on 3001 and worker on 8787. The operator token is in `.local/operator-token`. TrueForge must already be running on loopback port 8790. Ollama is not required. The selected [Codex subscription connection](docs/codex-subscription.md) uses Luna with included allowance and rejects extra-credit balances. There is no fallback to a paid API or another model.

Local replay needs no provider account. It exercises the actual application and browser using explicitly synthetic billing events. New schema-v2 runs use `control-v2.sqlite` and `reference-v2.sqlite`; old databases and evidence are preserved without relabeling.

The operator workspace provides searchable run history, an attention queue, responsive navigation and keyboard-accessible report tabs. Humans can inspect each recorded assertion and screenshot; agents can use the authenticated structured reports, exact identifiers and policy hashes. The UI never substitutes presentation fixtures for saved evidence.

For Polar runs, configure `POLAR_ACCESS_TOKEN`, `POLAR_REFERENCE_TOKEN`, `POLAR_ORGANIZATION_ID`, `POLAR_PRODUCT_ID`, `BILLING_PRICE_ID`, `POLAR_WEBHOOK_SECRET` and an explicitly authorized `POLAR_TEST_CUSTOMER_EMAIL` in the server environment. The test mailbox is used with a unique run alias and sent to Polar. It is not inferred from account sign-in. Configure real webhook delivery to `/api/polar/webhook`. Only sandbox checkout URLs are permitted; use official test payment details, never a real card. The authenticated run page exposes the private checkout link while the runner waits for payment confirmation.

| Command                                          | What it checks                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `pnpm verify`                                    | Formatting, repository shape, types, lint, tests, production build, browser checks |
| `pnpm test:turn-selection`                       | Multi-page TrueForge newest-turn behavior                                          |
| `pnpm test:evidence-review`                      | Skill registration, dynamic subagents, scoped tools, persisted review              |
| `pnpm test:acceptance`                           | Local reference integration tests                                                  |
| `pnpm test:polar`                                | Real read-only Polar preflight; not lifecycle acceptance                           |
| `pnpm test:runtime`                              | TrueForge installation and approval behavior                                       |
| `pnpm model:codex`                               | Check subscription allowance and register Luna; no inference or billing change     |
| `pnpm dev:codex-model`                           | Start the local bridge to the signed-in Codex CLI                                  |
| `pnpm test:repair`                               | Isolated fault injection, model-generated repair and unchanged before/after oracle |
| `pnpm exec tsx scripts/verify-local-workflow.ts` | Full local-replay product run through TrueForge                                    |
| `pnpm demo:reset`                                | Stop inventoried runs and clean only their owned fixtures                          |

Provider audit records are retained honestly. An active or unexpired checkout that cannot be safely removed remains a reported leftover. A retained report never becomes a fresh verification merely because it is still accessible.

The local workflow verifier saves each receipt under `.local/workflow-<run-id>/`, checks all twelve scenario assertions and both fixture deletions, and preserves the previous successful report before updating the repair seed. On failure it requests cancellation and records whether that request was confirmed.

`pnpm test:repair` requires the real `.local/local-workflow-report.json` produced by the local workflow verifier and at least 4 GiB free. It copies committed source into an isolated repository, injects a scheduled-cancellation fault, reproduces it through the real application, then asks the selected model to repair it. Only the explicit application-source allowlist reaches the model, never this script or the host evaluator. Results remain under `.local/full-repair-*/`; failures are preserved. It makes no billing-provider or publication call and does not modify the working application. Model prompts and sanitized results go to OpenAI through the signed-in Codex connection; billing replay stays local.

## Submission checklist

### TrueForge

- [x] Persistent sessions, streamed recovery, MCP tool scoping, sandbox execution, and human approvals are implemented.
- [x] The newest-turn paginator bug has a multi-page regression test.
- [x] A reusable repository skill is registered from Git and attached to the review session.
- [x] Dynamic subagents perform two independent report reviews in a separate session.
- [x] The review session exposes only report read and bounded review-recording tools.
- [ ] Run the new evidence-review path against the final committed ref on the local TrueForge stack and retain its receipt.

### Qodo

- [x] Repository configuration requests agentic description and review on GitHub PRs.
- [x] CI checks formatting, repository shape, types, lint, tests, build, browser behavior, and skill validity.
- [ ] Push the final implementation commit and request `/agentic_review`.
- [ ] Fix valid findings and explain invalid or deferred findings in the review thread.
- [ ] Request a follow-up review on the final commit.
- [ ] Merge the representative reviewed PR; its public link is PR #1 above.
