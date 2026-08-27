import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { z } from 'zod';
import { hashValue, parseJson, parsePolicy, policySchema, verdictSchema } from '../../core/src/index.ts';
import { observationInputSchema } from '../../evidence/src/index.ts';
import { planSchema, type runRepairOracle } from './oracle.ts';
import type { SandboxTargetReady } from './sandbox.ts';
import {SECURITY_CONTROLS,securityControlSchema} from './controls.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LIMIT = 8 * 1024 * 1024;
const SCENARIOS = ['SC01', 'SC02', 'SC03', 'SC04'] as const;
const token = z.string().regex(/^[a-f0-9]{64}$/);
const boundedId = z.string().min(1).max(200);
const originSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
});
export const oracleProcessStartSchema = z.strictObject({ type: z.literal('start'), target: z.strictObject({ origin: originSchema, adapterToken: token, replaySecret: token, webhookSecret: token }),
  plan: planSchema, policy: policySchema, targetBuild: z.string().regex(/^[a-f0-9]{40}$/), databasePath: z.string().max(2000), artifactDirectory: z.string().max(2000), deadline: z.number().int().positive() });
export type OracleProcessStart = z.infer<typeof oracleProcessStartSchema>;
const probe = z.strictObject({ verdict: verdictSchema, code: boundedId });
const observation = observationInputSchema.extend({ id: boundedId, sha256: token });
export const oracleProcessResultSchema = z.strictObject({ mode: z.literal('local_replay'), planHash: token,
  controls:z.array(securityControlSchema).length(SECURITY_CONTROLS.length),
  scenarios: z.array(z.strictObject({ id: z.enum(SCENARIOS), api: probe, browser: probe, state: probe, observationIds: z.array(boundedId).min(4).max(8) })).length(4),
  observations: z.array(observation).max(10000),
  artifacts: z.array(z.strictObject({ id: z.string().regex(/^[a-f0-9-]{36}\.png$/), sha256: token, contentType: z.literal('image/png'), source: z.literal('browser'), collectedAt: z.string().datetime(), runId: z.string().uuid(), observationId: boundedId })).max(1000),
  cleanup: z.array(z.strictObject({ resourceId: boundedId, status: z.enum(['deleted', 'leftover']) })).max(2), completedAt: z.number().int().positive(),
});
export const oracleRouteFrameSchema = z.strictObject({ type: z.literal('register'), id: z.number().int().positive().max(2), routes: z.array(z.strictObject({ method: z.enum(['GET', 'POST', 'DELETE']), path: z.string().max(500) })).length(4) });
export const oracleAckSchema = z.strictObject({ type: z.literal('ack'), id: z.number().int().positive().max(2) });
const resultFrame = z.strictObject({ type: z.literal('result'), result: oracleProcessResultSchema });
const errorFrame = z.strictObject({ type: z.literal('error'), code: z.literal('ORACLE_FAILED') });
const frameSchema = z.discriminatedUnion('type', [oracleRouteFrameSchema, resultFrame, errorFrame]);
export type OracleProcessResult = Awaited<ReturnType<typeof runRepairOracle>>;
export type OracleProcessInput = Omit<Parameters<typeof runRepairOracle>[0], 'signal' | 'target'> & { target: SandboxTargetReady; deadline: number; signal?: AbortSignal };

export function oracleExitCode(result: OracleProcessResult): 0 | 1 | 2 {
  const report = oracleProcessResultSchema.parse(parseJson(result));
  if (new Set(report.scenarios.map(item => item.id)).size !== 4||new Set(report.controls.map(item=>item.id)).size!==SECURITY_CONTROLS.length) throw new Error('ORACLE_REPORT_REJECTED');
  const verdicts = report.scenarios.flatMap(item => [item.api.verdict, item.browser.verdict, item.state.verdict]);
  return verdicts.includes('fail')||report.controls.some(item=>item.outcome==='fail') ? 1 : verdicts.every(verdict => verdict === 'pass') ? 0 : 2;
}

