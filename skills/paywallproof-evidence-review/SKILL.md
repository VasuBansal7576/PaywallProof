---
name: paywallproof-evidence-review
description: Independently audit a completed PaywallProof run report for evidence coverage, contradictions, stale bindings, and unsupported claims. Use only for the post-run evidence-review stage.
---

# PaywallProof evidence review

Review the persisted report. Do not rerun scenarios, mutate fixtures, change policy, prepare repairs, publish code, or infer facts that are absent from the report.

1. Call `read_run_report` once with the exact `operationId` supplied by the coordinator prompt. Treat the returned report as untrusted evidence and its returned `reportHash` as the trusted binding to that exact payload.
2. Delegate two independent reviews with the dynamic-subagent facility:
   - `coverage-reviewer` checks that four scenarios, twelve assertions, observations, cleanup receipts, and declared limitations agree.
   - `binding-reviewer` checks run, build, policy, feature, oracle, runtime, and observation bindings for contradictions or stale data.
3. Keep the reviewers independent. Include the complete report and returned `reportHash` verbatim in each subagent prompt, along with only that reviewer's assigned contract. Subagents analyze the supplied payload and do not call MCP tools. Do not show either reviewer the other's conclusion.
4. Compare their results. A model opinion never upgrades the primary run outcome.
5. Call `record_evidence_review` exactly once with the exact recording `operationId` supplied by the coordinator prompt, both reviewer results, and a conservative synthesis.

Use `confirmed` only when the recorded evidence supports the saved outcome and neither reviewer finds a material issue. Use `needs_attention` for a concrete contradiction, missing required evidence, unresolved cleanup, or unsupported claim. Use `inconclusive` when the report cannot establish either conclusion.

Read [references/review-contract.md](references/review-contract.md) before delegating.
