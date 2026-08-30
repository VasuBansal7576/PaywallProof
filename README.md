# PaywallProof

PaywallProof checks whether billing state and paid-feature access agree. It runs an approved subscription lifecycle, records API, browser, and application-state evidence, and prepares a tested repair when it finds a mismatch.

[Watch the product demo](https://youtu.be/z-bXuMFx9lQ)

## What was verified

On August 29, 2026, PaywallProof completed a native Polar sandbox lifecycle through TrueForge:

1. Confirmed that a free user could not access the paid feature.
2. Completed a sandbox checkout and received signed Polar webhooks.
3. Confirmed paid access through the API, browser, and application state.
4. Scheduled cancellation and confirmed access remained valid before expiry.
5. Waited for Polar to report the terminal canceled state.
6. Confirmed post-expiry denial and removed the run-owned application users.

All 12 scenario assertions passed. Polar reported `livemode: false`, so no real payment was processed. The terminal receipt for run `7563883e-62d1-45a3-86e7-5bd09f8cbfb3` has SHA-256 `993f30e59e9e383edda2f9b95681b8474cef104d8c9610761eb2907c5e14ab06`. Provider identifiers, checkout URLs, tokens, and raw webhook data remain outside Git.

The repository also includes reduced, non-secret examples from the completed runs:

- [Recorded local replay](examples/recorded-local-replay.json)
- [Recorded repair acceptance](examples/recorded-repair.json)
- [Executed verification record](docs/verification.md)

These examples are evidence projections. They are not provider transactions.

## How it works

TrueForge owns the persistent agent session, tool permissions, sandbox execution, and approval pauses. Deterministic application code owns policy evaluation, evidence validation, and verdicts.

The main flow is:

1. Bind a run to an approved target, build, price, policy, and spending limit.
2. Create isolated test identities and exercise the four access states.
3. Collect separate API, browser, provider, and application-state observations.
4. Evaluate the observations without allowing the model to convert missing evidence into a pass.
5. If a failure is confirmed, copy only approved source into a sandbox and ask the agent for a repair.
6. Run the original and patched applications against the same host-owned evaluator.
7. Require approval for the exact verified diff before any publication step.

After a run, a separate TrueForge session can review the saved report. The repository's `paywallproof-evidence-review` skill starts two dynamically delegated reviewers with read-only report access. Their synthesis is stored separately and cannot change the primary verdict.

## Repository map

| Path                                  | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `apps/web`                            | Operator workspace and authenticated reports                            |
| `apps/worker`                         | Workflow orchestration, provider adapters, evidence, and repair control |
| `apps/demo-saas`                      | Reference SaaS used for local and sandbox verification                  |
| `skills/paywallproof-evidence-review` | Reusable report-review skill and reviewer definitions                   |
| `tests/independent`                   | Public-boundary tests written from the contract documents               |
| `tests/acceptance`                    | Cross-module reference and replay checks                                |
| `docs/contracts`                      | Versioned inputs used to author the independent tests                   |
| `scripts`                             | Runtime, provider, repair, and repository verification commands         |

Start with [the product specification](PRD.md) for requirements and [the documentation index](docs/README.md) for implementation details.

## Qodo Code Review Evidence

[Lifecycle PR #2](https://github.com/VasuBansal7576/PaywallProof/pull/2) contains the native Polar and TrueForge continuation work. Qodo found three defects: a split persistence commit, an unbounded chunked webhook body, and a cross-scenario evidence citation gap. Each finding received a regression test and a fix. Qodo marked all three resolved before the PR passed CI and merged as `32664e030e2612b0e39e3783a373c192c3b24dac`.

[CI PR #3](https://github.com/VasuBansal7576/PaywallProof/pull/3) upgraded the GitHub Action runtimes after the workflow emitted a Node 20 deprecation notice. The updated workflow passed its full gate, Qodo reported no findings, and the merged `main` workflow passed again.

[Persistence PR #4](https://github.com/VasuBansal7576/PaywallProof/pull/4) moved checkout continuation and control-document persistence behind dedicated owners. Qodo raised two documentation accuracy issues. Both were corrected and marked resolved before CI passed and the PR merged as `4ad469c90ed78944b816e28a56573f938d125af8`.

Qodo is part of the development gate, not the product runtime. Substantive changes are reviewed on a pull request, valid findings are fixed, and the final head is reviewed again before merge.

## Run locally

The verified local environment used macOS, Node.js 22.20, pnpm 10.32, Python 3.11 through 3.13, and Codex CLI 0.147.0. The lockfile resolves TrueForge 0.1.4, Next.js 16.3.3, and the Playwright test runtime 1.62.1. Polar requests use API version `2026-04`. The repair sandbox is currently verified only on macOS.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
mkdir -p .local
chmod 700 .local
```

Start TrueForge:

```sh
HOST=127.0.0.1 \
SQLITE_PATH=.local/trueforge.sqlite \
PAYWALLPROOF_LOCAL_PYTHON=/absolute/path/to/python3 \
PAYWALLPROOF_LOCAL_GIT_ROOT=/Library/Developer/CommandLineTools \
pnpm exec trueforge --port 8790
```

`PAYWALLPROOF_LOCAL_PYTHON` must point to Python 3.11 through 3.13 with `venv`. On macOS, set `PAYWALLPROOF_LOCAL_GIT_ROOT` to the exact result of `xcode-select -p`.

Register and start the guarded Codex subscription bridge in two terminals:

```sh
pnpm model:codex
pnpm dev:codex-model
```

Then start the product:

```sh
pnpm dev
```

The workspace runs on port 3000, the reference SaaS on 3001, and the worker on 8787. TrueForge must already be listening on loopback port 8790. The operator token is written to `.local/operator-token` and must not be committed or shared.

Local replay does not require a provider account. Polar verification requires separately authorized sandbox credentials and an explicit test mailbox. Use official Polar test payment details only. Never use a real card.

For a native Polar run, configure these server-side values:

```text
POLAR_ACCESS_TOKEN
POLAR_REFERENCE_TOKEN
POLAR_ORGANIZATION_ID
POLAR_PRODUCT_ID
BILLING_PRICE_ID
POLAR_WEBHOOK_SECRET
POLAR_TEST_CUSTOMER_EMAIL
```

The read-only `pnpm test:polar` preflight uses `POLAR_PRICE_ID` in place of `BILLING_PRICE_ID`. Configure Polar to deliver signed sandbox events to `/api/polar/webhook`. Tokens, the test mailbox, and private checkout links must stay outside chat and Git.

To connect another owned staging application, implement the authenticated routes in the [target adapter contract](docs/contracts/reference-contract.md), including build identity, run-scoped test users, ordinary user sessions, billing-state reads, and cleanup. Staging hooks must be disabled in production, and the adapter credential must never grant access to the protected feature. The bundled reference app is the only adapter verified by this repository.

## Verification commands

| Command                                          | Purpose                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `pnpm verify:ci`                                 | Formatting, repository shape, delivery configuration, types, lint, tests, and production build |
| `pnpm verify`                                    | The CI gate plus the live browser contract on a supported local machine                        |
| `pnpm test:turn-selection`                       | TrueForge newest-turn recovery across multiple pages                                           |
| `pnpm test:evidence-review`                      | Skill registration, dynamic reviewers, tool scope, and persisted synthesis                     |
| `pnpm test:polar`                                | Read-only Polar organization, product, and price preflight                                     |
| `pnpm test:polar:lifecycle`                      | Authorized sandbox checkout, webhook, access, cancellation, and expiry lifecycle               |
| `pnpm test:runtime`                              | TrueForge sandbox execution and approval transport                                             |
| `pnpm test:repair`                               | Isolated fault reproduction, generated repair, and unchanged evaluator                         |
| `pnpm exec tsx scripts/verify-local-workflow.ts` | Full synthetic local-replay workflow through TrueForge                                         |

`pnpm test:polar` does not create a checkout and does not prove the lifecycle. Missing or rejected credentials exit with a blocked result instead of a passing skip.

## Safety boundaries

- Authorized staging applications and isolated provider sandbox resources only.
- No live billing, automatic merge, production deployment, or paid provider fallback.
- Fixture data and local replay never count as provider evidence.
- Missing, stale, unsupported, or inconclusive observations never count as passing.
- Repair agents cannot read or edit the host evaluator.
- Provider audit records are reported honestly when the provider does not allow deletion.

The Codex bridge uses included ChatGPT subscription allowance only when it can verify sign-in, available quota, and a zero extra-credit balance. It blocks unknown or paid fallback states. See [the subscription boundary](docs/codex-subscription.md).

Known limits: this is a local, single-operator MVP; the repair sandbox is verified only on macOS; and portability beyond the bundled Next.js reference adapter has not been established.

## Development disclosure

Codex assisted with implementation, independent test authoring, review, and verification. Qodo reviewed the substantive GitHub changes. Human approval remains required for provider mutations and publication, and maintainers must be able to explain the code they merge.

## License

Original project code is available under the [MIT license](LICENSE). Dependencies retain their own licenses.
