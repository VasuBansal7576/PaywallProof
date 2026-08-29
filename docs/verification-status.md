# Verification status

This file separates executed evidence from submission requirements. Historical raw outputs remain under ignored `.local/` state and are not committed.

## Executed locally

- A full local-replay lifecycle completed through TrueForge with all twelve scenario assertions passing and both run-owned users deleted.
- An isolated generated repair reproduced the injected SC03 failure, then passed the unchanged twelve-assertion evaluator and fourteen security controls.
- ProgramFlow completed the same four-state contract against a separate PostgreSQL application. Its compact receipt is retained under `docs/real-world/programflow/`.
- TypeScript, ESLint, unit/integration tests, the production web build, and browser checks passed before the current submission-hardening change. The final gate must rerun them against the final commit.
- Qodo reviewed PR #1 through commit `561867e`. Later commits, including the current TrueForge review feature, still require a fresh `/agentic_review` and follow-up review.

## Still required

- Native Polar sandbox checkout, signed webhook delivery, scheduled cancellation, actual expiry, and provider-owned cleanup need sandbox credentials plus an authorized test mailbox.
- The final Qodo review must cover the final implementation commit. Every finding needs a recorded disposition, and the representative PR must be merged.
- The tracked walkthrough video should move to a stable public release or object-storage URL before the binary is removed from Git.

## Truthfulness rules

- Local replay is never presented as provider delivery.
- Synthetic or implementation-aware tests are never presented as live integration evidence.
- An independent TrueForge evidence review is a bounded opinion over a saved report. It cannot upgrade the deterministic run outcome.
- Missing, skipped, unsupported, stale, or inconclusive evidence is not a pass.
