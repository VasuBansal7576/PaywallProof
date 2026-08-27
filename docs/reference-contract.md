# Reference target HTTP contract

`createReferenceApp(options)` is exported from `packages/reference/src/index.ts` and returns `{ app, close }`. `app` is a real Hono app with `.request()` and `.fetch()` methods. `close()` closes the target's SQLite connection. The target imports no controller or evaluator code.

Options are `databasePath`, `stagingEnabled`, `adapterToken`, `webhookSecret`, `replaySecret`, `priceId`, `buildId`, optional `stripeKey`, and optional `faultMode`. Fault modes are `none`, `missing_guard`, `missing_activation`, and `missing_cancellation`. Secrets must be nonempty and the webhook and replay secrets must differ. Stripe keys, when supplied, must begin with `sk_test_` or `rk_test_`. Fault modes require staging to be enabled and `NODE_ENV` to differ from `production`; they have no HTTP setter.

All JSON responses have `Cache-Control: no-store`. Errors return `{ "error": "CODE" }` and no fixture data, SQL, credentials, or provider response body. Malformed JSON or invalid schema returns 400. Request bodies are limited to 256 KiB. Identifiers are nonempty, unpadded strings of at most 255 characters. All staging requests require `Authorization: Bearer <adapterToken>`. Staging returns 404 when `stagingEnabled !== true` or `NODE_ENV === "production"`, even with a valid token. Missing or wrong staging credentials return 401.

## Staging adapter

`GET /staging/describe` returns 200:

```json
{
  "adapterVersion": "1",
  "environment": "test",
  "buildId": "configured-build-id",
  "billingTimeModel": "provider_status",
  "feature": {
    "id": "pro_export",
    "method": "GET",
    "path": "/api/export",
    "denialStatuses": [403],
    "browserPath": "/dashboard",
    "actionTestId": "export-button",
    "resultTestId": "export-result"
  }
}
```

`POST /staging/users` takes `{ "runId": "run-1", "operationId": "create-user-1", "fixtureMarker": "marker-1" }` and returns 201 with `{ "principalId": "usr_<opaque UUID>", "runId": "run-1", "fixtureMarker": "marker-1" }`. Fixture markers are nonempty and at most 2048 characters. Unknown request fields are rejected. Repeating the operation with the same arguments returns the same receipt, including after restarting the process with the same database. Conflicting arguments return 409 `OPERATION_CONFLICT`. A removed fixture cannot be recreated by replaying its old operation; this returns 410 `FIXTURE_ALREADY_REMOVED`.

`POST /staging/users/:id/customer` takes `{ "runId": "run-1", "customerId": "cus_example" }` and returns 200 with `{ "principalId": "...", "runId": "run-1", "customerId": "cus_example" }`. Customer IDs begin with `cus_` and otherwise contain ASCII letters, digits, or underscores. This operation only links identity; it never changes entitlement. A principal may have only one customer, and a customer may have only one principal. Repeating the same link is harmless. Conflicts return 409. When a Stripe key is configured, a read of the customer must confirm `livemode: false` and `metadata.runId` matching the requested run. Without a key, this establishes only a local fixture mapping and makes no provider ownership claim.

`POST /staging/users/:id/session` takes `{ "runId": "run-1" }` and returns 200 with `{ "cookie": "pp_session=<opaque-token>", "expiresAt": "<ISO real-time timestamp>" }`. The cookie string is a request `Cookie` header value, with no attributes. The trusted browser runner sets that cookie on the configured target origin using HttpOnly and SameSite=Lax. Sessions expire after 15 real minutes, independent of any billing clock. SQLite stores only token hashes. Sessions have no staging privilege.

`GET /staging/users/:id/billing?runId=run-1` returns 200:

```json
{
  "principalId": "usr_example",
  "runId": "run-1",
  "customerId": null,
  "status": "none",
  "subscriptionId": null,
  "priceId": null,
  "initialInvoicePaid": false,
  "cancelAtPeriodEnd": false,
  "periodEnd": null,
  "buildId": "configured-build-id"
}
```

This read never synchronizes billing. With a subscription, IDs are strings, `status` is the stored provider status, and `periodEnd` is Unix seconds from the singleton subscription item's `current_period_end`. A free user has status `none`.

`DELETE /staging/users/:id?runId=run-1` returns 200 with `{ "removed": true, "principalId": "...", "runId": "run-1" }`. It deletes the user's fixture and sessions, retains operation and event receipts for safe retries, and never deletes Stripe resources. Repeating a deletion is harmless. All user-scoped staging operations return 403 `RUN_OWNERSHIP_MISMATCH` for another run's principal and 404 `USER_NOT_FOUND` for an unknown principal.

## Ordinary feature routes

`GET /api/export` accepts only the ordinary session cookie. No session gives 401 `{ "error": "AUTHENTICATION_REQUIRED" }`. A free or canceled user gives 403 `{ "error": "ACCESS_DENIED" }`. An authorized user gives 200 `{ "fixtureMarker": "<this user's private marker>" }`. Authorization requires an active subscription, the configured price, and a confirmed paid initial invoice. Scheduled cancellation does not revoke access while provider status remains active. Host time does not decide billing access. `Authorization: Bearer <adapterToken>` alone never authorizes this route, even in a fault variant.

`GET /api/me` accepts only the ordinary session cookie. It returns 401 without a session or 200 with `{ "principalId": "...", "plan": "Free" | "Pro", "canExport": boolean, "subscriptionStatus": string, "cancelAtPeriodEnd": boolean, "periodEnd": number | null, "executionMode": "none" | "local_replay" | "stripe_sandbox" }`. It contains neither fixture data nor credentials. The Next.js `/dashboard` renders these values and performs a real `/api/export` request when `export-button` is clicked. `export-result` has a `data-status` of `idle`, `loading`, `allowed`, `denied`, or `unavailable` and contains the actual marker only after a successful export response.

