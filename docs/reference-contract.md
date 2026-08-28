# Reference target HTTP contract

`createReferenceApp(options)` is exported from `packages/reference/src/index.ts` and returns `{ app, close }`. `app` is a real Hono app with `.request()` and `.fetch()` methods. `close()` closes the target's SQLite connection. The target imports no controller or evaluator code.

Options are `databasePath`, `stagingEnabled`, `adapterToken`, `webhookSecret`, `replaySecret`, `priceId`, `buildId`, optional `polarToken`, `polarOrganizationId`, `polarProductId`, and optional `faultMode`. Fault modes are `none`, `missing_guard`, `missing_activation`, and `missing_cancellation`. Secrets must be nonempty and the webhook and replay secrets must differ. Provider credentials must be a Polar organization token with UUID organization, product and price. Partial provider configuration is rejected. Fault modes require staging to be enabled and `NODE_ENV` to differ from `production`; they have no HTTP setter.

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

`POST /staging/users/:id/customer` takes `{ "runId": "run-1", "customerId": "cus_example" }` and returns 200 with `{ "principalId": "...", "runId": "run-1", "customerId": "cus_example" }`. Native customer IDs are UUIDs. Local replay IDs begin with `cus_` and contain only ASCII letters, digits or underscores. This operation only links identity; it never changes entitlement. A principal may have only one customer, and a customer may have only one principal. Repeating the same link is harmless. Conflicts return 409. When a Polar reader is configured, native customer reads must confirm sandbox headers, organization, run metadata and immutable external ID. The reserved `cus_replay_` namespace remains local-only. Without a key, this establishes only a local fixture mapping and makes no provider ownership claim.

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
  "initialPaymentConfirmed": false,
  "cancelAtPeriodEnd": false,
  "periodEnd": null,
  "buildId": "configured-build-id"
}
```

This read never synchronizes billing. With a subscription, IDs are strings, `status` is the stored provider status, and `periodEnd` is Unix seconds from the native subscription's `current_period_end`. A free user has status `none`.

`DELETE /staging/users/:id?runId=run-1` returns 200 with `{ "removed": true, "principalId": "...", "runId": "run-1" }`. It deletes the user's fixture and sessions, retains operation and event receipts for safe retries, and never deletes provider resources. Repeating a deletion is harmless. All user-scoped staging operations return 403 `RUN_OWNERSHIP_MISMATCH` for another run's principal and 404 `USER_NOT_FOUND` for an unknown principal.

## Ordinary feature routes

`GET /api/export` accepts only the ordinary session cookie. No session gives 401 `{ "error": "AUTHENTICATION_REQUIRED" }`. A free or canceled user gives 403 `{ "error": "ACCESS_DENIED" }`. An authorized user gives 200 `{ "fixtureMarker": "<this user's private marker>" }`. Authorization requires an active subscription, the configured price, and a confirmed paid initial order. Scheduled cancellation does not revoke access while provider status remains active. Host time does not decide billing access. `Authorization: Bearer <adapterToken>` alone never authorizes this route, even in a fault variant.

`GET /api/me` accepts only the ordinary session cookie. It returns 401 without a session or 200 with `{ "principalId": "...", "plan": "Free" | "Pro", "canExport": boolean, "subscriptionStatus": string, "cancelAtPeriodEnd": boolean, "periodEnd": number | null, "executionMode": "none" | "local_replay" | "polar_sandbox" }`. It contains neither fixture data nor credentials. The Next.js `/dashboard` renders these values and performs a real `/api/export` request when `export-button` is clicked. `export-result` has a `data-status` of `idle`, `loading`, `allowed`, `denied`, or `unavailable` and contains the actual marker only after a successful export response.

## Real Polar webhook

`POST /api/polar/webhook` verifies exact raw bytes using `standardwebhooks@1.0.0`, the configured Polar secret encoded as base64, and `webhook-id`, `webhook-timestamp`, `webhook-signature`. The verifier enforces its 300-second timestamp tolerance. Missing, forged or expired signatures return 400 `INVALID_WEBHOOK_SIGNATURE`. Internal replay signatures cannot authenticate this route. A correctly signed native `{type,timestamp,data}` event without a configured provider reader returns 503 `{error:'POLAR_WEBHOOK_UNAVAILABLE',processed:false}`.

Subscription events identify native `id` and `customer_id`; order events identify `subscription_id` and `customer_id`. Unrelated events are acknowledged as ignored. Supported notifications trigger current provider reads, never blind application of payload status. The reader pins API `2026-04`, verifies sandbox headers and organization, requires one owned subscription, one configured fixed price and one matching initial order, and rejects incomplete pagination, trials, discounts and refunds. No provider mutation is available to the target.

Successful responses contain `received`, `processed`, `duplicate`, `stale`, and `mode:'polar_sandbox'`. Delivery IDs and exact raw-payload hashes are committed with projection updates. Exact duplicates do not trigger another read; conflicting bytes or mode return 409 `EVENT_ID_CONFLICT`. Processing is serialized per customer. Event timestamps cannot override current provider state. Failed or unavailable reads do not acknowledge a successful projection.

## Local replay

`POST /staging/replay` requires both the staging bearer token and `PaywallProof-Replay-Signature` made with `replaySecret`. It performs no network request. The body is a sanitized, synthetic legacy invoice-shaped subscription event, not an arbitrary entitlement update:

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

Use the current real Unix timestamp in the signature, even when the event's `created` value represents simulated billing time. `signReplay({ payload: rawBody, secret: replaySecret })` from `packages/reference/src/replay-signature.ts` produces an appropriate test signature. The `created` timestamp orders replay events; older events are recorded but return `stale: true` without overwriting newer billing state. Cancellation scheduling uses a fresh updated event with `cancel_at_period_end: true` and status `active`. Actual cancellation uses a fresh deleted event with status `canceled`.

Replay accepts exactly one configured item and requires matching subscription `metadata.runId`. Invoice `customer` and subscription linkage are checked when supplied. Invoice `livemode: false` and `status` are required; `id`, `object`, `billing_reason`, and identity fields are optional for minimal sanitized fixtures. Only a paid creation invoice establishes initial payment, and that fact survives later lifecycle events for the same subscription. A user cannot mix replay and real Polar billing projections. Every replay response and the ordinary UI are labeled `local_replay`; these results are never real Polar verification.

`latest_invoice` may be omitted or null. Such events are accepted for the supported subscription binding, but cannot establish initial payment. For the same subscription, retain an already established payment fact; for the first subscription of an unbound fixture, start unpaid unless a supplied valid paid creation invoice establishes payment. A different subscription ID cannot replace an existing fixture binding: reject that unsupported event and preserve the original projection, regardless of whether the replacement supplies a paid invoice. This follows PRD sections 2.3, 6.1, and 12.2: multiple subscriptions per user are outside scope, a run uses one subscription lifecycle, and reruns require fresh fixtures. A supplied non-null invoice must satisfy the invoice schema, and supplied customer or subscription linkage must match the event's owned subscription. There is no independently bound invoice-ID ledger in local replay; a differing `invoice.id` alone is not evidence of foreign ownership. Real Polar mode obtains initial order identity from provider reads.

## Next.js environment

Run `next dev apps/demo-saas --hostname 127.0.0.1 --port 3001`. Server-only settings are `REFERENCE_DATABASE_PATH`, `STAGING_ENABLED=true`, `TARGET_ADAPTER_TOKEN`, `POLAR_WEBHOOK_SECRET`, `LOCAL_REPLAY_SECRET`, `BILLING_PRICE_ID`, `TARGET_BUILD_ID`, and optional `POLAR_REFERENCE_TOKEN`, `POLAR_ORGANIZATION_ID` and `POLAR_PRODUCT_ID`. Missing required configuration returns 503 `REFERENCE_CONFIGURATION_REQUIRED`; there are no public default credentials. The database defaults to `.local/reference-v2.sqlite` relative to the process working directory. The Next.js app exposes no environment switch for fault modes. Production disables all staging hooks, including replay.

The replay signing helper and Polar reader travel into the repair sandbox as protected support files. Their hashes cannot change, and they are not repair-editable paths. Native provider credentials never travel with them.
