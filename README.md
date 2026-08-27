# PaywallProof

Check whether subscription state and access to a paid feature agree. Reproduce failures, collect evidence, and prepare a tested repair for approval.

Implementation is in progress. No completed scan, repair, or provider integration is claimed yet. The full requirements are in [PRD.md](PRD.md).

## Boundaries

- Authorized staging applications and Stripe sandbox resources only.
- No live billing, automatic merge, or production deployment.
- Zero external spending. Integrations stay blocked until their no-charge operation is verified.
- Test fixtures and local replay never count as real provider evidence.
- Independent tests are authored from requirements and public contracts without implementation access.

## Qodo Code Review Evidence

Pending. No substantive implementation PR has been merged. This section will link actual reviewed PRs, findings, decisions, and the final reviewed commits.

## Development disclosure

The owner uses Codex for implementation, independent test authoring, and verification. Human review and understanding remain required. Test and integration results will be recorded only after execution.
