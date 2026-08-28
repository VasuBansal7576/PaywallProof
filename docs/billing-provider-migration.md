# Billing provider migration

Decision recorded August 28, 2026. The owner authorized replacing Stripe, while keeping the access scenarios, repair workflow, independent checks and no-charge requirement.

## Selected target and release gate

Polar's isolated sandbox is the selected replacement. The owner approved GitHub sign-in, the disclosed read permissions and completion of the project. The PaywallProof sandbox organization was created and its identity verified through the actual API. Separate worker and read-only reference tokens expire November 26, 2026. This does not establish a passing payment, webhook or lifecycle. Do not create a Paddle account or continue the Stripe invitation request in parallel.

Polar documents a separate sandbox server, credentials and data, and test payments that do not process real money. It supports shortening an active subscription's actual billing period before scheduling cancellation. Unlike a fabricated webhook, this can exercise the provider's own expiry transition. The exact timing and delivered events must still be observed against our account.

The migration cannot be declared complete until the same actual subscription passes paid access, scheduled-cancellation access and post-expiry denial, with real provider reads and signed webhooks. Free-user denial remains mandatory. Read-only preflight and synthetic contract tests do not satisfy this gate.

## Required contract changes

| Area | Required replacement behavior |
| --- | --- |
| Environment | Only `https://sandbox-api.polar.sh`, with `X-Polar-Sandbox: 1` and a pinned supported API version. No configurable production origin or redirect following. A token prefix alone cannot prove sandbox origin. |
| Identity | Bind an approved organization, product and one positive fixed monthly price. Confirm all three through authenticated provider reads. Reject wrong organizations, ad hoc prices, trials, metering and unsupported extra active prices. |
| First payment | Complete an actual sandbox checkout using an official test card. Confirm the initial paid order belongs to the exact customer, subscription and product. A free subscription, trial, checkout success page, locally assigned flag or later renewal cannot prove this. |
| Time | Replace test-clock advancement with a recorded provider billing-period update, readback and bounded wait for actual expiry. Never move the host clock, invent provider time, or revoke immediately to impersonate period-end cancellation. |
| Cancellation | `cancel_at_period_end: true` preserves access before the confirmed end. A cancellation-request event is not evidence that access should already be removed. Require the actual terminal state after the boundary. |
| Webhooks | Use Polar's Standard Webhooks verification over the exact body, timestamp and delivery ID. Deduplicate and reconcile with current provider reads. Keep replay credentials and routes separate. |
| Retry safety | Persist mutation intent and ownership before dispatch. An uncertain create is reconciled by reading provider state; it is never blindly dispatched a second time. Do not assume Stripe idempotency guarantees apply to another API. |
| Cleanup | Act only on resources recorded for this run and revalidated through provider reads. Record retained provider history honestly if deletion is unavailable. Never label archival or cancellation as deletion. |
| Evidence | Introduce explicit Polar provenance and a new configuration/policy version. Historical Stripe observations retain their original source and hashes; they cannot be relabeled, merged into a new run or silently replayed as Polar evidence. |
| Repair | Preserve the original frozen evidence and unchanged host oracle. Update provider-specific payloads and negative signature/ownership controls without allowing the repair agent to edit the verifier. |
| Availability | Keep local evidence for the configured 60 days. Do not promise a provider retention period that has not been verified. No paid plan, bank account, live card or credit redemption is permitted. |

## Test and verification obligations

Existing independent assertions remain in place during the transition. New tests written by the implementation author are labeled implementation-aware, not independent. Synthetic API responses are only contract fixtures, never real billing evidence. External providers are not stress-test targets; adversarial and load cases run locally.

Required negative cases include a production redirect, missing sandbox header, wrong API version, secret-bearing upstream errors, malformed and oversized responses, identity mismatches, unsupported products, repeated or uncertain mutations, stale/out-of-order/repeated webhooks, cross-run resources and terminal-state lag. Missing credentials must produce a nonzero blocked result, never a skipped passing credentialed suite.

The runtime, target, UI, public contracts, replay, repair runner, installation commands and acceptance verifier must migrate together before the old adapter is removed. A partially built Polar adapter must not be advertised as an available execution mode.

## Sources checked

- [Polar sandbox isolation and test payments](https://polar.sh/docs/integrate/sandbox)
- [Subscription period changes and cancellation semantics](https://polar.sh/docs/features/subscriptions/manage)
- [Webhook setup and sandbox use](https://polar.sh/docs/integrate/webhooks/endpoints)
- [API authentication and sandbox base URL](https://polar.sh/docs/api-reference/introduction)
- [Public subscription implementation](https://github.com/polarsource/polar/blob/main/server/polar/subscription/service.py)
- [Sandbox response header implementation](https://github.com/polarsource/polar/blob/main/server/polar/middlewares.py)

These are capability sources, not acceptance receipts. Source branches may change; an accepted provider run must record its API version and actual observations.

## Executed checkpoint

The migrated full local suite passes 1,584 tests. The actual TrueForge local-replay lifecycle passes all twelve assertions and retains four real browser screenshots. Both Polar tokens pass actual read-only preflight again. Real paid provider lifecycle and generated application repair remain separate, incomplete acceptance gates. See [verification status](verification-status.md).
