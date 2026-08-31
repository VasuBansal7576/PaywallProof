import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPolicy, hashValue } from '#domain';
import { bindTargetFeatureProbe, type TargetFeature } from '#integrations/target-contract';
import { openRunStore } from './index.ts';

const directories: string[] = [];
const targetFeature = {
  id: 'pipeline_export',
  method: 'GET',
  path: '/api/export',
  denialStatuses: [403],
  browserPath: '/admin',
  actionTestId: 'pipeline-export-button',
  resultTestId: 'pipeline-export-result',
} satisfies TargetFeature;

function input(projectId: string, featureProbeHash?: string) {
  const featureConfigHash = hashValue(targetFeature);
  const mode = 'local_replay';
  return {
    projectId,
    policy: createPolicy({
      schemaVersion: 2,
      priceId: 'price_pro',
      featureId: targetFeature.id,
      featureConfigHash,
      cancellation: 'allow_until_period_end',
      requireInitialPaymentConfirmed: true,
      syncWindowSeconds: 60,
      predicateVersion: 'paywallproof-entitlement-v1',
    }),
    targetBuild: 'synthetic_build',
    featureConfigHash,
    ...(featureProbeHash === undefined ? {} : { featureProbeHash }),
    targetFeature,
    mode,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('run probe-contract binding', () => {
  it('accepts the derived hash and rejects a different probe contract hash', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paywallproof-run-binding-'));
    directories.push(directory);
    const store = openRunStore({ path: join(directory, 'control.sqlite') });

    expect(() => store.createRun(input('mismatched_probe', 'b'.repeat(64)))).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    const binding = bindTargetFeatureProbe(targetFeature);
    expect(store.createRun(input('bound_probe', binding.hash)).featureProbeHash).toBe(binding.hash);

    store.close();
  });

  it('continues to read a descriptor-bound legacy run without a probe hash', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paywallproof-legacy-run-'));
    directories.push(directory);
    const databasePath = join(directory, 'control.sqlite');
    const first = openRunStore({ path: databasePath });
    const created = first.createRun(input('legacy_probe'));
    expect(created.featureProbeHash).toBeUndefined();
    first.close();

    const reopened = openRunStore({ path: databasePath });
    expect(reopened.getRun(created.id).featureProbeHash).toBeUndefined();
    reopened.close();
  });

  it('returns an exact confirmed receipt after the run becomes terminal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paywallproof-confirmed-operation-'));
    directories.push(directory);
    const store = openRunStore({ path: join(directory, 'control.sqlite') });
    const run = store.createRun(input('confirmed-receipt'));
    store.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    const request = {
      runId: run.id,
      operationId: 'durable_operation',
      kind: 'cleanup_run' as const,
      args: { runId: run.id, operationId: 'durable_operation' },
    };
    store.claimOperation({
      ...request,
      approvalId: run.approval.id,
      leaseMs: 30_000,
    });
    store.confirmOperation({
      runId: run.id,
      operationId: request.operationId,
      receipt: { status: 'clean' },
    });
    store.finishRun({ runId: run.id, verdicts: ['pass'] });

    expect(store.confirmedOperation(request)?.receipt).toEqual({ status: 'clean' });
    expect(() =>
      store.confirmedOperation({ ...request, args: { ...request.args, changed: true } }),
    ).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    expect(() => store.confirmedOperation({ ...request, kind: 'probe_feature' })).toThrowError(
      expect.objectContaining({ code: 'OPERATION_CONFLICT' }),
    );
    expect(store.confirmedOperation({ ...request, operationId: 'unknown_operation' })).toBeNull();

    store.close();
  });
});