## Real Stripe webhook

`POST /api/stripe/webhook` verifies `Stripe-Signature` over the exact raw body with `webhookSecret` and Stripe's default timestamp tolerance. Missing or invalid signatures give 400 `INVALID_WEBHOOK_SIGNATURE`. A signature made with `replaySecret` fails here. Live events fail validation. If no Stripe key is configured, a correctly signed event returns 503 `{ "error": "STRIPE_WEBHOOK_UNAVAILABLE", "processed": false }` without updating state.

Supported events are `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_succeeded`, and `invoice.payment_failed`. Invoice events use `parent.subscription_details.subscription`; the sanitized replay parser also understands `subscription` for older fixtures. Unsupported event types return 200 with `received: true`, `processed: false`, `ignored: true`, and `mode: "stripe_sandbox"`.

Before applying a supported event the handler requires a linked customer, retrieves its current customer and subscription from Stripe, confirms run ownership, checks every relevant resource's test mode, verifies exactly one subscription and one item with the configured price, and retrieves the creation invoice to establish its paid status. The API version is pinned to `2026-08-26.dahlia`, matching the installed Stripe SDK. No provider mutations exist in this package. Unresolved invoice or subscription shapes fail closed.

Successful responses have `{ "received": true, "processed": boolean, "duplicate": boolean, "stale": boolean, "mode": "stripe_sandbox" }`. Event IDs and raw-payload hashes are recorded transactionally with projection updates. Exact duplicates return `duplicate: true` without another provider read. Reuse of an event ID for different bytes or a different mode gives 409 `EVENT_ID_CONFLICT`. Customer processing is serialized within a process. Different event timestamps never substitute for current provider state on this route.

## Local replay

`POST /staging/replay` requires both the staging bearer token and `Stripe-Signature` made with `replaySecret`. It performs no network request. The body is a sanitized, synthetic Stripe-compatible subscription event, not an arbitrary entitlement update:

```json
{
  "id": "evt_local_1",
  "type": "customer.subscription.created",
  "livemode": false,
  "created": 1800000000,
  "data": {
    "object": {
      "id": "sub_local_1",
      "object": "subscription",
      "livemode": false,
      "customer": "cus_local_1",
      "metadata": { "runId": "run-1" },
      "status": "active",
      "cancel_at_period_end": false,
      "items": {
        "data": [{ "price": { "id": "price_configured", "livemode": false }, "current_period_end": 1802678400 }],
        "has_more": false
      },
      "latest_invoice": {
        "id": "in_local_1",
        "livemode": false,
        "status": "paid",
        "billing_reason": "subscription_create",
        "customer": "cus_local_1",
        "parent": { "subscription_details": { "subscription": "sub_local_1" } }
      }
    }
  }
}
```

Use the current real Unix timestamp in the signature, even when the event's `created` value represents simulated billing time. `Stripe.webhooks.generateTestHeaderString({ payload: rawBody, secret: replaySecret })` produces an appropriate test signature. The `created` timestamp orders replay events; older events are recorded but return `stale: true` without overwriting newer billing state. Cancellation scheduling uses a fresh updated event with `cancel_at_period_end: true` and status `active`. Actual cancellation uses a fresh deleted event with status `canceled`.

Replay accepts exactly one configured item and requires matching subscription `metadata.runId`. Invoice `customer` and subscription linkage are checked when supplied. Invoice `livemode: false` and `status` are required; `id`, `object`, `billing_reason`, and identity fields are optional for minimal sanitized fixtures. Only a paid creation invoice establishes initial payment, and that fact survives later lifecycle events for the same subscription. A user cannot mix replay and real Stripe billing projections. Every replay response and the ordinary UI are labeled `local_replay`; these results are never real Stripe verification.

`latest_invoice` may be omitted or null. Such events are accepted for the supported subscription binding, but cannot establish initial payment. For the same subscription, retain an already established payment fact; for the first subscription of an unbound fixture, start unpaid unless a supplied valid paid creation invoice establishes payment. A different subscription ID cannot replace an existing fixture binding: reject that unsupported event and preserve the original projection, regardless of whether the replacement supplies a paid invoice. This follows PRD sections 2.3, 6.1, and 12.2: multiple subscriptions per user are outside scope, a run uses one subscription lifecycle, and reruns require fresh fixtures. A supplied non-null invoice must satisfy the invoice schema, and supplied customer or subscription linkage must match the event's owned subscription. There is no independently bound invoice-ID ledger in local replay; a differing `invoice.id` alone is not evidence of foreign ownership. Real Stripe mode obtains invoice identity from provider reads.

## Next.js environment

Run `next dev apps/demo-saas --hostname 127.0.0.1 --port 3001`. Server-only settings are `REFERENCE_DATABASE_PATH`, `STAGING_ENABLED=true`, `TARGET_ADAPTER_TOKEN`, `STRIPE_WEBHOOK_SECRET`, `LOCAL_REPLAY_SECRET`, `STRIPE_PRICE_ID`, `TARGET_BUILD_ID`, and optional `STRIPE_SECRET_KEY`. Missing required configuration returns 503 `REFERENCE_CONFIGURATION_REQUIRED`; there are no public default credentials. The database defaults to `.local/reference.sqlite` relative to the process working directory. The Next.js app exposes no environment switch for fault modes. Production disables all staging hooks, including replay.
