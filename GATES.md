# Gates: Remaining PaywallProof acceptance

Scope: Complete and document the remaining real workflow, repair, provider and review checks without paid services or fabricated evidence.

Prerequisites: Node.js, pnpm, Git, authenticated GitHub CLI and the existing local services. Model checks use only the guarded Codex subscription bridge.

- [ ] G1: A generated repair reproduces the fault, fixes it and passes the same frozen evaluator and security controls.
  CHECK: pnpm test:repair
  EXPECT: /"status":"passed"/
  EVIDENCE: pending

- [x] G2: The current Luna runtime completes all four scenarios through the full local controller workflow and cleans up its fixtures.
  CHECK: pnpm exec tsx scripts/verify-local-workflow.ts
  EXPECT: /"status":"passed"/
  EVIDENCE: pnpm exec tsx scripts/verify-local-workflow.ts exited 0 and emitted status passed for run 99c255aa-7a0d-47e3-898e-65c1d966ee3c; all four scenarios passed API/browser/state. Actual report .local/workflow-99c255aa-7a0d-47e3-898e-65c1d966ee3c/report.json; prior report preserved in the same directory. Local replay only, not Polar acceptance.

- [ ] G3: Polar sandbox checkout, native signed webhook, scheduled cancellation, actual expiry and run-owned cleanup have real provider receipts.
  EVIDENCE: pending; provider acceptance requires authorized test mailbox and sandbox-only credentials, never a real payment.

- [x] G4: Publication controls bind the verified proposal and reject stale or unauthorized approvals without merging or deploying.
  EVIDENCE: pnpm exec vitest run tests/independent/repair.test.ts --reporter=json --outputFile=.local/publication-independent-final.json exited 0; 189 independent tests passed, zero failures/skips. Covers exact diff/destination binding, stale approvals, expiry, restart and no provider writes. This is control verification, not a claim that a generated repair was published.

- [ ] G5: The final regression suite, typecheck, lint, production build and browser checks pass for the final source revision.
  EVIDENCE: pending; record exact commands, source revision and receipts separately.

- [ ] G6: Final Qodo feedback is checked and the spec and submission evidence accurately distinguish passed checks from unresolved requirements.
  EVIDENCE: pending; inspect the completed review for the final published commit and reconcile each finding with source or reproduced behavior.

- [ ] G7: Submission materials include the required approximately three-minute recording, reproducible instructions and Qodo evidence without exposing private data or claiming unfinished provider acceptance.
  EVIDENCE: pending; the recording depends on the remaining real workflow evidence. Existing README and PR review are available.
