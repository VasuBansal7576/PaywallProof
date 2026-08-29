# Verification status

This file separates executed evidence from submission requirements. Historical raw outputs remain under ignored `.local/` state and are not committed.

## Executed locally

- A full local-replay lifecycle completed through TrueForge with all twelve scenario assertions passing and both run-owned users deleted.
- An isolated generated repair reproduced the injected SC03 failure, then passed the unchanged twelve-assertion evaluator and fourteen security controls.
- ProgramFlow completed the same four-state contract against a separate PostgreSQL application. Its compact receipt is retained under `docs/real-world/programflow/`.
- The submission-hardening gate passes formatting, repository shape, delivery configuration, skill validation, TypeScript, ESLint, 1,811 tests, the production web build, and all ten live browser-contract groups.
- The live TrueForge runtime created a sandbox, executed Python with output `42`, resumed the same stream, exercised allow/deny approval transport, and rejected replay of a stale approval. Turn selection is covered for both ascending and descending multi-page iterators.
- A live evidence-review retry mounted the Git-backed skill through the restricted local TrueForge sandbox and later completed with separate coverage and binding reviewer roles. The receipt is bound to report hash `f25e665bf33fc1d1da47673221d66484952fac0be2069fbef1ff22df1cfbdb97` and retains its conservative `needs_attention` verdict; earlier failed attempts remain archived with revoked MCP credentials.
- Qodo reviewed PR #1 through commit `561867e`. Later commits, including the current TrueForge review feature, still require a fresh `/agentic_review` and follow-up review.

## Still required

- Native Polar sandbox checkout, signed webhook delivery, scheduled cancellation, actual expiry, and provider-owned cleanup need sandbox credentials plus an authorized test mailbox.
- The final Qodo review must cover the final implementation commit. Every finding needs a recorded disposition, and the representative PR must be merged.
- The tracked walkthrough video should move to a stable public release or object-storage URL before the binary is removed from Git.

## Truthfulness rules

- Local replay is never presented as provider delivery.
- Synthetic or implementation-aware tests are never presented as live integration evidence.
- An independent TrueForge evidence review is a bounded opinion over a saved report. It cannot upgrade the deterministic run outcome.
- Review subagents receive an allowlisted data-only projection. Arbitrary report text and payloads are omitted or replaced by digests before they cross the model boundary.
- Missing, skipped, unsupported, stale, or inconclusive evidence is not a pass.