describe('external wait credit lookup', () => {
  it('returns the exact durable timestamps without mutating the run or its events', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paywallproof-external-wait-credit-'));
    directories.push(directory);
    const databasePath = join(directory, 'control.sqlite');
    let currentTime = 1_000;
    const first = openRunStore({ path: databasePath, clock: () => currentTime });
    const run = first.createRun(input('external-wait-credit'));
    first.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    const key = { runId: run.id, waitId: 'polar_checkout_wait' };
    const timestamps = { startedAt: 1_500, endedAt: 3_500 };

    expect(first.externalWaitCredit(key)).toBeNull();
    currentTime = 4_000;
    first.creditExternalWait({ ...key, ...timestamps });
    const runBeforeLookup = first.getRun(run.id);
    const eventsBeforeLookup = first.events({ runId: run.id, after: 0 });

    expect(first.externalWaitCredit(key)).toEqual(timestamps);
    expect(first.getRun(run.id)).toEqual(runBeforeLookup);
    expect(first.events({ runId: run.id, after: 0 })).toEqual(eventsBeforeLookup);
    first.close();

    const reopened = openRunStore({ path: databasePath, clock: () => currentTime });
    expect(reopened.externalWaitCredit(key)).toEqual(timestamps);
    expect(reopened.externalWaitCredit({ ...key, waitId: 'missing_wait' })).toBeNull();
    reopened.close();
  });

  it('scopes a wait credit to its owning run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paywallproof-external-wait-owner-'));
    directories.push(directory);
    let currentTime = 1_000;
    const store = openRunStore({
      path: join(directory, 'control.sqlite'),
      clock: () => currentTime,
    });
    const owner = store.createRun(input('external-wait-owner'));
    store.decidePlan({
      runId: owner.id,
      approvalId: owner.approval.id,
      bindingHash: owner.approval.bindingHash,
      decision: 'allow',
    });
    currentTime = 4_000;
    store.creditExternalWait({
      runId: owner.id,
      waitId: 'shared_wait_id',
      startedAt: 1_500,
      endedAt: 3_500,
    });
    const other = store.createRun(input('external-wait-other'));

    expect(store.externalWaitCredit({ runId: owner.id, waitId: 'shared_wait_id' })).toEqual({
      startedAt: 1_500,
      endedAt: 3_500,
    });
    expect(store.externalWaitCredit({ runId: other.id, waitId: 'shared_wait_id' })).toBeNull();
    expect(() =>
      store.externalWaitCredit({ runId: 'missing_run', waitId: 'shared_wait_id' }),
    ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));

    store.close();
  });
});

describe('durable operation recovery inventory', () => {
  it('persists canonical arguments and abandons a crashed dispatch exactly once', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paywallproof-operation-recovery-'));
    directories.push(directory);
    const databasePath = join(directory, 'control.sqlite');
    const first = openRunStore({ path: databasePath });
    const run = first.createRun(input('operation-recovery'));
    first.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    const args = { runId: run.id, operationId: 'crashed_create' };
    first.claimOperation({
      runId: run.id,
      operationId: 'crashed_create',
      kind: 'prepare_fixture',
      args,
      approvalId: run.approval.id,
      leaseMs: 30_000,
    });

    expect(first.operations({ runId: run.id, states: ['dispatched'] })).toEqual([
      expect.objectContaining({
        operationId: 'crashed_create',
        kind: 'prepare_fixture',
        state: 'dispatched',
        args,
      }),
    ]);
    first.close();

    const reopened = openRunStore({ path: databasePath });
    const before = reopened.events({ runId: run.id, after: 0 });
    expect(reopened.abandonDispatched({ runId: run.id })).toEqual([
      expect.objectContaining({ operationId: 'crashed_create', state: 'unknown', args }),
    ]);
    const afterFirstRecovery = reopened.events({ runId: run.id, after: 0 });
    expect(afterFirstRecovery).toHaveLength(before.length + 1);
    expect(afterFirstRecovery.at(-1)).toMatchObject({
      type: 'operation.unknown',
      payload: { operationId: 'crashed_create' },
    });
    expect(reopened.abandonDispatched({ runId: run.id })).toEqual([
      expect.objectContaining({ operationId: 'crashed_create', state: 'unknown', args }),
    ]);
    expect(reopened.events({ runId: run.id, after: 0 })).toHaveLength(afterFirstRecovery.length);
    reopened.close();
  });
});
