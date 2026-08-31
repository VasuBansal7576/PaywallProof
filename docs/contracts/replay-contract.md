# Local replay adapter contract

`src/integrations/replay.ts` exports `LocalReplayAdapter`. This is synthetic billing replay, never Polar retrieval or verification.

Construct with trusted `{databasePath,priceId,adapterToken,replaySecret,transport,beforeMutation?}`. `transport` is a real `TargetTransport` from the network contract pointed at an explicitly authorized local target. `beforeMutation(runId)` runs immediately before each signed target request and may reject it. No payment-provider API or key is accepted.

`createCustomer(runId)` returns a stable synthetic `{customerId}`. Valid run IDs include UUIDs. The customer ID must satisfy the contract-v1 target adapter's `cus_` followed by letters, digits or underscores contract. Distinct run IDs, including IDs differing in punctuation, cannot share a customer. This method creates no target object; the trusted caller creates a user and links that customer using the configured target adapter.

`createSubscription(runId,operationId)` stores a synthetic active monthly subscription and delivers its signed creation event through the target's actual replay handler. `scheduleCancellation(runId,operationId)` delivers active/cancel-at-period-end state without removing access. `advanceClock(runId,operationId)` requires scheduling, advances past period end, and delivers canceled state. Returned receipts explicitly contain `mode:'local_replay'`.

`observe(runId)` returns normalized billing according to the public billing schema, with one customer's consistent identity across lifecycle steps. Missing subscriptions throw. State persists through `close()` and reopening the same database. `close()` releases SQLite resources.

Delivery uses raw-body signature verification with the configured replay secret and dedicated adapter authorization. Non-200 target responses throw; they never become successful delivery receipts. Stored synthetic state is not proof that the target accepted an event. Operation IDs belong to the trusted run controller, which prevents redispatch of unknown operations. This adapter alone does not enforce the run plan, approval, or ownership inventory.
