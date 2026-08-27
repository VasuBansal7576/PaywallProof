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

[Implementation PR #1](https://github.com/VasuBansal7576/PaywallProof/pull/1) has received Qodo review. No substantive implementation PR has been merged yet.

The [Qodo review thread](https://github.com/VasuBansal7576/PaywallProof/pull/1#issuecomment-5441252429) identified runtime cancellation races, unsafe path collisions, and stale timestamps after cold browser startup. Follow-up changes address those findings and require another review before merge. Earlier missing-entrypoint, secret-permission and invoice-handling findings were resolved in the implementation.

Current executed checks and remaining acceptance gaps are recorded in [verification status](docs/verification-status.md). Unit test counts and installation probes do not establish a completed product run.

## Development disclosure

The owner uses Codex for implementation, independent test authoring, and verification. Human review and understanding remain required. Test and integration results will be recorded only after execution.
