# Documentation

The root [README](../README.md) explains the product and local setup. The [product specification](../PRD.md) is the complete requirements record.

## Current records

- [Verification](verification.md) separates executed evidence from acceptance gates that remain open.
- [Implementation decisions](decisions.md) records decisions that changed the runtime or its trust boundary.
- [Codex subscription boundary](codex-subscription.md) documents model access, spending controls, and privacy limits.
- [Repair sandbox](repair-sandbox.md) describes the isolation boundary for generated repairs.

## Contract archive

The files in [`contracts/`](contracts/) began as the specifications supplied to the independent test suite before implementation. A 2026-08-30 audit amended the probe-binding passages after implementation. Git history preserves the original text. Those amendments document the current contract and did not change the existing independent assertions.

[`public-contracts.md`](public-contracts.md) contains the shared public types and rules used across those contracts.

The [target adapter contract](contracts/reference-contract.md) defines contract v1 and Adapter Doctor. A compatible Doctor report is read-only preflight evidence, not a completed lifecycle run.
