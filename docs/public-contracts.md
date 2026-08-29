# Public contracts for independent verification

Version 2. These contracts are written before product implementation. They define externally observable behavior, not implementation algorithms. The PRD remains authoritative. Test authors must not inspect product source or proposed fixes.

## First boundary: policy and result evaluation

The public module is `src/domain/index.ts`. It exports these functions:

### createPolicy(input)

Input fields: `schemaVersion: 2`, `priceId: string`, `featureId: string`, `featureConfigHash: lowercase SHA-256 digest`, `cancellation: 'allow_until_period_end'`, `requireInitialPaymentConfirmed: true`, `syncWindowSeconds: integer from 5 through 300`, `predicateVersion: string`.

Identifiers and predicate versions must be nonempty strings with no leading or trailing whitespace; reject rather than silently normalize them. Unknown fields and wrong types are rejected. Caller-supplied policy hashes are rejected. Output contains those fields and a lowercase 64-character SHA-256 `hash`. Equivalent input object key order produces the same hash; a change in any policy field changes it. The returned object is immutable. Invalid input throws a validation error. The feature configuration digest binds routes, predicates, denial statuses, and browser steps; the later controller verifies that digest before a probe.

### expectedAccess({ policy, billing })

`policy` is a policy produced by createPolicy.

`billing` contains:

- `livemode: boolean`, `identityResolved: boolean`, `noSubscriptionConfirmed: boolean`.
- `customerId: string | null`.
- `subscription: null` or `{ id: string, customerId: string, priceId: string, status: string, initialPaymentConfirmed: boolean, cancelAtPeriodEnd: boolean, periodEnd: integer, billingTime: integer }`.

Output is `{ kind: 'allow' }`, `{ kind: 'deny' }`, or `{ kind: 'unknown', code: string }`.

Known free users with an independently confirmed absence of subscriptions are denied, including when customerId is null. A confirmed active subscription for the configured price with a paid initial invoice is allowed. Scheduled cancellation before period end preserves access. Confirmed canceled subscriptions are denied even when the initial invoice is unpaid. An active subscription whose scheduled boundary has been reached but whose cancellation is not confirmed is unknown. Live mode, unresolved identity, contradictory absence/subscription records, customer mismatch, and price mismatch take precedence over subscription status and produce unknown. Unsupported statuses and unresolved facts are unknown. Unknown never means deny or allow. Invalid structural input throws a validation error. All objects reject unknown fields. Non-null identifiers must be nonempty, unpadded strings. Time fields must be nonnegative safe integers, not NaN, infinity, fractions, or unsafe integers.

### aggregateVerdicts(verdicts)

Input is an array of `pass | fail | inconclusive | unsupported | skipped`.

Output is `failed` if any assertion failed, otherwise `passed` only for a nonempty array of passes, otherwise `inconclusive`. An empty array cannot prove a successful run. Invalid verdict values and nonarray inputs throw validation errors.

### evaluateProbe({ expected, probe, fixtureMarker })

`expected` is an expectedAccess result. `probe` is `{ status: integer from 100 through 599, body: JSON value, transportError: boolean, denialStatuses: number[] }`. Denial statuses are a nonempty unique list of integer HTTP 4xx statuses. All objects except the arbitrary JSON body reject unknown fields. `fixtureMarker` is a nonempty, unpadded string. The body may be a JSON scalar, array, or plain record. Cycles, functions, undefined, nonfinite numbers, class instances, accessors, and symbol properties are invalid; maximum nesting is 32 levels. Invalid structural input throws a validation error.

An allowed response must be HTTP 200 with an object body whose `fixtureMarker` property exactly equals the expected marker. A denial must use an approved denial status, an object body with `error: 'ACCESS_DENIED'`, and must not contain protected data. Detect the marker as a substring of decoded string values or property names at any nesting level, including strings with escaped characters. When expected access is deny, any such marker is a failure regardless of HTTP status or denial wording. An allow when denial is expected or a denial when allowance is expected is `fail`. Matching trustworthy behavior is `pass`. Unknown expectations and transport errors take precedence and produce `inconclusive`. Other unexpected responses and missing markers are `inconclusive`. Output is `{ verdict, code }`. Tests must assert behavior, not require particular wording of reason codes.

These are low-level pure primitives. A primitive pass is not an authoritative scenario result. The later evidence boundary must enforce observation IDs, provenance, ownership, freshness, target identity, immutable feature configuration, synchronization deadlines, and repeated confirmation before recording assertions. The model never supplies replacement evidence to that boundary.

Transport-failure addition: when `transportError` is true, `status` may be null to represent the absence of any HTTP response. Do not manufacture an HTTP status for a blocked connection. A null status remains invalid when `transportError` is false. All transport failures remain inconclusive.

## Further boundaries

HTTP, MCP, persistence, approval, and browser contracts will be added before their independent test slices. Existing routes and required behaviors are specified in PRD sections 8 through 14. No seam-specific tests may depend on internal collaborators. There is no implementation source in this contract package.
