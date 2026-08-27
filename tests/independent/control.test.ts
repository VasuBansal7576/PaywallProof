import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPolicy } from '../../packages/core/src/index.ts';
import { openRunStore } from '../../packages/control/src/index.ts';

// Authored from the PRD and frozen public contracts, without implementation access.
// These tests use a real temporary SQLite file and synthetic inputs only.

type Store = Awaited<ReturnType<typeof openRunStore>>;
type Run = Awaited<ReturnType<Store['createRun']>>;

const initialTime = 1_800_000_000_000;
const fifteenMinutes = 15 * 60 * 1_000;
let now: number;
let directory: string;
let databasePath: string;
const connections = new Set<Store>();

function singleCases<T>(cases: readonly T[]): [T][] {
  return cases.map((value): [T] => [value]);
}

function attemptMutation(record: object, changes: object) {
  try { Object.assign(record, changes); } catch { /* Frozen records also satisfy detachment. */ }
}

function runInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project_owned',
    policy: createPolicy({
      schemaVersion: 1,
      priceId: 'price_pro',
      featureId: 'export',
      featureConfigHash: 'a'.repeat(64),
      cancellation: 'allow_until_period_end',
      requireInitialInvoicePaid: true,
      syncWindowSeconds: 60,
      predicateVersion: 'export-v1',
    }),
    targetBuild: 'commit_approved',
    featureConfigHash: 'a'.repeat(64),
    mode: 'local_replay',
    ...overrides,
  };
}

async function connect() {
  const store = await openRunStore({ path: databasePath, clock: () => now });
  connections.add(store);
  return store;
}

async function disconnect(store: Store) {
  await store.close();
  connections.delete(store);
}

function planDecision(run: Run, overrides: Record<string, unknown> = {}) {
  return {
    runId: run.id,
    approvalId: run.approval.id,
    bindingHash: run.approval.bindingHash,
    decision: 'allow',
    ...overrides,
  };
}

async function running(store: Store, projectId = 'project_owned') {
  const run = await store.createRun(runInput({ projectId }));
  await store.decidePlan(planDecision(run));
  return run;
}

function claimInput(run: Run, overrides: Record<string, unknown> = {}) {
  return {
    runId: run.id,
    operationId: 'operation_one',
    kind: 'prepare_fixture',
    args: { user: 'synthetic-user', options: { ordinary: true } },
    approvalId: run.approval.id,
    leaseMs: 1_000,
    ...overrides,
  };
}

async function rejectsCode(action: () => unknown, code?: string) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code: code ?? expect.stringMatching(/\S/) });
  return caught;
}

beforeEach(() => {
  now = initialTime;
  directory = mkdtempSync(join(tmpdir(), 'paywallproof-independent-control-'));
  databasePath = join(directory, 'control.sqlite');
});

afterEach(async () => {
  for (const store of connections) await disconnect(store);
  rmSync(directory, { recursive: true, force: true });
});

describe('independent durable control: creation and restart', () => {
  it.each(['local_replay', 'stripe_sandbox'])('persists %s configuration in a real SQLite file', async (mode) => {
    const store = await connect();
    const input = runInput({ mode });
    const run = await store.createRun(input);
    expect(run).toMatchObject({
      ...input,
      id: expect.any(String),
      status: 'awaiting_plan_approval',
      outcome: null,
      approval: {
        id: expect.any(String),
        bindingHash: expect.any(String),
        expiresAt: initialTime + fifteenMinutes,
        decision: 'pending',
      },
    });
    expect(statSync(databasePath).isFile()).toBe(true);
    const before = await store.getRun(run.id);
    await disconnect(store);
    const reopened = await connect();
    expect(await reopened.getRun(run.id)).toEqual(before);
  });

  it('keeps returned run, policy, and approval records detached from durable state', async () => {
    const store = await connect();
    const run = await store.createRun(runInput());
    const before = JSON.stringify(await store.getRun(run.id));
    attemptMutation(run, { status: 'running', projectId: 'foreign_project' });
    attemptMutation(run.policy, { priceId: 'price_replaced' });
    attemptMutation(run.approval, { decision: 'allow', bindingHash: 'forged' });
    expect(JSON.stringify(await store.getRun(run.id))).toBe(before);
  });

  it('does not let mutable input policy copies change stored configuration', async () => {
    const store = await connect();
    const policy = { ...runInput().policy };
    const run = await store.createRun(runInput({ policy }));
    const before = await store.getRun(run.id);
    policy.priceId = 'price_replaced';
    expect(await store.getRun(run.id)).toEqual(before);
  });

  it('reports missing runs through typed errors', async () => {
    const store = await connect();
    await rejectsCode(() => store.getRun('missing_run'), 'NOT_FOUND');
    await rejectsCode(() => store.events({ runId: 'missing_run', after: 0 }), 'NOT_FOUND');
  });

  it('allows different projects but rejects a second active run for the same project', async () => {
    const store = await connect();
    const first = await store.createRun(runInput());
    await rejectsCode(() => store.createRun(runInput()), 'ACTIVE_RUN_CONFLICT');
    const other = await store.createRun(runInput({ projectId: 'project_other' }));
    expect(other.id).not.toBe(first.id);
  });

  it('retains the project lock across database reopen', async () => {
    const store = await connect();
    await store.createRun(runInput());
    await disconnect(store);
    const reopened = await connect();
    await rejectsCode(() => reopened.createRun(runInput()), 'ACTIVE_RUN_CONFLICT');
  });

  it('admits exactly one contender through two database connections', async () => {
    const first = await connect();
    const second = await connect();
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => first.createRun(runInput())),
      Promise.resolve().then(() => second.createRun(runInput())),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: 'ACTIVE_RUN_CONFLICT' } });
  });
});

