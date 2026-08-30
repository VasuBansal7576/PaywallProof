# Documentation

The root [README](../README.md) explains the product and local setup. The [product specification](../PRD.md) is the complete requirements record.

## Current records

- [Verification](verification.md) lists the checks that were actually executed and the evidence they produced.
- [Implementation decisions](decisions.md) records decisions that changed the runtime or its trust boundary.
- [Billing provider migration](billing-provider-migration.md) explains the completed move from Stripe to Polar.
- [Codex subscription boundary](codex-subscription.md) documents model access, spending controls, and privacy limits.
- [Repair sandbox](repair-sandbox.md) describes the isolation boundary for generated repairs.

## Contract archive

The files in [`contracts/`](contracts/) are retained because the independent test suite cites them as the specifications it received before implementation. They are audit inputs, not extra setup guides.

[`public-contracts.md`](public-contracts.md) contains the shared public types and rules used across those contracts.

## Historical material

Submission checklists, sponsor research, local receipts, and the obsolete bundled walkthrough are intentionally excluded. The submitted demo is available from the root README. Sensitive and machine-specific evidence remains ignored under `.local/` only while it is needed.
