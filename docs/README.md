# Documentation

The root [README](../README.md) explains the product and local setup. The [product specification](../PRD.md) is the complete requirements record.

## Current records

- [Verification](verification.md) separates executed evidence from acceptance gates that remain open.
- [Implementation decisions](decisions.md) records decisions that changed the runtime or its trust boundary.
- [Billing provider migration](billing-provider-migration.md) explains the completed move from Stripe to Polar.
- [Codex subscription boundary](codex-subscription.md) documents model access, spending controls, and privacy limits.
- [Repair sandbox](repair-sandbox.md) describes the isolation boundary for generated repairs.

## Contract archive

The files in [`contracts/`](contracts/) are retained because the independent test suite cites them as the specifications it received before implementation. They are audit inputs, not extra setup guides.

[`public-contracts.md`](public-contracts.md) contains the shared public types and rules used across those contracts.

The [target adapter contract](contracts/reference-contract.md) defines contract v1 and Adapter Doctor. A compatible Doctor report is read-only preflight evidence, not a completed lifecycle run.

## Historical material

Submission checklists, sponsor research, and the obsolete bundled walkthrough are intentionally excluded from Git. The submitted demo is available from the root README. The compact native Polar receipt remains in ignored local storage for the required 60-day retention window.
