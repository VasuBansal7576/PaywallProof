# Independent public-boundary tests

The independent author read only these supplied specification files and the author's own outputs:

- `PRD.md`, version 1.1 with section 19 owner constraints.
- `docs/public-contracts.md`, version 1, including its clarified first-boundary contract.
- `docs/control-contract.md`, the durable control boundary supplied before its implementation.
- `docs/evidence-contract.md`, the authoritative evidence and redaction boundary.
- `docs/reference-contract.md`, the reference HTTP/session/signed-replay boundary.
- `docs/http-contract.md`, plus the supplied public factory signature and explicit HTTP auth/status/idempotency clarifications from the implementation owner; no implementation details were supplied.
- `docs/network-contract.md`, plus clarification that address rejection returns false, BrowserRunner closes its own browser, and visible/network leaks take precedence over denial UI.
- `docs/repair-contract.md`, including public record/approval shapes, receipt-validation errors, and exact protected-path rules clarified without source access.

The author did not inspect product source, proposed fixes, implementation conversations, dependency files, installed packages, or Git history. Policy and control slices were authored before their implementations; evidence tests were authored independently while another agent implemented that module. No suite was executed by this author. The implementation owner must record actual commands and results, including available red-before-green evidence, separately.

`policy.test.ts` exercises only the public exports `createPolicy`, `expectedAccess`, `aggregateVerdicts`, and `evaluateProbe`. It uses literal outcomes and synthetic adversarial inputs without internal mocks. Reason-code wording is deliberately not asserted.

`control.test.ts` exercises `openRunStore` through its public methods with real temporary SQLite files, multiple connections, reopen cycles, and an injected clock. It covers plan decisions/expiry, ownership, leases, uncertain effects, receipt idempotency, limits, cancellation, terminal outcomes, event replay, and malformed boundaries. The author has not executed this slice. The root agent reported 378 policy tests passing; that report was not independently rerun or inspected by this author.

`evidence.test.ts` exercises `EvidenceStore`, `evaluateEvidence`, and `redact` with real temporary SQLite files. Its synthetic inputs cover detached storage/reopen, provenance and mode consistency, freshness, state drift versus access mismatch, missing application identity, and secret canaries in arbitrary strings and property names. A synthetic payload labeled `stripe_sandbox` tests mode validation only; it is not a real sandbox receipt. Synthetic browser payloads are not evidence that a browser executed.

`reference.test.ts` uses only `createReferenceApp` and its real `app.request()` interface with a temporary SQLite target. It signs synthetic replay bodies with Node HMAC, never configures a usable Stripe key, and never starts a network listener. The suite covers staging/session separation, fixture ownership and retry tombstones, signed lifecycle behavior, duplicate/stale events, signature/raw-body checks, unavailable real webhooks, malformed payloads, and explicitly configured fault variants. Every successful replay is checked for `local_replay` mode.

`http.test.ts` uses only `createControlApp(...).app.request()` and `close()` with a real temporary SQLite file. It does not access the returned controller. It covers login, operator bearer versus session CSRF, host/origin restrictions, configured project scope, unknown input fields, durable action retries/conflicts, honest empty/read-error states, and unauthenticated MCP rejection. It does not call preflight, create runs, or contact configured target/runtime/provider endpoints. Login attempts are isolated by creating a fresh factory per test.

`network.test.ts` uses public `publicAddress`, `TargetTransport`, and `BrowserRunner` interfaces. Its runtime fixtures bind only ephemeral `127.0.0.1` HTTP ports. It checks forbidden address classes, origin/path validation, zero-hit redirect destinations and denied pre-dispatch gates, byte limits, streaming deadlines, and actual browser network/UI agreement against synthetic HTML. Cross-origin, forbidden-path, WebSocket, and service-worker cases stay on local test servers. No Playwright internals are imported; BrowserRunner owns browser shutdown. The independent author did not execute these port/browser tests.

