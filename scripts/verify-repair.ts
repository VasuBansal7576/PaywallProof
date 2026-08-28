import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parsePolicy } from '../packages/core/src/index.ts';
import { observationInputSchema } from '../packages/evidence/src/index.ts';
import { TrueForgeAdapter } from '../packages/adapters/src/trueforge.ts';
import { readRepairSource, collectRepairDependencies, REFERENCE_REPAIR_PATHS } from '../packages/repair/src/checkout.ts';
import { RepairSandboxRunner } from '../packages/repair/src/sandbox.ts';
import { createReferenceLauncher } from '../packages/repair/src/launcher.ts';
import { createRepairReplayPlan, oracleFingerprint } from '../packages/repair/src/oracle.ts';
import { runRepairOracleProcess } from '../packages/repair/src/oracle-process.ts';
import { RepairCoordinator } from '../apps/worker/src/repairs.ts';
import { assertRepairDiskCapacity } from '../packages/repair/src/capacity.ts';

// Explicit fault-injection acceptance test, not a production finding or payment.
// Only an isolated Git copy is changed. The generator never receives host tests.
const execute = promisify(execFile);
const root = process.cwd();
const directory = resolve(root, '.local', `full-repair-${randomUUID()}`);
const repositoryRoot = resolve(directory, 'repository');
await mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
const reportPath = resolve(directory, 'acceptance.json');
const report: Record<string, unknown> = { scope: 'isolated-fault-injection-acceptance', mode: 'local_replay', noProviderCalls: true, noPublication: true, generatorHasHostTests: false, startedAt: new Date().toISOString(), status: 'running' };
const save = async () => writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
const progress = async (phase: string) => { report.phase = phase; await save(); process.stdout.write(`${phase}\n`); };
const runtimeUrl = 'http://127.0.0.1:8790';
const model = 'paywallproof-local/qwen3-4b-instruct';
const runtime = new TrueForgeAdapter({ baseUrl: runtimeUrl, model, timeoutSeconds: 300 });
let sessionId: string | undefined;
let coordinator: RepairCoordinator | undefined;
try {
  await save();
  await assertRepairDiskCapacity([root, directory]);
  const archive = await execute('git', ['archive', '--format=tar', 'HEAD'], { cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  await writeFile(resolve(directory, 'source.tar'), archive.stdout, { mode: 0o600 });
  await execute('tar', ['-xf', resolve(directory, 'source.tar'), '-C', repositoryRoot]);
  const sourcePath = resolve(repositoryRoot, 'packages/reference/src/index.ts');
  const source = await readFile(sourcePath, 'utf8');
  const original = "return user.status === 'active' && user.price_id === priceId && user.initial_payment_confirmed === 1;";
  if (source.split(original).length !== 2) throw new Error('FAULT_INJECTION_LOCATION_MISMATCH');
  await writeFile(sourcePath, source.replace(original, "return user.status === 'active' && user.price_id === priceId && user.initial_payment_confirmed === 1 && user.cancel_at_period_end === 0;"));
  await execute('git', ['init', '-b', 'acceptance-fault'], { cwd: repositoryRoot });
  await execute('git', ['remote', 'add', 'origin', 'https://github.com/VasuBansal7576/PaywallProof.git'], { cwd: repositoryRoot });
  await execute('git', ['add', '.'], { cwd: repositoryRoot });
  await execute('git', ['-c', 'user.name=PaywallProof Acceptance', '-c', 'user.email=acceptance@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Isolated acceptance fixture: deny scheduled cancellation incorrectly'], { cwd: repositoryRoot });
  const baseCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  await symlink(resolve(root, 'node_modules'), resolve(repositoryRoot, 'node_modules'), 'dir');
  report.faultBuild = baseCommit;
  report.fault = 'Isolated fixture incorrectly denies export while cancellation is scheduled but the paid period remains active.';
  const input = z.object({ run: z.object({ id: z.string(), targetBuild: z.string(), policy: z.unknown() }), observations: z.array(observationInputSchema.extend({ id: z.string(), sha256: z.string() })) }).parse(JSON.parse(await readFile(resolve(root, '.local/local-workflow-report.json'), 'utf8')));
  const policy = parsePolicy(input.run.policy);
  const plan = createRepairReplayPlan({ runId: input.run.id, targetBuild: input.run.targetBuild, policy, observations: input.observations });
  const oracle = await oracleFingerprint(root);
  if ((await oracleFingerprint(repositoryRoot)).hash !== oracle.hash) throw new Error('ORACLE_COPY_MISMATCH');
  report.oracle = oracle;
  report.seedRunId = input.run.id;
  report.baselineRunId = plan.runId;
  await progress('packaging-isolated-reference');
  const checkout = await readRepairSource({ repositoryRoot, repository: 'VasuBansal7576/PaywallProof', baseCommit });
  const dependencies = await collectRepairDependencies(root);
  const launcher = createReferenceLauncher({ buildId: baseCommit, priceId: policy.priceId });
  const files = [...checkout.files, ...dependencies.files, launcher.file];
  report.dependencyBytes = dependencies.totalBytes;
  const session = await runtime.createSession({ instructions: 'You are executing a bounded local-only application repair acceptance test. Follow the supplied command and attachment instructions exactly. Do not use network services, install packages or publish anything. Attachment messages only need an acknowledgment. Exact exec requests must use the exact command with no cwd or environment overrides. For a repair preparation request, inspect only the supplied application files and fix the observed access-policy contradiction. Host tests and evaluator are intentionally unavailable.', sandbox: true, iterationLimit: 15, maxTokens: 4096 });
  sessionId = session.id;
  const initial = await runtime.beginTurn({ sessionId, input: 'Reply READY. Do not call tools.' });
  for await (const event of await runtime.resumeStream({ sessionId, turnId: initial.id, signal: AbortSignal.timeout(120_000) })) { void event; }
  const runner = new RepairSandboxRunner({ baseUrl: runtimeUrl, model, commandTimeoutSeconds: 420, operationTimeoutSeconds: 900 });
  const deadline = Date.now() + 850_000;
  let observed: Awaited<ReturnType<typeof runRepairOracleProcess>> | undefined;
  await progress('executing-real-failing-baseline');
  const baseline = await runner.run({ sessionId, previousTurnId: initial.id, files, allowedPaths: REFERENCE_REPAIR_PATHS, fixedCommand: launcher.fixedCommand, signal: AbortSignal.timeout(850_000),
    onState: async state => { report.runtimeState = state; await save(); process.stdout.write(`baseline:${state.phase}\n`); },
    target: { routes: [{ method: 'GET', path: '/staging/describe' }, { method: 'POST', path: '/staging/users' }, { method: 'POST', path: '/staging/replay' }, { method: 'GET', path: '/api/me' }, { method: 'GET', path: '/api/export' }, { method: 'GET', path: '/dashboard' }], allowNextStatic: true,
      onReady: async target => { observed = await runRepairOracleProcess({ target, plan, policy, targetBuild: baseCommit, databasePath: resolve(directory, 'failing-baseline.sqlite'), artifactDirectory: resolve(directory, 'artifacts'), deadline, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }); await writeFile(resolve(directory, 'failing-oracle.json'), JSON.stringify(observed, null, 2), { mode: 0o600 }); return observed; },
    },
  });
  if (!observed || observed.exitCode !== 1 || observed.result.scenarios.find(scenario => scenario.id === 'SC03')?.api.verdict !== 'fail') throw new Error('INJECTED_FAILURE_NOT_OBSERVED');
  await writeFile(resolve(directory, 'failing-baseline.json'), JSON.stringify({ execution: baseline, oracle: observed }, null, 2), { mode: 0o600 });
  report.baseline = { exitCode: observed.exitCode, scenarios: observed.result.scenarios, cleanup: observed.result.cleanup };
  const failing = observed;
  const documents = new Map<string, Map<string, unknown>>();
  coordinator = new RepairCoordinator({ repositoryRoot, repository: 'VasuBansal7576/PaywallProof', databasePath: resolve(directory, 'repairs.sqlite'), artifactDirectory: resolve(directory, 'artifacts'), runtimeUrl, model, webOrigin: 'http://127.0.0.1:3000',
    documents: { put: (kind, id, value) => { const collection = documents.get(kind) ?? new Map<string, unknown>(); collection.set(id, structuredClone(value)); documents.set(kind, collection); }, get: (kind, id) => documents.get(kind)?.get(id) ?? null, list: kind => [...(documents.get(kind)?.values() ?? [])] },
    source: async runId => { if (runId !== plan.runId) throw new Error('ACCEPTANCE_RUN_MISMATCH'); return { runId, baseCommit, policy, oracleHash: oracle.hash, scenarios: failing.result.scenarios, observations: failing.result.observations, runtime: { sessionId: baseline.sessionId, turnId: baseline.lastTurnId } }; },
  });
  await progress('generating-and-verifying-repair');
  const job = await coordinator.start(plan.runId, { findingId: 'SC03:api' });
  let previous = '';
  for (;;) {
    const current = coordinator.view(plan.runId).find(value => value.id === job.id);
    if (!current) throw new Error('ACCEPTANCE_JOB_MISSING');
    report.job = current;
    await save();
    const state = `${current.state}:${current.runtimeOperations.at(-1)?.phase ?? 'waiting'}`;
    if (state !== previous) { process.stdout.write(`repair:${state}\n`); previous = state; }
    if (current.state === 'abandoned') throw new Error(current.error ?? 'REPAIR_ABANDONED');
    if (current.state === 'verified_local') {
      if ((await oracleFingerprint(root)).hash !== oracle.hash || (await oracleFingerprint(repositoryRoot)).hash !== oracle.hash) throw new Error('ORACLE_CHANGED');
      report.status = 'passed'; break;
    }
    if (Date.now() > job.deadline + 5000) throw new Error('ACCEPTANCE_JOB_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : 'UNKNOWN_FAILURE';
  if (error && typeof error === 'object' && 'runtime' in error) report.runtimeFailure = error.runtime;
  process.exitCode = 1;
} finally {
  coordinator?.close();
  if (sessionId) await runtime.cancel({ sessionId }).catch(() => {});
  report.finishedAt = new Date().toISOString(); await save();
  process.stdout.write(JSON.stringify({ status: report.status, phase: report.phase, error: report.error, reportPath }) + '\n');
}
