# Gates: Submission hardening

Scope: Make PaywallProof submission-ready by fixing the TrueForge turn-selection bug, adding a genuine skill-backed dynamic-subagent review stage, simplifying the repository, and establishing repeatable CI and Qodo evidence.

Prerequisites: Node.js, pnpm, Git, the local TrueForge stack for live-runtime checks, and an authenticated Qodo/GitHub connection for the final review.

- [x] G1: TrueForge continuation and approval resume the newest turn even when `listTurns` spans multiple pages.
      CHECK: pnpm test:turn-selection
      EXPECT: /turn-selection contract passed/
      EVIDENCE: Passed locally on 2026-08-29; the focused implementation suite exercises multi-page continuation, approval, and repair-sandbox recovery.

- [x] G2: A completed run can enter an independent evidence-review stage whose coordinator is skill-backed, enables TrueForge dynamic subagents, exposes only review-scoped MCP tools, and persists the resulting verdict in the run report.
      CHECK: pnpm test:evidence-review
      EXPECT: /evidence-review contract passed/
      EVIDENCE: Passed locally on 2026-08-29; the contract covers Git skill registration, dynamic subagents, exact tool scope, grounded persistence, and single-watcher recovery.

- [x] G3: The repository has one legible source tree, no bundled third-party source/patch dumps, no obsolete model paths, no raw machine-specific output, and a validated reusable review skill.
      CHECK: pnpm check:repository
      EXPECT: /repository shape passed/
      EVIDENCE: Passed locally on 2026-08-29; the repository checker and review-skill validator also passed inside `pnpm verify:ci`.

- [x] G4: Pull requests run formatting, type, lint, test, build, repository-shape, and skill-validation checks; Qodo review instructions require `/agentic_review`, disposition of every finding, and a follow-up review.
      CHECK: pnpm check:delivery
      EXPECT: /delivery configuration passed/
      EVIDENCE: Passed locally on 2026-08-29; `pnpm verify:ci` also passed 1,805 tests and the production web build.

- [ ] G5: The final implementation passes the complete local verification pipeline, including the production web build and browser contract.
      CHECK: pnpm verify
      EXPECT: /PaywallProof verification passed/
      EVIDENCE: pending

- [ ] G6: Qodo has reviewed the final implementation commit, every valid finding has been fixed, deferred or invalid findings have an explanation, the follow-up review is clean, and the representative PR is merged.
      EVIDENCE: pending; this is complete only after the remote Qodo/GitHub workflow finishes.

## Submission-only follow-ups

These are real external acceptance items, not claims made by the local implementation:

- Polar sandbox checkout, native signed webhook, scheduled cancellation, actual expiry, and run-owned cleanup still require sandbox credentials plus an authorized test mailbox.
- The walkthrough video remains tracked until a stable public release or object-storage URL replaces it.
