/** Synthetic child/report fixtures validate IPC only; none are oracle or product acceptance evidence. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPolicy, hashValue, type Verdict } from '#domain';
import {
  oracleExitCode,
  runRepairOracleProcess,
  validateOracleRoutes,
  type OracleProcessInput,
  type OracleProcessResult,
} from './oracle-process.ts';
import { SECURITY_CONTROLS } from './controls.ts';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
class SyntheticChild extends EventEmitter {
  pid = 87654321;
  stdout = new PassThrough();
  stderr = new PassThrough();
  sent: unknown[] = [];
  send(frame: unknown, callback: (error: Error | null) => void) {
    this.sent.push(frame);
    callback(null);
  }
  kill() {
    return true;
  }
}
let child: SyntheticChild,
  directory = '',
  request: OracleProcessInput,
  spawned: Promise<void>;
let ready: () => void = () => {};
const execute = promisify(execFile);
beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  await mkdir(join(process.cwd(), '.local'), { recursive: true });
  directory = await mkdtemp(join(process.cwd(), '.local/oracle-process-synthetic-'));
  child = new SyntheticChild();
  spawned = new Promise<void>((resolve) => {
    ready = resolve;
  });
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => {
      child.emit('spawn');
      ready();
    });
    return child;
  });
  const policy = createPolicy({
    schemaVersion: 2,
    priceId: 'price_synthetic',
    featureId: 'export',
    featureConfigHash: 'a'.repeat(64),
    cancellation: 'allow_until_period_end',
    requireInitialPaymentConfirmed: true,
    syncWindowSeconds: 5,
    predicateVersion: '1',
  });
  const billing = {
    livemode: false,
    identityResolved: true,
    noSubscriptionConfirmed: true,
    customerId: null,
    subscription: null,
  };
  request = {
    target: {
      origin: 'http://127.0.0.1:12345',
      adapterToken: '1'.repeat(64),
      replaySecret: '2'.repeat(64),
      webhookSecret: '3'.repeat(64),
      registerRoutes: vi.fn(),
    },
    plan: {
      schemaVersion: 2,
      mode: 'local_replay',
      runId: randomUUID(),
      policyHash: policy.hash,
      markers: { free: randomUUID(), paid: randomUUID() },
      states: { SC01: billing, SC02: billing, SC03: billing, SC04: billing },
    },
    policy,
    targetBuild: 'b'.repeat(40),
    databasePath: join(directory, 'evidence.sqlite'),
    artifactDirectory: join(directory, 'artifacts'),
    deadline: Date.now() + 5000,
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
function route(id: number, runId = request.plan.runId) {
  const base = `/staging/users/synthetic_${id}`;
  return {
    type: 'register',
    id,
    routes: [
      { method: 'POST', path: `${base}/customer` },
      { method: 'POST', path: `${base}/session` },
      { method: 'GET', path: `${base}/billing?runId=${runId}` },
      { method: 'DELETE', path: `${base}?runId=${runId}` },
    ],
  };
}
async function registered() {
  for (const id of [1, 2]) {
    child.emit('message', route(id));
    await vi.waitFor(() => expect(child.sent).toContainEqual({ type: 'ack', id }));
  }
}
function captureError<T>(promise: Promise<T>) {
  return promise.then(
    () => {
      throw new Error('EXPECTED_REJECTION');
    },
    (error: unknown) => error,
  );
}
function report(verdict: Verdict = 'pass'): OracleProcessResult {
  const observations: OracleProcessResult['observations'] = [];
  const scenarios = (['SC01', 'SC02', 'SC03', 'SC04'] as const).map((id) => {
    const observationIds = (
      ['billing_provider', 'application', 'api_probe', 'browser'] as const
    ).map((source) => {
      const observationId = randomUUID(),
        payload = { synthetic: true };
      observations.push({
        id: observationId,
        runId: request.plan.runId,
        scenarioId: id,
        subjectId: 'synthetic',
        source,
        policyHash: request.policy.hash,
        targetBuild: request.targetBuild,
        observedAt: Date.now(),
        billingTime: null,
        mode: 'local_replay',
        payload,
        sha256: hashValue(payload),
      });
      return observationId;
    });
    return {
      id,
      api: { verdict, code: 'SYNTHETIC' },
      browser: { verdict, code: 'SYNTHETIC' },
      state: { verdict, code: 'SYNTHETIC' },
      observationIds,
    };
  });
  const controls = SECURITY_CONTROLS.map((id) => ({
    id,
    outcome: 'pass' as const,
    expectedStatus: 401,
    actualStatus: 401,
    responseHash: 'a'.repeat(64),
    stateBeforeHash: 'b'.repeat(64),
    stateAfterHash: 'b'.repeat(64),
    observedAt: Date.now(),
  }));
  return {
    mode: 'local_replay',
    planHash: hashValue(request.plan),
    scenarios,
    controls,
    observations,
    artifacts: [],
    cleanup: [],
    completedAt: Date.now(),
  };
}
describe('oracle process IPC (synthetic implementation checks)', () => {
  it.each([
    { verdict: 'pass', code: 0 },
    { verdict: 'fail', code: 1 },
    { verdict: 'inconclusive', code: 2 },
  ] as const)(
    'returns actual close status for a matching $verdict report',
    async ({ verdict, code }) => {
      const running = runRepairOracleProcess(request);
      await spawned;
      await registered();
      child.emit('message', { type: 'result', result: report(verdict) });
      child.emit('close', code, null);
      expect(await running).toMatchObject({ exitCode: code, pid: child.pid });
      const call = mocks.spawn.mock.calls[0];
      expect(call?.[0]).toBe(process.execPath);
      expect(call?.[1]).toEqual([
        '--import',
        'tsx',
        join(process.cwd(), 'scripts/repair-oracle.ts'),
      ]);
      expect(JSON.stringify(call)).not.toContain(request.target.adapterToken);
      expect(child.sent[0]).toMatchObject({
        type: 'start',
        target: { adapterToken: request.target.adapterToken },
      });
    },
  );
  it('does not ACK until registration finishes and rejects a result arriving before its ACK', async () => {
    let release: () => void = () => {};
    request.target.registerRoutes = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const running = runRepairOracleProcess(request);
    const rejected = captureError(running);
    await spawned;
    child.emit('message', route(1));
    await Promise.resolve();
    expect(child.sent).toHaveLength(1);
    child.emit('message', { type: 'result', result: report() });
    child.emit('close', null, 'SIGTERM');
    release();
    expect(await rejected).toMatchObject({ message: 'ORACLE_PROCESS_FRAME_REJECTED' });
  });
  it('rejects a mismatched actual exit code', async () => {
    const running = runRepairOracleProcess(request);
    const rejected = captureError(running);
    await spawned;
    await registered();
    child.emit('message', { type: 'result', result: report() });
    child.emit('close', 1, null);
    expect(await rejected).toMatchObject({ message: 'ORACLE_PROCESS_EXIT_MISMATCH' });
  });
  it('rejects wrong-run routes without calling the registration callback', async () => {
    const running = runRepairOracleProcess(request);
    const rejected = captureError(running);
    await spawned;
    child.emit('message', route(1, randomUUID()));
    child.emit('close', null, 'SIGTERM');
    expect(await rejected).toMatchObject({ message: 'ORACLE_PROCESS_FRAME_REJECTED' });
    expect(request.target.registerRoutes).not.toHaveBeenCalled();
    expect(() =>
      validateOracleRoutes(
        { ...route(1), routes: [{ method: 'GET', path: 'http://outside/' }] },
        request.plan.runId,
      ),
    ).toThrow();
  });
  it('rejects altered observations even with a passing verdict', async () => {
    const running = runRepairOracleProcess(request);
    const rejected = captureError(running);
    await spawned;
    await registered();
    const result = report();
    result.observations[0]!.payload = { changed: true };
    child.emit('message', { type: 'result', result });
    child.emit('close', null, 'SIGTERM');
    expect(await rejected).toMatchObject({ message: 'ORACLE_PROCESS_FRAME_REJECTED' });
  });
  it('kills on deadline without manufacturing an inconclusive report', async () => {
    request.deadline = Date.now() + 150;
    const running = runRepairOracleProcess(request);
    const rejected = captureError(running);
    await spawned;
    await vi.waitFor(() => expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM'));
    child.emit('close', null, 'SIGTERM');
    expect(await rejected).toMatchObject({ message: 'ORACLE_PROCESS_TIMEOUT' });
  });
  it('rejects an already-aborted request before filesystem or process setup', async () => {
    const abort = new AbortController();
    abort.abort(new Error('synthetic pre-cancel'));
    request.signal = abort.signal;
    request.databasePath = '/tmp/outside.sqlite';
    await expect(runRepairOracleProcess(request)).rejects.toThrow('synthetic pre-cancel');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('kills the owned process group on explicit cancellation and removes its listener on close', async () => {
    const abort = new AbortController(),
      remove = vi.spyOn(abort.signal, 'removeEventListener');
    request.signal = abort.signal;
    const running = runRepairOracleProcess(request);
    const rejected = captureError(running);
    await spawned;
    expect(child.sent[0]).not.toHaveProperty('signal');
    abort.abort();
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    expect(await rejected).toMatchObject({ message: 'ORACLE_PROCESS_CANCELLED' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('bounds discarded stdout/stderr without returning their content', async () => {
    const running = runRepairOracleProcess(request);
    const rejected = captureError(running);
    await spawned;
    child.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1));
    child.emit('close', null, 'SIGTERM');
    expect(await rejected).toMatchObject({ message: 'ORACLE_PROCESS_OUTPUT_LIMIT' });
  });
  it('rejects duplicate scenarios and scope escape before spawn', async () => {
    const result = report();
    result.scenarios[1] = result.scenarios[0]!;
    expect(() => oracleExitCode(result)).toThrow('ORACLE_REPORT_REJECTED');
    request.databasePath = '/tmp/outside.sqlite';
    await expect(runRepairOracleProcess(request)).rejects.toThrow('ORACLE_OUTPUT_PATH_REJECTED');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('the real fixed child exits 2 without IPC and never invokes a target', async () => {
    await expect(
      execute(process.execPath, ['--import', 'tsx', 'scripts/repair-oracle.ts'], {
        cwd: process.cwd(),
        env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin' },
        timeout: 5000,
      }),
    ).rejects.toMatchObject({ code: 2, stdout: '', stderr: '' });
  });
});
