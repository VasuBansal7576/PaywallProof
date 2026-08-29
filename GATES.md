# Gates: Submission hardening

Scope: Make PaywallProof submission-ready by fixing the TrueForge turn-selection bug, adding a genuine skill-backed dynamic-subagent review stage, simplifying the repository, and establishing repeatable CI and Qodo evidence.

Prerequisites: Node.js, pnpm, Git, the local TrueForge stack for live-runtime checks, and an authenticated Qodo/GitHub connection for the final review.

- [x] G1: TrueForge continuation and approval resume the newest turn even when `listTurns` spans multiple pages.
      CHECK: pnpm test:turn-selection
      EXPECT: /turn-selection contract passed/
      EVIDENCE: Passed locally on 2026-08-29 for ascending and descending multi-page iterators; the live runtime then created a sandbox, executed 42, resumed its stream, and rejected a stale approval.

- [x] G2: A completed run can enter an independent evidence-review stage whose coordinator is skill-backed, enables TrueForge dynamic subagents, exposes only review-scoped MCP tools, and persists the resulting verdict in the run report.
      CHECK: pnpm test:evidence-review
      EXPECT: /evidence-review contract passed/
      EVIDENCE: Passed locally on 2026-08-29; the contract covers Git skill registration, dynamic subagents, exact tool scope, grounded persistence, and single-watcher recovery. The final live retry retained separate binding and coverage reviewers against report hash `4bb30645ee18c30dab3643369fae8e5a4fd2e546e9c443a2fa1ab2fe99255958`. Binding was confirmed; the combined `needs_attention` verdict records only the intentional single-build, single-price, non-production scope.

- [x] G3: The repository has one legible source tree, no bundled third-party source trees, no obsolete model paths, no raw machine-specific output, and a validated reusable review skill. Two narrow runtime compatibility patches remain tracked and documented.
      CHECK: pnpm check:repository
      EXPECT: /repository shape passed/
      EVIDENCE: Passed locally on 2026-08-29; the repository checker and review-skill validator also passed inside `pnpm verify:ci`.

- [x] G4: Pull requests run formatting, type, lint, test, build, repository-shape, and skill-validation checks; Qodo review instructions require `/agentic_review`, disposition of every finding, and a follow-up review.
      CHECK: pnpm check:delivery
      EXPECT: /delivery configuration passed/
      EVIDENCE: Passed locally and in GitHub Actions on 2026-08-29, including the production web build.

- [x] G5: The final implementation passes the complete local verification pipeline, including the production web build and browser contract.
      CHECK: pnpm verify
      EXPECT: /PaywallProof verification passed/
      EVIDENCE: Passed locally on 2026-08-29 with the production Next.js build and all ten live browser-contract groups.

- [x] G6: Qodo reviewed the representative lifecycle implementation, every valid finding was fixed, the follow-up review was clean, and the PR was merged.
      EVIDENCE: PR #2 fixed all three Qodo findings and merged as `32664e0`. PR #3 then received a zero-finding review and merged as `deba7bf`. Each later substantive pull request creates its own review record; this historical gate does not claim to review future heads.

## Submission-only follow-ups

These are real external acceptance items, not claims made by the local implementation:

- Submit the public repository and committed walkthrough through the hackathon portal.
- Keep the walkthrough tracked until the submitted link points to another stable public location.