describe('independent durable control: approval binding and expiry', () => {
  it('starts running only after the matching owner decision', async () => {
    const store = await connect();
    const run = await store.createRun(runInput());
    await rejectsCode(() => store.claimOperation(claimInput(run)));
    expect((await store.getRun(run.id)).status).toBe('awaiting_plan_approval');
    await store.decidePlan(planDecision(run));
    expect(await store.getRun(run.id)).toMatchObject({ status: 'running', approval: { decision: 'allow' } });
    expect((await store.claimOperation(claimInput(run))).kind).toBe('dispatch');
  });

  it('does not consume a pending approval on a wrong binding', async () => {
    const store = await connect();
    const run = await store.createRun(runInput());
    const before = await store.events({ runId: run.id, after: 0 });
    await rejectsCode(() => store.decidePlan(planDecision(run, { bindingHash: 'f'.repeat(64) })), 'APPROVAL_STALE');
    expect((await store.getRun(run.id)).approval.decision).toBe('pending');
    expect(await store.events({ runId: run.id, after: 0 })).toEqual(before);
    await store.decidePlan(planDecision(run));
    expect((await store.getRun(run.id)).status).toBe('running');
  });

  it('rejects another run approval without permitting dispatch', async () => {
    const store = await connect();
    const first = await store.createRun(runInput());
    const second = await store.createRun(runInput({ projectId: 'project_other' }));
    await rejectsCode(() => store.decidePlan(planDecision(first, {
      approvalId: second.approval.id,
      bindingHash: second.approval.bindingHash,
    })));
    expect((await store.getRun(first.id)).approval.decision).toBe('pending');
    await rejectsCode(() => store.claimOperation(claimInput(first)));
  });

  it('accepts the last millisecond before plan expiry', async () => {
    const store = await connect();
    const run = await store.createRun(runInput());
    now = run.approval.expiresAt - 1;
    await store.decidePlan(planDecision(run));
    expect((await store.getRun(run.id)).status).toBe('running');
  });

  it.each([0, 1, fifteenMinutes])('rejects plan approval at expiry plus %s milliseconds', async (offset) => {
    const store = await connect();
    const run = await store.createRun(runInput());
    now = run.approval.expiresAt + offset;
    await rejectsCode(() => store.decidePlan(planDecision(run)), 'APPROVAL_STALE');
    expect(await store.getRun(run.id)).toMatchObject({ status: 'awaiting_plan_approval', approval: { decision: 'pending' } });
  });

  it.each(['allow', 'deny'])('keeps an exact %s decision idempotent across expiry and reopen', async (decision) => {
    const store = await connect();
    const run = await store.createRun(runInput());
    const input = planDecision(run, { decision });
    const result = await store.decidePlan(input);
    const before = await store.events({ runId: run.id, after: 0 });
    now = run.approval.expiresAt + 1;
    await disconnect(store);
    const reopened = await connect();
    expect(await reopened.decidePlan(input)).toEqual(result);
    expect(await reopened.events({ runId: run.id, after: 0 })).toEqual(before);
    await rejectsCode(() => reopened.decidePlan(planDecision(run, { decision: decision === 'allow' ? 'deny' : 'allow' })), 'APPROVAL_CONFLICT');
  });

  it('does not accept a forged binding just because the decision was already allowed', async () => {
    const store = await connect();
    const run = await running(store);
    await rejectsCode(() => store.decidePlan(planDecision(run, { bindingHash: 'f'.repeat(64) })), 'APPROVAL_STALE');
  });

  it('denial releases the project lock and cannot execute operations', async () => {
    const store = await connect();
    const run = await store.createRun(runInput());
    await store.decidePlan(planDecision(run, { decision: 'deny' }));
    expect((await store.getRun(run.id)).status).toBe('canceled');
    await rejectsCode(() => store.claimOperation(claimInput(run)));
    expect((await store.createRun(runInput())).id).not.toBe(run.id);
  });
});

