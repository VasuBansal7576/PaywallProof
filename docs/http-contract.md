# Product UI API contract

All paths are same-origin `/api`. Next proxies to the private worker. JSON requests. Mutation requests after login must include `X-CSRF-Token` from `/api/session` and `X-Request-Id` generated once per user action, reused only to retry the identical action. Cookies are HttpOnly. No secrets enter chat, report, model prompts, or source.

Errors are JSON `{error:{code,message}}`; non-2xx must be displayed, never converted to a successful state.

- POST /api/login `{token}` => `{csrfToken}` plus session cookie. The operator token is in ignored `.local/operator-token`, configured by local launcher. No seeded account or password. GET /api/session => `{csrfToken}` or 401.
- GET /api/config => `{target:{id:'reference',origin}, repository, defaultRef, polarConfigured:boolean, priceId:string, model:string, limits, coverageLimits:string[]}`. Missing Polar credentials is explicit, not a validation pass.
- GET /api/projects => project array.
- POST /api/projects `{name,repository,ref,targetId:'reference',ownershipConfirmed:true,modelConsent:true}` => project `{id,name,repository,ref,targetId,ownershipConfirmed,modelConsent}`. Repository/target must match server configuration.
- POST /api/projects/:id/preflight `{mode:'polar_sandbox'|'local_replay'}` => `{ready:boolean,checks:[{name,status:'pass'|'blocked',detail}],target?:{buildId,feature,...}}`. local_replay is synthetic signed event replay against the actual target. It does not verify Polar.
- POST /api/projects/:id/policies accepts createPolicy input from public-contracts.md. Returns immutable policy. UI gets featureConfigHash from preflight field `featureConfigHash`; default sync window60, predicateVersion `reference-export-v1`, schemaVersion2, cancellation allow_until_period_end, requireInitialPaymentConfirmed true, featureId pro_export, configured priceId. GET /api/projects/:id/policies => policy array.
- POST /api/runs `{projectId,policyHash,mode}` => run record. The server rechecks prerequisites before creation. Unready runs return 422 with blockers. GET /api/runs => run list.
- GET /api/runs/:id => `{run, runtime, scenarios, observations, cleanup, repairs, coverageLimits}`. run fields follow control-contract, runtime nullable otherwise `{sessionId,turnId,lastSequenceNumber,status,error?,pendingApprovals?}`. scenarios array `{id,api:{verdict,code},browser:{verdict,code},state:{verdict,code},observationIds}`; empty means untested. observations metadata/redacted payloads only. Runtime errors do not mean passing run. Poll read endpoints only; never create a run/turn on reconnect.
- GET /api/runs/:id/events?after=N => `{events:[{sequence,type,payload,occurredAt}],cursor}`. Resumable durable event batch. UI may poll. Streaming transport can be added without changing replay semantics.
- POST /api/runs/:id/approvals/:approvalId `{decision:'allow'|'deny',bindingHash}` => run record. Display whole plan, mode, target, policy, fixed object limits, local model, expiry, cleanup permission before decision. If TrueForge has not reached the matching runtime tool approval yet, return 409 RUNTIME_APPROVAL_PENDING; button can retry explicitly. Never imply owner approval auto-authorizes PR publication.
- POST /api/runs/:id/cancel `{}` => run record. Explain in-flight actions can finish; no further scenario begins.
- POST /api/runs/:id/repairs `{}` => repair state or typed unmet prerequisite error. Must not imply repair succeeded if unavailable. Actual repair will expose diff, test evidence, exact publication approval and local replay limitation.
- GET /api/runs/:id/report?format=json|markdown => downloadable report with real scenario coverage, evidence refs, versions, immutable policy, cleanup, repairs, limitations. Reports escape untrusted content when rendered.

Initial UI must show honest empty states, distinct Untested/Inconclusive/Blocked, sidebar project/run navigation, local-replay warning, and accessible keyboard controls. No fake projects, stats, results, findings or repair diffs. The complete required screens remain in PRD; implement controls for actual endpoints only and disclose blocked operations.

The workspace searches and filters every returned run without truncating history. Ordering is descending `createdAt`, with ID as a stable tie-breaker. Run tabs use URL fragments and do not issue mutations when selected, reloaded or navigated with browser history. Copy controls expose exact saved IDs or JSON; report links use the authenticated routes above. Mobile navigation keeps the same projects and runs available.

Handled preflight errors are persisted by the existing idempotency middleware after Hono's error handler returns. Repeating the same request ID and body returns the recorded status/body without dispatching another preflight. Regression tests exercise invalid JSON, invalid mode, missing project and a thrown read failure. These known failures are distinct from a genuinely uncertain interrupted mutation, whose pending record must still block blind redispatch.

`GET /api/runs/:id/checkout` requires the normal operator session and an active Polar run. It redirects to the validated sandbox checkout URL with `Referrer-Policy: no-referrer`, or returns 409 when no checkout exists. The private URL is never included in reports, model tool results or evidence.