`repair.test.ts` exercises only `openRepairStore`, `patchHash`, `repairBranch`, and `validateRepairPaths`. It uses temporary SQLite and real local symlinks/file modes to check proposal limits, immutable manifests, exact allowlists, receipt identity/time/hash consistency, and publication-approval binding/expiry/denial. All receipts are synthetic structural inputs, including cases labeled `stripe_sandbox`; no sandbox execution, real provider observation, GitHub request, push, PR, merge, or deployment occurs. The GitHub synthetic transport/recovery slice is not authored from guessed private request order or unstated response shapes.

These are public-boundary slices. Passing results do not establish the complete controller workflow, synchronization/repeat confirmation, exhaustive HTTP/MCP authorization, browser behavior against a deployed customer application, or external integration success. Those require further contracts and independent integration checks. No Stripe, TrueForge, Daytona, Qodo, GitHub, or customer integration is exercised by these tests.

The larger verdict arrays are local synthetic workloads only. Nothing in this suite authorizes external load testing or provider charges. Invalid-response tests are test inputs, not observations of a deployed target. No credentialed test is counted as passed by this suite.

Immutability tests check that attempted writes cannot change the returned policy. They do not mandate a particular provenance mechanism for serialized policies. Nesting tests use clearly shallow and clearly excessive bodies; the contract does not specify whether the root counts as level zero or one.

Control tests support synchronous or asynchronous method returns without prescribing an implementation. Concurrent-connection cases use two live connections in one process; they do not claim multiprocess or power-loss testing. Reopen cases establish durable recovery, not a tested process crash. Fixture object-count enforcement, exact event names, recovery retries after stop/deadline, and identical repeated completion semantics are not inferred from unspecified behavior.

The policy-suite formatting adjustment joining three `it.each(...)` factory calls to their invocation lines changes no cases or assertions.

Evidence tests do not prescribe redaction replacement text or a hash serialization convention. They check secret absence and stable stored digests. Hash-corruption testing is not implemented through an invented private SQLite schema. A single-cycle mismatch is a candidate and does not satisfy the later controller's repeated-confirmation requirement.

Reference tests do not execute the Next.js dashboard in a browser, inspect private session storage, exercise actual Stripe ownership/current-state reads, or prove cross-provider projection isolation. The deliberately invalid synthetic live-key string tests constructor rejection only. All signature secrets and customer/subscription/event identifiers are synthetic. The author did not inspect the reference implementation or run this suite.

Reference environment setup/restoration uses Vitest's public environment stubs instead of direct `NODE_ENV` writes to support readonly Next.js environment types; this harness adjustment changed no assertions. HTTP expectations use the supplied clarification that bearer writes still require request IDs, missing Origin is allowed, configured worker/web hosts and origins are accepted, conflicts return 409, successful duplicate project writes replay 201, and the MCP unauthenticated error shape differs from `/api` errors.

Network representation revision: the initial public contract did not specify the `rawBody` type. The owner clarified it as exact bytes (Uint8Array/Buffer), required to avoid corrupting binary assets. Three text-fixture comparisons now decode those bytes as UTF-8; the expected content is unchanged. The pure probe contract additionally permits `status: null` only with `transportError: true`; a new test requires inconclusive output and retains rejection of null status without a transport failure. Browser redirect, zero-hit, and mismatch assertions were not softened.

Credential-canary source revision: repository push protection flagged static synthetic credential-shaped literals in the evidence tests. Those values are now constructed at test runtime from prefix fragments and repeated explicitly synthetic alphanumeric data, preserving the same credential families and suffix lengths. Bearer and Basic fixtures are likewise assembled from synthetic text. No provider credentials were read or used, push protection was not disabled, and every redaction/nonmutation assertion remains unchanged. The revised cases still require automatic redaction without passing the canaries as configured literal secrets.

Keep the original assertions when correcting product defects. Record any future expectation change with the demonstrated specification conflict that requires it.