export function validateOracleRoutes(value: unknown, runId: string) {
  const frame = oracleRouteFrameSchema.parse(parseJson(value));
  const principal = /^\/staging\/users\/([A-Za-z0-9_-]{1,150})\/customer$/.exec(frame.routes[0]?.path ?? '')?.[1];
  if (!principal) throw new Error('ORACLE_ROUTE_REJECTED');
  const base = `/staging/users/${principal}`;
  const expected = [{ method: 'POST', path: `${base}/customer` }, { method: 'POST', path: `${base}/session` }, { method: 'GET', path: `${base}/billing?runId=${runId}` }, { method: 'DELETE', path: `${base}?runId=${runId}` }];
  if (hashValue(frame.routes) !== hashValue(expected)) throw new Error('ORACLE_ROUTE_REJECTED');
  return frame;
}

export function validateOracleReport(value: unknown, input: OracleProcessStart, startedAt: number): OracleProcessResult {
  const report = oracleProcessResultSchema.parse(parseJson(value));
  if (report.planHash !== hashValue(input.plan) || report.completedAt < startedAt || report.completedAt > Math.min(input.deadline, Date.now() + 1000)) throw new Error('ORACLE_REPORT_REJECTED');
  oracleExitCode(report);
  for(const control of report.controls){
    if(control.observedAt<startedAt||control.observedAt>report.completedAt||(control.outcome==='pass')!==(control.actualStatus===control.expectedStatus&&control.stateBeforeHash===control.stateAfterHash))throw new Error('ORACLE_REPORT_REJECTED');
  }
  const observations = new Map(report.observations.map(item => [item.id, item]));
  if (observations.size !== report.observations.length) throw new Error('ORACLE_REPORT_REJECTED');
  for (const item of report.observations) {
    if (item.runId !== input.plan.runId || item.mode !== 'local_replay' || item.policyHash !== input.policy.hash || item.targetBuild !== input.targetBuild || item.sha256 !== hashValue(item.payload)) throw new Error('ORACLE_REPORT_REJECTED');
  }
  for (const scenario of report.scenarios) {
    if (new Set(scenario.observationIds).size !== scenario.observationIds.length) throw new Error('ORACLE_REPORT_REJECTED');
    for (const id of scenario.observationIds) if (observations.get(id)?.scenarioId !== scenario.id) throw new Error('ORACLE_REPORT_REJECTED');
    for (const source of ['stripe', 'application', 'api_probe', 'browser']) if (!scenario.observationIds.some(id => observations.get(id)?.source === source)) throw new Error('ORACLE_REPORT_REJECTED');
  }
  for (const artifact of report.artifacts) if (artifact.runId !== input.plan.runId || observations.get(artifact.observationId)?.source !== 'browser') throw new Error('ORACLE_REPORT_REJECTED');
  return report;
}