describe('independent durable control: operation ownership and recovery', () => {
  it('persists dispatch and a stable key before returning, across restart', async () => {
    const store = await connect();
    const run = await running(store);
    const request = claimInput(run);
    const dispatch = await store.claimOperation(request);
    expect(dispatch).toMatchObject({
      kind: 'dispatch',
      operation: {
        operationId: request.operationId,
        runId: run.id,
        kind: request.kind,
        state: 'dispatched',
        argsHash: expect.any(String),
        idempotencyKey: expect.stringMatching(/\S/),
      },
    });
    await disconnect(store);
    const reopened = await connect();
    const retry = await reopened.claimOperation(request);
    expect(retry.kind).toBe('in_flight');
    expect(retry.operation.idempotencyKey).toBe(dispatch.operation.idempotencyKey);
    expect(retry.operation.argsHash).toBe(dispatch.operation.argsHash);
  });

  it('does not let concurrent connections dispatch the same logical operation twice', async () => {
    const first = await connect();
    const second = await connect();
    const run = await running(first);
    const request = claimInput(run);
    const results = await Promise.all([
      Promise.resolve().then(() => first.claimOperation(request)),
      Promise.resolve().then(() => second.claimOperation(request)),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['dispatch', 'in_flight']);
    expect(results[0]?.operation.idempotencyKey).toBe(results[1]?.operation.idempotencyKey);
  });

  it('never auto-redispatches an expired lease, including after restart', async () => {
    const store = await connect();
    const run = await running(store);
    const request = claimInput(run);
    const original = await store.claimOperation(request);
    now += 999;
    expect((await store.claimOperation(request)).kind).toBe('in_flight');
    now += 1;
    expect((await store.claimOperation(request)).kind).toBe('unknown');
    await disconnect(store);
    const reopened = await connect();
    now += 30_000;
    const retry = await reopened.claimOperation(request);
    expect(retry.kind).toBe('unknown');
    expect(retry.operation.idempotencyKey).toBe(original.operation.idempotencyKey);
  });

  it('confirms uncertain work with the first receipt and returns that receipt on retry', async () => {
    const store = await connect();
    const run = await running(store);
    const request = claimInput(run);
    const original = await store.claimOperation(request);
    now += 1_000;
    expect((await store.claimOperation(request)).kind).toBe('unknown');
    const receipt = { providerId: 'synthetic_customer_1', nested: { acknowledged: true } };
    await store.confirmOperation({ runId: run.id, operationId: request.operationId, receipt });
    const before = await store.events({ runId: run.id, after: 0 });
    await store.confirmOperation({ runId: run.id, operationId: request.operationId, receipt });
    expect(await store.events({ runId: run.id, after: 0 })).toEqual(before);
    await disconnect(store);
    const reopened = await connect();
    const retry = await reopened.claimOperation(request);
    expect(retry).toMatchObject({ kind: 'confirmed', operation: { state: 'confirmed', receipt } });
    expect(retry.operation.idempotencyKey).toBe(original.operation.idempotencyKey);
    await rejectsCode(() => reopened.confirmOperation({
      runId: run.id, operationId: request.operationId, receipt: { providerId: 'different_effect' },
    }), 'OPERATION_CONFLICT');
    expect((await reopened.claimOperation(request)).operation.receipt).toEqual(receipt);
  });

  it.each(['dispatched', 'confirmed'])('rejects changed args and kind for a %s operation', async (state) => {
    const store = await connect();
    const run = await running(store);
    const request = claimInput(run);
    await store.claimOperation(request);
    if (state === 'confirmed') {
      await store.confirmOperation({ runId: run.id, operationId: request.operationId, receipt: { ok: true } });
    }
    await rejectsCode(() => store.claimOperation({ ...request, args: { user: 'different_user' } }), 'OPERATION_CONFLICT');
    await rejectsCode(() => store.claimOperation({ ...request, kind: 'advance_test_clock' }), 'OPERATION_CONFLICT');
  });

  it('does not expose or mutate another run operation through a known operation ID', async () => {
    const store = await connect();
    const owner = await running(store);
    const foreign = await running(store, 'project_other');
    const request = claimInput(owner);
    await store.claimOperation(request);
    const receipt = { providerId: 'synthetic_private_receipt_owner' };
    await store.confirmOperation({ runId: owner.id, operationId: request.operationId, receipt });
    const error = await rejectsCode(() => store.claimOperation(claimInput(foreign)), 'OWNERSHIP_MISMATCH');
    expect(String(error)).not.toContain(receipt.providerId);
    await rejectsCode(() => store.confirmOperation({ runId: foreign.id, operationId: request.operationId, receipt: { malicious: true } }), 'OWNERSHIP_MISMATCH');
    expect((await store.claimOperation(request)).operation.receipt).toEqual(receipt);
  });

  it('rejects claims authorized by another run approved plan', async () => {
    const store = await connect();
    const owner = await running(store);
    const foreign = await running(store, 'project_other');
    await rejectsCode(() => store.claimOperation(claimInput(owner, { approvalId: foreign.approval.id })));
    expect((await store.claimOperation(claimInput(owner))).kind).toBe('dispatch');
  });

  it('does not confirm an operation that was never dispatched', async () => {
    const store = await connect();
    const run = await running(store);
    await rejectsCode(() => store.confirmOperation({ runId: run.id, operationId: 'not_dispatched', receipt: { ok: true } }));
    expect((await store.claimOperation(claimInput(run, { operationId: 'not_dispatched' }))).kind).toBe('dispatch');
  });

  it('does not retain caller references to args or confirmation receipts', async () => {
    const store = await connect();
    const run = await running(store);
    const args = { nested: { user: 'original' } };
    const request = claimInput(run, { args });
    const original = await store.claimOperation(request);
    args.nested.user = 'mutated';
    const retry = await store.claimOperation({ ...request, args: { nested: { user: 'original' } } });
    expect(retry.operation.argsHash).toBe(original.operation.argsHash);
    const receipt = { nested: { providerId: 'original' } };
    await store.confirmOperation({ runId: run.id, operationId: request.operationId, receipt });
    receipt.nested.providerId = 'mutated';
    const confirmed = await store.claimOperation({ ...request, args: { nested: { user: 'original' } } });
    expect(confirmed.operation.receipt).toEqual({ nested: { providerId: 'original' } });
    try { Object.assign(confirmed.operation, { receipt: { forged: true }, state: 'dispatched' }); } catch { /* Frozen is acceptable. */ }
    expect((await store.claimOperation({ ...request, args: { nested: { user: 'original' } } })).operation.receipt)
      .toEqual({ nested: { providerId: 'original' } });
  });
});

describe('independent durable control: bounds and terminal states', () => {
  it('permits 100 unique operations, does not count retries, and rejects the 101st', async () => {
    const store = await connect();
    const run = await running(store);
    for (let i = 0; i < 100; i += 1) {
      const request = claimInput(run, { operationId: `operation_${i}` });
      expect((await store.claimOperation(request)).kind).toBe('dispatch');
      expect((await store.claimOperation(request)).kind).toBe('in_flight');
    }
    await rejectsCode(() => store.claimOperation(claimInput(run, { operationId: 'operation_100' })));
    await disconnect(store);
    const reopened = await connect();
    await rejectsCode(() => reopened.claimOperation(claimInput(run, { operationId: 'operation_101' })));
  });

  it('starts the active deadline at approval, excluding the preceding wait', async () => {
    const store = await connect();
    const run = await store.createRun(runInput());
    now += 5 * 60 * 1_000;
    await store.decidePlan(planDecision(run));
    now += fifteenMinutes - 1;
    expect((await store.claimOperation(claimInput(run))).kind).toBe('dispatch');
    now += 1;
    await rejectsCode(() => store.claimOperation(claimInput(run, { operationId: 'after_deadline' })));
  });

  it('retains the active deadline across restart', async () => {
    const store = await connect();
    const run = await running(store);
    await disconnect(store);
    now += fifteenMinutes;
    const reopened = await connect();
    await rejectsCode(() => reopened.claimOperation(claimInput(run)));
  });

  it.each(['prepare_fixture', 'change_test_subscription', 'advance_test_clock', 'probe_feature', 'cleanup_run'])('rejects a new %s operation after cancellation', async (kind) => {
    const store = await connect();
    const run = await running(store);
    await store.cancelRun(run.id);
    await rejectsCode(() => store.claimOperation(claimInput(run, { kind })));
  });

  it('preserves in-flight work after cancellation and accepts its eventual receipt', async () => {
    const store = await connect();
    const run = await running(store);
    const request = claimInput(run);
    await store.claimOperation(request);
    const beforeStop = await store.events({ runId: run.id, after: 0 });
    await store.cancelRun(run.id);
    expect((await store.getRun(run.id)).status).toBe('canceled');
    const afterStop = await store.events({ runId: run.id, after: 0 });
    expect(afterStop.slice(0, beforeStop.length)).toEqual(beforeStop);
    await store.confirmOperation({ runId: run.id, operationId: request.operationId, receipt: { dispatchedEffect: 'accounted-for' } });
    expect((await store.getRun(run.id)).status).toBe('canceled');
    expect((await store.events({ runId: run.id, after: 0 })).length).toBeGreaterThan(afterStop.length);
    await rejectsCode(() => store.claimOperation(claimInput(run, { operationId: 'new_after_stop' })));
    expect((await store.createRun(runInput())).id).not.toBe(run.id);
  });

  it('cancellation is idempotent without duplicate transition events', async () => {
    const store = await connect();
    const run = await running(store);
    await store.cancelRun(run.id);
    const before = await store.events({ runId: run.id, after: 0 });
    await store.cancelRun(run.id);
    expect(await store.events({ runId: run.id, after: 0 })).toEqual(before);
  });

  it.each<[string[], string]>([
    [[], 'inconclusive'], [['pass'], 'passed'], [['pass', 'fail'], 'failed'],
    [['pass', 'unsupported'], 'inconclusive'], [['skipped'], 'inconclusive'],
    [['inconclusive', 'fail'], 'failed'],
  ])('completes with aggregate outcome for %s', async (verdicts, outcome) => {
    const store = await connect();
    const run = await running(store);
    await store.finishRun({ runId: run.id, verdicts });
    expect(await store.getRun(run.id)).toMatchObject({ status: 'completed', outcome });
    await store.cancelRun(run.id);
    expect(await store.getRun(run.id)).toMatchObject({ status: 'completed', outcome });
    await rejectsCode(() => store.claimOperation(claimInput(run)));
    expect((await store.createRun(runInput())).id).not.toBe(run.id);
  });

  it('cannot replace a completed failed outcome with passing results', async () => {
    const store = await connect();
    const run = await running(store);
    await store.finishRun({ runId: run.id, verdicts: ['fail'] });
    const before = await store.events({ runId: run.id, after: 0 });
    await rejectsCode(() => store.finishRun({ runId: run.id, verdicts: ['pass'] }));
    expect(await store.getRun(run.id)).toMatchObject({ status: 'completed', outcome: 'failed' });
    expect(await store.events({ runId: run.id, after: 0 })).toEqual(before);
  });

  it.each(['awaiting_plan_approval', 'canceled'])('does not finish a run in %s', async (state) => {
    const store = await connect();
    const run = await store.createRun(runInput());
    if (state === 'canceled') await store.cancelRun(run.id);
    await rejectsCode(() => store.finishRun({ runId: run.id, verdicts: ['pass'] }));
    expect((await store.getRun(run.id)).status).toBe(state);
  });
});

describe('independent durable control: resumable event reads', () => {
  it('preserves an ordered append-only history and an exclusive cursor across reopen', async () => {
    const store = await connect();
    const run = await store.createRun(runInput());
    const creation = await store.events({ runId: run.id, after: 0 });
    expect(creation.length).toBeGreaterThan(0);
    now += 10;
    await store.decidePlan(planDecision(run));
    const request = claimInput(run);
    await store.claimOperation(request);
    now += 10;
    await store.confirmOperation({ runId: run.id, operationId: request.operationId, receipt: { ok: true } });
    const all = await store.events({ runId: run.id, after: 0 });
    expect(all.slice(0, creation.length)).toEqual(creation);
    let previous = 0;
    for (const event of all) {
      expect(Number.isSafeInteger(event.sequence)).toBe(true);
      expect(event.sequence).toBeGreaterThan(previous);
      expect(event).toMatchObject({ type: expect.any(String), occurredAt: expect.any(Number) });
      expect(event).toHaveProperty('payload');
      expect(Number.isSafeInteger(event.occurredAt)).toBe(true);
      previous = event.sequence;
    }
    const cursor = creation[creation.length - 1]?.sequence;
    expect(await store.events({ runId: run.id, after: cursor })).toEqual(all.filter((event) => event.sequence > Number(cursor)));
    expect(await store.events({ runId: run.id, after: previous })).toEqual([]);
    expect(await store.events({ runId: run.id, after: Number.MAX_SAFE_INTEGER })).toEqual([]);
    expect(await store.events({ runId: run.id, after: 0 })).toEqual(all);
    await disconnect(store);
    const reopened = await connect();
    expect(await reopened.events({ runId: run.id, after: 0 })).toEqual(all);
  });

  it('does not let returned event records change persisted history', async () => {
    const store = await connect();
    const run = await store.createRun(runInput());
    const records = await store.events({ runId: run.id, after: 0 });
    const before = JSON.stringify(records);
    for (const event of records) {
      try { Object.assign(event, { type: 'forged', payload: { forged: true } }); } catch { /* Frozen is acceptable. */ }
    }
    expect(JSON.stringify(await store.events({ runId: run.id, after: 0 }))).toBe(before);
  });

  it('isolates histories by run', async () => {
    const store = await connect();
    const first = await running(store);
    const second = await store.createRun(runInput({ projectId: 'project_other' }));
    const before = await store.events({ runId: second.id, after: 0 });
    await store.claimOperation(claimInput(first));
    await store.cancelRun(first.id);
    expect(await store.events({ runId: second.id, after: 0 })).toEqual(before);
  });
});

describe('independent durable control: strict boundaries', () => {
  it.each<[string, unknown]>([
    ['projectId', ''], ['projectId', ' padded'], ['targetBuild', ''], ['targetBuild', 'padded '],
    ['mode', 'production'], ['mode', null], ['featureConfigHash', 'b'.repeat(64)],
    ['featureConfigHash', 'A'.repeat(64)], ['policy', null], ['extra', true],
  ])('rejects invalid createRun field %s without taking a project lock', async (field, value) => {
    const store = await connect();
    await rejectsCode(() => store.createRun(runInput({ [field]: value })), 'INVALID_INPUT');
    expect((await store.createRun(runInput())).status).toBe('awaiting_plan_approval');
  });

  it('rejects a policy whose fields no longer match its hash', async () => {
    const store = await connect();
    const policy = { ...runInput().policy, priceId: 'tampered_price' };
    await rejectsCode(() => store.createRun(runInput({ policy })), 'INVALID_INPUT');
  });

  it.each(Object.keys(runInput()))('rejects missing createRun field %s', async (field) => {
    const store = await connect();
    const input: Record<string, unknown> = runInput();
    delete input[field];
    await rejectsCode(() => store.createRun(input), 'INVALID_INPUT');
  });

  it.each(singleCases([null, undefined, [], 'run', 1]))('rejects a nonrecord createRun input', async (input) => {
    const store = await connect();
    await rejectsCode(() => store.createRun(input), 'INVALID_INPUT');
  });

  it.each(['', ' ', ' padded', 'padded ', '\tidentifier', 'identifier\n'])('rejects malformed run IDs %s', async (runId) => {
    const store = await connect();
    await rejectsCode(() => store.getRun(runId), 'INVALID_INPUT');
    await rejectsCode(() => store.cancelRun(runId), 'INVALID_INPUT');
  });

  it.each<[string, unknown]>([
    ['decision', 'approve'], ['decision', true], ['approvalId', ''], ['bindingHash', ''],
    ['runId', ' padded'], ['extra', true],
  ])('rejects malformed approval field %s', async (field, value) => {
    const store = await connect();
    const run = await store.createRun(runInput());
    await rejectsCode(() => store.decidePlan(planDecision(run, { [field]: value })), 'INVALID_INPUT');
    expect((await store.getRun(run.id)).approval.decision).toBe('pending');
  });

  it.each<[string, unknown]>([
    ['operationId', ''], ['operationId', ' padded'], ['kind', 'arbitrary_http'],
    ['approvalId', ''], ['leaseMs', 0], ['leaseMs', 30_001], ['leaseMs', 1.5],
    ['leaseMs', NaN], ['leaseMs', Infinity], ['leaseMs', Number.MAX_SAFE_INTEGER + 1],
    ['leaseMs', '1000'], ['args', null], ['args', []], ['args', 'arbitrary'], ['extra', true],
  ])('rejects malformed claim field %s without reserving its operation ID', async (field, value) => {
    const store = await connect();
    const run = await running(store);
    await rejectsCode(() => store.claimOperation(claimInput(run, { [field]: value })), 'INVALID_INPUT');
    expect((await store.claimOperation(claimInput(run))).kind).toBe('dispatch');
  });

  it.each([1, 30_000])('accepts lease boundary %s milliseconds', async (leaseMs) => {
    const store = await connect();
    const run = await running(store);
    expect((await store.claimOperation(claimInput(run, { leaseMs }))).kind).toBe('dispatch');
  });

  it('rejects cycles, accessors, classes, nonfinite numbers, functions, and undefined in args', async () => {
    const store = await connect();
    const run = await running(store);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 'hidden' });
    class Args { value = 'untrusted'; }
    const invalid = [cycle, accessor, new Args(), { value: undefined }, { value: Infinity }, { value: () => 'code' }];
    for (const args of invalid) {
      await rejectsCode(() => store.claimOperation(claimInput(run, { args })), 'INVALID_INPUT');
    }
    expect((await store.claimOperation(claimInput(run))).kind).toBe('dispatch');
  });

  it('rejects excessive JSON nesting in operation args', async () => {
    const store = await connect();
    const run = await running(store);
    let args: Record<string, unknown> = { value: 'deep' };
    for (let i = 0; i < 40; i += 1) args = { child: args };
    await rejectsCode(() => store.claimOperation(claimInput(run, { args })), 'INVALID_INPUT');
  });

  it.each(singleCases([undefined, NaN, Infinity, () => 'receipt', { field: undefined }, new Date(0)]))('rejects non-JSON receipts without confirming the operation', async (receipt) => {
    const store = await connect();
    const run = await running(store);
    const request = claimInput(run);
    await store.claimOperation(request);
    await rejectsCode(() => store.confirmOperation({ runId: run.id, operationId: request.operationId, receipt }), 'INVALID_INPUT');
    expect((await store.claimOperation(request)).kind).toBe('in_flight');
  });

  it.each(singleCases([null, false, 0, 'synthetic_receipt', [1, 'two'], { nested: [null, true] }]))('accepts JSON receipt values without imposing a provider-specific shape', async (receipt) => {
    const store = await connect();
    const run = await running(store);
    const request = claimInput(run);
    await store.claimOperation(request);
    await store.confirmOperation({ runId: run.id, operationId: request.operationId, receipt });
    expect((await store.claimOperation(request)).operation.receipt).toEqual(receipt);
  });

  it('rejects unknown confirmation and finish fields', async () => {
    const store = await connect();
    const run = await running(store);
    const request = claimInput(run);
    await store.claimOperation(request);
    await rejectsCode(() => store.confirmOperation({ runId: run.id, operationId: request.operationId, receipt: {}, extra: true }), 'INVALID_INPUT');
    await rejectsCode(() => store.finishRun({ runId: run.id, verdicts: ['pass'], outcome: 'passed' }), 'INVALID_INPUT');
    expect((await store.getRun(run.id)).status).toBe('running');
  });

  it.each(singleCases([null, 'pass', ['passed'], ['fail', 'invalid'], [undefined]]))('rejects malformed completion verdicts', async (verdicts) => {
    const store = await connect();
    const run = await running(store);
    await rejectsCode(() => store.finishRun({ runId: run.id, verdicts }), 'INVALID_INPUT');
    expect((await store.getRun(run.id)).status).toBe('running');
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null])('rejects invalid event cursor %s', async (after) => {
    const store = await connect();
    const run = await store.createRun(runInput());
    await rejectsCode(() => store.events({ runId: run.id, after }), 'INVALID_INPUT');
  });

  it('rejects unknown event-query fields', async () => {
    const store = await connect();
    const run = await store.createRun(runInput());
    await rejectsCode(() => store.events({ runId: run.id, after: 0, extra: true }), 'INVALID_INPUT');
  });
});
