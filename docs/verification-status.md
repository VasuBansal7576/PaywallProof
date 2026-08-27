# Verification status

This is a record of observed progress, not an acceptance certificate.

## Current state

- Source workspace initially contained only PRD.md.
- GitHub CLI account access verified. Public repository created with a documentation-only main branch. Work is on feat/paywallproof-foundation; no implementation merge has occurred.
- Local Node 22.20.0, pnpm 10.32.0, Docker 29.1.3, and an installed Ollama qwen3:4b model observed.
- A Stripe credit offer was located in the owner's email. Redemption and remaining balance are unverified. Private details are not stored in this repository.
- Stripe sandbox transactions do not move funds. No Stripe API call has run.
- Qodo installed on PaywallProof only after owner confirmation. Billing page shows a free trial and no active subscription. PR #1 received a completed Qodo review of the foundation commit. It correctly flagged development commands whose implementation files had not yet landed. Working entrypoints are now being added; review of the final implementation is pending. No merge has occurred.
- TrueForge 0.1.4 and SDK 0.1.3 installed locally with a lockfile. Server listens on 127.0.0.1:8790 with an isolated local database. Its startup probe reports local sandbox availability.
- A real local Ollama turn requested the sandbox exec tool. Tool execution failed during Python venv initialization. This is failed installation evidence, not a passing runtime integration.
- A pinned pnpm patch adds a narrow explicit bundled-Python override while preserving the local sandbox. A fresh TrueForge session executed `print(6 * 7)` inside its sandbox and returned an actual successful exec receipt containing 42. Deliberate SSE disconnection reattached to the same turn. A separate harmless MCP installation probe verified allow executes once, deny executes zero times, and stale approvals are rejected. This is installation evidence, not a full product run.
- Existing local Ollama qwen3:4b was retained. A second local alias adjusts its stale thinking template without downloading another model. It also passed actual sandbox execution. No hosted model or Daytona service is configured.
- Independent authors read only the PRD and public contracts, not implementation. Policy tests were run before their module existed, then passed unchanged. Control tests likewise failed for the missing module before implementation.
- Policy 378, durable control 129, evidence 116, reference HTTP 50, and control HTTP 59 independent tests pass. Eleven additional reference integration tests pass. Total at this checkpoint: 743 tests, plus successful TypeScript and ESLint checks.
- Independent evidence tests exposed missing application-identity enforcement and incorrect free-state normalization. Independent HTTP tests exposed unchecked Host headers and validation response inconsistencies. Product code was fixed without weakening assertions.
- Reference Next.js production build and actual Playwright free/paid/canceled local-replay browser checks passed. Product UI production build passed. Full controller/TrueForge lifecycle and independent network/browser stress suite are in progress.
- No real Stripe API call or lifecycle has run. New India-based accounts are invite-only; the available Algora-connected account is outside this product's permitted Stripe account model. No country restrictions were bypassed and no payment details entered.

## Required evidence

Each implementation increment records its tests, results, blocked checks, and Qodo review. Never count a skipped credentialed suite as passed. The acceptance catalogue in PRD.md remains mandatory.