/** Enforce a host-owned output root; sandbox/model paths never reach SQLite or artifact writes. */
export async function validateOracleOutputPaths(databasePath: string, artifactDirectory: string) {
  const outputRoot = resolve(ROOT, '.local');
  for (const destination of [databasePath, artifactDirectory]) {
    const rel = relative(outputRoot, destination);
    if (!isAbsolute(destination) || resolve(destination) !== destination || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('ORACLE_OUTPUT_PATH_REJECTED');
    let cursor = ROOT;
    for (const part of relative(ROOT, destination).split(sep)) {
      cursor = join(cursor, part);
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('ORACLE_OUTPUT_PATH_REJECTED'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
  }
  if (databasePath === artifactDirectory) throw new Error('ORACLE_OUTPUT_PATH_REJECTED');
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  if (await realpath(dirname(databasePath)) !== dirname(databasePath) || await realpath(artifactDirectory) !== artifactDirectory) throw new Error('ORACLE_OUTPUT_PATH_REJECTED');
}

/** Fixed trusted child only. Credentials/plan travel on IPC, never argv, env or logs. */
export async function runRepairOracleProcess(input: OracleProcessInput): Promise<{ result: OracleProcessResult; exitCode: 0 | 1 | 2; pid: number }> {
  input.signal?.throwIfAborted();
  const startedAt = Date.now();
  const start = oracleProcessStartSchema.parse({ type: 'start', target: { origin: input.target.origin, adapterToken: input.target.adapterToken, replaySecret: input.target.replaySecret, webhookSecret: input.target.webhookSecret }, plan: input.plan,
    policy: parsePolicy(input.policy), targetBuild: input.targetBuild, databasePath: input.databasePath, artifactDirectory: input.artifactDirectory, deadline: input.deadline });
  if (start.plan.policyHash !== start.policy.hash || start.deadline <= startedAt || start.deadline - startedAt > 900_000 || Buffer.byteLength(JSON.stringify(start)) > LIMIT) throw new Error('ORACLE_INPUT_REJECTED');
  input.signal?.throwIfAborted();
  await validateOracleOutputPaths(start.databasePath, start.artifactDirectory);
  input.signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/repair-oracle.ts')], { cwd: ROOT, detached: true, serialization: 'json',
      env: { NODE_ENV: 'test', PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: homedir(), TMPDIR: tmpdir(), NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let failure: Error | undefined, result: OracleProcessResult | undefined, bytes = 0, registration = 0, awaitingRegistration = false, closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } } };
    const fail = (code: string) => {
      if (failure || closed) return;
      failure = new Error(code); kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 500);
    };
    const deadlineTimer = setTimeout(() => fail('ORACLE_PROCESS_TIMEOUT'), Math.max(1, start.deadline - Date.now()));
    const onAbort = () => fail('ORACLE_PROCESS_CANCELLED');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    const count = (size: number) => { bytes += size; if (bytes > LIMIT) fail('ORACLE_PROCESS_OUTPUT_LIMIT'); };
    child.stdout?.on('data', (chunk: Buffer) => count(chunk.byteLength));
    child.stderr?.on('data', (chunk: Buffer) => count(chunk.byteLength));
    child.on('error', () => fail('ORACLE_PROCESS_START_FAILED'));
    child.on('message', (raw: unknown) => {
      if (failure || closed) return;
      try {
        count(Buffer.byteLength(JSON.stringify(raw))); if (failure) return;
        const frame = frameSchema.parse(parseJson(raw));
        if (frame.type === 'error') { fail('ORACLE_PROCESS_FAILED'); return; }
        if (frame.type === 'result') {
          if (result || awaitingRegistration || registration !== 2) throw new Error('unexpected result');
          result = validateOracleReport(frame.result, start, startedAt); return;
        }
        if (result || awaitingRegistration || frame.id !== registration + 1) throw new Error('unexpected registration');
        const request = validateOracleRoutes(frame, start.plan.runId);
        awaitingRegistration = true;
        void Promise.resolve().then(() => input.target.registerRoutes(request.routes)).then(() => {
          if (failure || closed) return;
          registration = request.id; awaitingRegistration = false;
          child.send({ type: 'ack', id: request.id }, error => { if (error) fail('ORACLE_PROCESS_IPC_FAILED'); });
        }).catch(() => fail('ORACLE_ROUTE_REGISTRATION_FAILED'));
      } catch { fail('ORACLE_PROCESS_FRAME_REJECTED'); }
    });
    child.once('spawn', () => {
      if (failure) { kill('SIGTERM'); return; }
      if (input.signal?.aborted) { onAbort(); return; }
      child.send(start, error => { if (error) fail('ORACLE_PROCESS_IPC_FAILED'); });
    });
    child.once('close', (code, signal) => {
      closed = true; clearTimeout(deadlineTimer);
      input.signal?.removeEventListener('abort', onAbort);
      if (killTimer) { clearTimeout(killTimer); kill('SIGKILL'); }
      if (failure) { reject(failure); return; }
      if (!child.pid || !result || signal || code !== oracleExitCode(result) || Date.now() > start.deadline) { reject(new Error('ORACLE_PROCESS_EXIT_MISMATCH')); return; }
      if (code !== 0 && code !== 1 && code !== 2) { reject(new Error('ORACLE_PROCESS_EXIT_MISMATCH')); return; }
      resolveResult({ result, exitCode: code, pid: child.pid });
    });
  });
}
