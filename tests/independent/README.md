# Independent public-boundary tests

Agents first authored these tests from the PRD and public contract files. Their task instructions prohibited reading product source, proposed repairs, or implementation conversations. Shared filesystem access was not technical isolation, so the recorded inputs and author instructions enforced that boundary.

The tests use temporary local databases, loopback services where stated, and synthetic fixtures. Labels such as `local_replay`, `polar_sandbox`, provider-shaped payloads, customer IDs, and webhook bodies are test data. They are not provider calls, customer observations, live secrets, GitHub actions, or TrueForge and Qodo evidence.

After provider and contract changes, implementation-aware maintainers mechanically migrated schemas and terminology. Existing assertions stayed intact unless a documented specification conflict required a correction. New post-implementation regressions are labeled inline; they exercise public boundaries but are not presented as blind independent evidence. The 2026-08-30 probe-hash amendments describe the current contract. They did not retroactively author the original assertions.

Passing this directory establishes only the documented public-boundary behavior. [Verification status](../../docs/verification.md) records executed browser, TrueForge, Polar, repair, and second-target evidence and lists the remaining gates.
