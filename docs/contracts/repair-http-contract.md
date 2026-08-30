# Repair job and publication HTTP contract

These routes use the same operator authentication, CSRF protection and X-Request-Id mutation deduplication as other control routes. No route accepts patches, test receipts, oracle replacements or arbitrary commands from the browser.

- `POST /api/runs/:runId/repairs` accepts `{findingId?}`. A findingId is `SC01:api`, `SC01:browser`, `SC01:state` or the equivalent for SC02 through SC04. Omitting it selects the first recorded failed channel. The original run must be completed, have a confirmed failure and a recorded unchanged oracle. Two repair jobs maximum per original run; only one executes at once. Returns 202 with the persisted job.
- `POST /api/runs/:runId/repairs/:jobId/cancel` accepts `{}` and requests termination of that job's local execution. It never cancels unrelated runs or provider objects.
- `POST /api/runs/:runId/repairs/:jobId/publication-request` accepts `{}` after verified local repair evidence. It requests the exact publication approval and starts the TrueForge publication tool gate. No GitHub write occurs yet. Returns 202 with the current job view.
- `POST /api/runs/:runId/repairs/:jobId/approvals/:approvalId` accepts `{decision:'allow'|'deny',bindingHash}`. The ID and hash must match the displayed approval, and TrueForge must be paused on that run's exact publish tool call. Denial cannot publish. Allowing publication authorizes only that manifest, branch and PR. It never authorizes merge or deployment.

Run detail's `repairs` is an array of job views:

```ts
{
  id, runId, findingId,
  attempt: 1 | 2,
  createdAt, deadline,
  state: 'preparing' | 'testing' | 'verified_local' | 'abandoned',
  mode: 'local_replay',
  sessionId, turnId,
  proposalId: string | null,
  error: string | null,
  runtimeOperations: Array<{sessionId,operationId,phase,turnId,previousTurnId}>,
  checks: Array<{phase:'before'|'after',artifactHash,exitCode,scenarios,controls,observations,artifacts,runtime}>,
  proposal: RepairRecord | null,
  publicationRuntime: null | {sessionId,turnId,approvalId,status:'running'|'approval'|'done'|'error',error?}
}
```

RepairRecord and its proposal, manifest, approval, changes and publication receipt are defined in repair-contract.md. A generated diff is `proposal.proposal.changes`, with path and full new content; do not label it verified until a manifest exists. A testing failure preserves its candidate diff and failed check evidence. The original run's failed outcome never changes because a sandbox repair passed.

The UI shows job phase, limits, errors, exact changed files and contents, the original/patched check results, immutable policy/oracle/diff hashes, execution mode and limitations. A verified local patch is only eligible for a draft PR. The approval view shows `approval.args` and bindingHash exactly. Enable allow/deny only while approval decision is pending, before expiresAt, and publicationRuntime.status is approval. Show publication only after the stored provider receipt says kind published, with its real URL and draft status.

Unknown outcomes remain explicit. A dropped connection or worker restart may resume a read of the existing turn, but must never dispatch another uncertain generation, fixture mutation, branch creation or PR creation. Local diffs remain available when publication is unavailable or denied.

Each check contains the child oracle run's observations and browser artifact metadata with their original child run IDs. Authenticated downloads use the parent run route. Top-level download records identify that distinction with `repairRunId`, `repairJobId` and `phase`; they are not original-scan evidence. The original run's outcome remains unchanged.

The trusted worker additionally requires fourteen security controls from `src/repair/controls.ts` as regression receipts. These exercise missing/invalid sessions, missing/invalid adapter credentials, missing/invalid webhook signatures, separate replay/webhook secrets, cross-run ownership and rejection of synthetic live-mode payloads. Every request must return its specified denial status and leave the disposable user's billing snapshot unchanged. The controls never contact Stripe or create a live transaction. Transport errors abort verification; a denial-looking status with a changed billing snapshot fails.

Publication intent is persisted before dispatch. An uncertain response is reconciled through `findContinuation` reads only. An absent continuation remains `PUBLICATION_OUTCOME_UNKNOWN_NO_REDISPATCH`; a read failure remains `PUBLICATION_RUNTIME_UNAVAILABLE`. Repeating the same decision does not send another runtime continuation, and a conflicting decision rejects. Worker recovery resumes known publication turns without authorizing new work.
