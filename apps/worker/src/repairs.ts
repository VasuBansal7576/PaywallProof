import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { hashValue, type AccessPolicy } from '#domain';
import { type EvidenceEvaluation, type Observation } from '#evidence';
import { TrueForgeAdapter } from '#integrations/trueforge';
import {
  openRepairStore,
  repairBranch,
  patchHash,
  RepairError,
  GitHubPublicationAdapter,
  publishRepair,
  type RepairRecord,
} from '#repair';
import { branchSchema } from '#repair/model';
import {
  readRepairSource,
  collectRepairDependencies,
  REFERENCE_REPAIR_PATHS,
} from '#repair/checkout';
import { RepairSandboxRunner, type SandboxFile, type SandboxRuntimeState } from '#repair/sandbox';
import { createReferenceLauncher } from '#repair/launcher';
import { oracleFingerprint, createRepairReplayPlan, CORE_SCENARIOS } from '#repair/oracle';
import { runRepairOracleProcess } from '#repair/oracle-process';
import { SECURITY_CONTROLS } from '#repair/controls';
import {
  assertRepairDestinationCapacity,
  assertRepairDiskCapacity,
  REPAIR_MIN_FREE_BYTES,
} from '#repair/capacity';
import { isUnexecutedRuntimeFailure } from '#repair/runtime-continuation';

const execute = promisify(execFile);
type ScenarioId = (typeof CORE_SCENARIOS)[number];
type Channel = 'api' | 'browser' | 'state';
export type RepairSource = {
  runId: string;
  baseCommit: string;
  policy: AccessPolicy;
  oracleHash: string;
  scenarios: (EvidenceEvaluation & { id: ScenarioId })[];
  observations: Observation[];
  runtime: { sessionId: string; turnId: string };
};
export type RepairJob = {
  id: string;
  runId: string;
  findingId: string;
  attempt: 1 | 2;
  createdAt: number;
  deadline: number;
  state: 'preparing' | 'testing' | 'verified_local' | 'abandoned';
  sessionId: string;
  turnId: string;
  proposalId: string | null;
  error: string | null;
  runtimeOperations: SandboxRuntimeState[];
  checks: unknown[];
};
type Documents = {
  put: (kind: string, id: string, value: unknown) => void;
  get: (kind: string, id: string) => unknown;
  list: (kind: string) => unknown[];
};
const jobSchema = z.object({
  id: z.string().uuid(),
  runId: z.string(),
  findingId: z.string(),
  attempt: z.union([z.literal(1), z.literal(2)]),
  createdAt: z.number(),
  deadline: z.number(),
  state: z.enum(['preparing', 'testing', 'verified_local', 'abandoned']),
  sessionId: z.string(),
  turnId: z.string(),
  proposalId: z.string().nullable(),
  error: z.string().nullable(),
  runtimeOperations: z.array(
    z.object({
      sessionId: z.string(),
      operationId: z.string(),
      phase: z.enum(['transfer', 'execute', 'prepare']),
      turnId: z.string().nullable(),
      previousTurnId: z.string(),
    }),
  ),
  checks: z.array(z.unknown()),
});
const publicationRuntimeSchema = z.object({
  sessionId: z.string(),
  turnId: z.string(),
  approvalId: z.string(),
  status: z.enum(['running', 'approval', 'done', 'error']),
  error: z.string().optional(),
});
const publicationIntentSchema = z.object({
  previousTurnId: z.string(),
  approvalId: z.string(),
  at: z.number(),
  decision: z.enum(['allow', 'deny']).optional(),
});
type Config = {
  repositoryRoot: string;
  repository: string;
  databasePath: string;
  artifactDirectory: string;
  runtimeUrl: string;
  model: string;
  webOrigin: string;
  documents: Documents;
  source: (runId: string) => Promise<RepairSource>;
};

/** Owns repair execution. HTTP/model input can select a finding, never supply verification. */
export class RepairCoordinator {
  readonly store: ReturnType<typeof openRepairStore>;
  private readonly active = new Map<string, AbortController>();
  private readonly starting = new Set<string>();
  private closed = false;
  private readonly publicationLocks = new Set<string>();
  private readonly publicationWatchers = new Map<string, AbortController>();
  private readonly runtime: TrueForgeAdapter;
  constructor(private readonly config: Config) {
    this.store = openRepairStore({
      path: config.databasePath,
      repository: config.repository,
      allowedPaths: REFERENCE_REPAIR_PATHS,
      requiredRegressionChecks: [...CORE_SCENARIOS, ...SECURITY_CONTROLS],
    });
    this.runtime = new TrueForgeAdapter({ baseUrl: config.runtimeUrl, model: config.model });
  }
  private save(job: RepairJob) {
    if (this.closed) return;
    this.config.documents.put(`repair-job:${job.runId}`, job.id, job);
    this.config.documents.put('repair-job-index', job.id, { runId: job.runId, id: job.id });
  }
  jobs(runId: string) {
    return this.config.documents.list(`repair-job:${runId}`).map((value) => jobSchema.parse(value));
  }
  view(runId: string) {
    return this.jobs(runId).map((job) => ({
      ...job,
      proposal: job.proposalId ? this.store.get(job.proposalId) : null,
      publicationRuntime: this.config.documents.get('repair-publication-runtime', job.id),
      mode: 'local_replay',
    }));
  }
  async start(runId: string, input: unknown) {
    if (this.closed) throw new RepairError('REPAIR_WORKER_CLOSED');
    if (this.starting.has(runId)) throw new RepairError('REPAIR_IN_FLIGHT');
    this.starting.add(runId);
    try {
      const request = z
        .strictObject({
          findingId: z
            .string()
            .regex(/^SC0[1-4]:(api|browser|state)$/)
            .optional(),
        })
        .parse(input);
      const source = await this.config.source(runId),
        jobs = this.jobs(runId);
      if (jobs.some((job) => ['preparing', 'testing'].includes(job.state)))
        throw new RepairError('REPAIR_IN_FLIGHT');
      if (jobs.length >= 2) throw new RepairError('REPAIR_ATTEMPT_LIMIT');
      const failures = source.scenarios.flatMap((scenario) =>
        (['api', 'browser', 'state'] as const)
          .filter((channel) => scenario[channel].verdict === 'fail')
          .map((channel) => ({
            id: `${scenario.id}:${channel}`,
            scenarioId: scenario.id,
            channel,
            code: scenario[channel].code,
          })),
      );
      const finding = request.findingId
        ? failures.find((item) => item.id === request.findingId)
        : failures[0];
      if (!finding) throw new RepairError('REPAIR_REQUIRES_CONFIRMED_FAILURE');
      // Reject before consuming an attempt, loading dependencies or starting a turn.
      await assertRepairDiskCapacity([this.config.repositoryRoot]);
      await assertRepairDestinationCapacity(this.config.artifactDirectory, REPAIR_MIN_FREE_BYTES);
      await assertRepairDestinationCapacity(
        resolve(homedir(), 'Library', 'Application Support', 'trueforge', 'sandboxes'),
        REPAIR_MIN_FREE_BYTES,
      );
      await this.checkOracle(source.oracleHash);
      const latest = jobs.sort((a, b) => b.createdAt - a.createdAt)[0];
      const runtime = latest
        ? { sessionId: latest.sessionId, turnId: latest.turnId }
        : source.runtime;
      const turn = await this.runtime.inspectTurn(runtime);
      const recoverable =
        latest &&
        turn.state.status === 'error' &&
        isUnexecutedRuntimeFailure(turn, await this.runtime.listTurnEvents(runtime));
      if (!recoverable && (turn.state.status !== 'done' || turn.state.requiredActions.length))
        throw new RepairError('REPAIR_RUNTIME_BUSY');
      // Each explicit owner repair request authorizes one new bounded local-only job.
      // It never renews the original run's billing scope or recreates provider objects.
      const createdAt = Date.now();
      const job: RepairJob = {
        id: randomUUID(),
        runId,
        findingId: finding.id,
        attempt: jobs.length === 0 ? 1 : 2,
        createdAt,
        deadline: createdAt + 900_000,
        state: 'preparing',
        sessionId: runtime.sessionId,
        turnId: runtime.turnId,
        proposalId: null,
        error: null,
        runtimeOperations: [],
        checks: [],
      };
      this.save(job);
      const abort = new AbortController();
      this.active.set(job.id, abort);
      void this.perform(
        job,
        source,
        finding,
        AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(Math.max(1, job.deadline - Date.now())),
        ]),
      )
        .catch((error) => {
          job.state = 'abandoned';
          job.error =
            error instanceof RepairError
              ? error.code
              : error instanceof Error && /^[A-Z_]+$/.test(error.message)
                ? error.message
                : 'REPAIR_EXECUTION_FAILED';
          this.save(job);
        })
        .finally(() => this.active.delete(job.id));
      return job;
    } finally {
      this.starting.delete(runId);
    }
  }
  private async checkOracle(expected: string) {
    if ((await oracleFingerprint(this.config.repositoryRoot)).hash !== expected)
      throw new RepairError('REPAIR_ORACLE_CHANGED');
  }
  private async perform(
    job: RepairJob,
    source: RepairSource,
    finding: { scenarioId: ScenarioId; channel: Channel; code: string },
    signal: AbortSignal,
  ) {
    const plan = createRepairReplayPlan({
      runId: source.runId,
      targetBuild: source.baseCommit,
      policy: source.policy,
      observations: source.observations,
    });
    const checkout = await readRepairSource({
      repositoryRoot: this.config.repositoryRoot,
      repository: this.config.repository,
      baseCommit: source.baseCommit,
    });
    const dependencies = await collectRepairDependencies(this.config.repositoryRoot);
    const launcher = createReferenceLauncher({
      buildId: source.baseCommit,
      priceId: source.policy.priceId,
    });
    const baseline: SandboxFile[] = [...checkout.files, ...dependencies.files, launcher.file];
    const runner = new RepairSandboxRunner({
      baseUrl: this.config.runtimeUrl,
      model: this.config.model,
      commandTimeoutSeconds: 420,
      operationTimeoutSeconds: 900,
    });
    const directory = resolve(this.config.repositoryRoot, '.local', 'repairs', job.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(resolve(directory, 'replay-plan.json'), JSON.stringify(plan, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    const onState = async (state: SandboxRuntimeState) => {
      signal.throwIfAborted();
      await this.checkOracle(source.oracleHash);
      job.runtimeOperations.push(state);
      if (state.turnId) job.turnId = state.turnId;
      this.save(job);
    };
    const billing = plan.states[finding.scenarioId];
    const subscription = billing.subscription;
    // Only observed billing facts, never fixture identities or evaluator source.
    const observedBilling = {
      livemode: billing.livemode,
      identityResolved: billing.identityResolved,
      noSubscriptionConfirmed: billing.noSubscriptionConfirmed,
      subscription: subscription
        ? {
            status: subscription.status,
            priceId: subscription.priceId,
            initialPaymentConfirmed: subscription.initialPaymentConfirmed,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            periodEnd: subscription.periodEnd,
            billingTime: subscription.billingTime,
          }
        : null,
    };
    const prepared = await runner.prepare({
      sessionId: job.sessionId,
      previousTurnId: job.turnId,
      files: baseline,
      allowedPaths: REFERENCE_REPAIR_PATHS,
      signal,
      onState,
      instructions: `Repair the observed ${job.findingId} failure ${finding.code}. The original policy is ${JSON.stringify(source.policy)}. The recorded failing scenario is ${JSON.stringify(source.scenarios.find((scenario) => scenario.id === finding.scenarioId))}. The billing facts recorded for this scenario are ${JSON.stringify(observedBilling)}. Inspect the supplied application source and make a minimal correction. Preserve authentication, signature verification, customer/run identity, all existing protection and unsupported cases. Do not hardcode fixture identities. Do not edit dependencies, launchers, tests, policy or evaluator. Do not access external hosts, install software, merge or deploy. Test results will be collected outside your writable workspace. Explain the changed behavior briefly; explanations are not verification.`,
    });
    job.turnId = prepared.lastTurnId;
    signal.throwIfAborted();
    const changes = prepared.files.flatMap((file) => {
      const before = checkout.files.find((original) => original.path === file.path);
      if (!before || Buffer.from(before.bytes).equals(Buffer.from(file.bytes))) return [];
      const content = Buffer.from(file.bytes).toString('utf8');
      if (content.includes('\0') || !Buffer.from(content).equals(Buffer.from(file.bytes)))
        throw new RepairError('REPAIR_SOURCE_ENCODING');
      return [{ path: file.path, content }];
    });
    if (!changes.length) throw new RepairError('EMPTY_REPAIR_DIFF');
    const baseBranch = branchSchema.parse(
      (
        await execute(
          'git',
          ['-C', this.config.repositoryRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
          { encoding: 'utf8', timeout: 10000 },
        )
      ).stdout.trim(),
    );
    const proposalAttempt =
      this.store.list(job.runId).filter((record) => record.proposal.findingId === job.findingId)
        .length === 0
        ? 1
        : 2;
    const proposal = this.store.propose({
      runId: job.runId,
      findingId: job.findingId,
      attempt: proposalAttempt,
      baseCommit: source.baseCommit,
      baseBranch,
      repository: this.config.repository,
      branch: repairBranch(job.runId, job.findingId, proposalAttempt),
      policyHash: source.policy.hash,
      oracleHash: source.oracleHash,
      allowedPaths: REFERENCE_REPAIR_PATHS,
      changes,
      diffHash: patchHash(changes),
      verificationMode: 'local_replay',
      failureCode: finding.code,
      summary: `Generated application changes for the recorded ${job.findingId} contradiction. Source-code cause remains unverified until the unchanged reproduction passes.`,
      reportUrl: new URL(`/runs/${job.runId}`, this.config.webOrigin).href,
    });
    job.proposalId = proposal.id;
    job.state = 'testing';
    this.save(job);
    const executeTarget = async (label: 'before' | 'after', files: SandboxFile[]) => {
      signal.throwIfAborted();
      await this.checkOracle(source.oracleHash);
      let observed: Awaited<ReturnType<typeof runRepairOracleProcess>> | undefined;
      const result = await runner.run({
        sessionId: job.sessionId,
        previousTurnId: job.turnId,
        files,
        allowedPaths: REFERENCE_REPAIR_PATHS,
        fixedCommand: launcher.fixedCommand,
        signal,
        onState,
        target: {
          routes: [
            { method: 'GET', path: '/staging/describe' },
            { method: 'POST', path: '/staging/users' },
            { method: 'POST', path: '/staging/replay' },
            { method: 'GET', path: '/api/me' },
            { method: 'GET', path: '/api/export' },
            { method: 'GET', path: '/dashboard' },
          ],
          allowNextStatic: true,
          onReady: async (target) => {
            observed = await runRepairOracleProcess({
              target,
              plan,
              policy: source.policy,
              targetBuild: source.baseCommit,
              databasePath: resolve(directory, `${label}.sqlite`),
              artifactDirectory: this.config.artifactDirectory,
              deadline: job.deadline,
              signal,
            });
            return observed;
          },
        },
      });
      if (!observed) throw new RepairError('REPAIR_OBSERVATIONS_MISSING');
      job.turnId = result.lastTurnId;
      await this.checkOracle(source.oracleHash);
      const execution = {
        runtime: {
          sessionId: result.sessionId,
          operationId: result.operationId,
          turnIds: result.turnIds,
          execReceipts: result.execReceipts,
          transferArchiveHash: result.transferArchiveHash,
          baselineBindings: result.baselineBindings,
          candidateBindings: result.candidateBindings,
        },
        ...observed,
      };
      await writeFile(resolve(directory, `${label}.json`), JSON.stringify(execution, null, 2), {
        mode: 0o600,
        flag: 'wx',
      });
      job.checks.push({
        phase: label,
        artifactHash: hashValue(execution),
        exitCode: observed.exitCode,
        scenarios: observed.result.scenarios,
        controls: observed.result.controls,
        observations: observed.result.observations,
        artifacts: observed.result.artifacts,
        runtime: execution.runtime,
      });
      this.save(job);
      for (const artifact of observed.result.artifacts) {
        const record = z.object({ id: z.string(), runId: z.string() }).parse(artifact);
        this.config.documents.put('artifact', record.id, {
          ...z.record(z.string(), z.unknown()).parse(artifact),
          runId: job.runId,
          repairRunId: record.runId,
          repairJobId: job.id,
          phase: label,
        });
      }
      return { execution, sandbox: result, observed };
    };
    const before = await executeTarget('before', baseline);
    const original = before.observed.result.scenarios.find(
      (scenario) => scenario.id === finding.scenarioId,
    )?.[finding.channel];
    if (
      before.observed.exitCode !== 1 ||
      original?.verdict !== 'fail' ||
      original.code !== finding.code
    )
      throw new RepairError('ORIGINAL_FAILURE_NOT_REPRODUCED');
    const patched = baseline.map((file) => {
      const change = changes.find((item) => item.path === file.path);
      return change ? { ...file, bytes: Buffer.from(change.content) } : file;
    });
    const after = await executeTarget('after', patched);
    if (
      after.observed.exitCode !== 0 ||
      after.observed.result.scenarios.length !== 4 ||
      after.observed.result.scenarios.some((scenario) =>
        [scenario.api, scenario.browser, scenario.state].some(
          (channel) => channel.verdict !== 'pass',
        ),
      )
    )
      throw new RepairError('REPAIR_VERIFICATION_FAILED');
    const receipt = (
      execution: typeof before,
      checkId: string,
      diffHash: string | null,
      outcome: 'pass' | 'fail',
      failureCode: string | null,
    ) => ({
      id: randomUUID(),
      executionId: `${execution.sandbox.operationId}:${execution.observed.pid}`,
      checkId,
      oracleHash: source.oracleHash,
      policyHash: source.policy.hash,
      baseCommit: source.baseCommit,
      diffHash,
      artifactHash: hashValue(execution.execution),
      observedAt: execution.observed.result.completedAt,
      exitCode: execution.observed.exitCode,
      outcome,
      failureCode,
    });
    this.store.recordVerification({
      proposalId: proposal.id,
      before: receipt(before, job.findingId, null, 'fail', finding.code),
      after: receipt(after, job.findingId, proposal.proposal.diffHash, 'pass', null),
      regressions: [...CORE_SCENARIOS, ...SECURITY_CONTROLS].map((id) =>
        receipt(after, id, proposal.proposal.diffHash, 'pass', null),
      ),
    });
    job.state = 'verified_local';
    this.save(job);
  }
  private job(runId: string, jobId: string) {
    const job = this.jobs(runId).find((item) => item.id === jobId);
    if (!job) throw new RepairError('NOT_FOUND');
    return job;
  }
  async requestPublication(runId: string, jobId: string) {
    const job = this.job(runId, jobId);
    if (job.state !== 'verified_local' || !job.proposalId)
      throw new RepairError('VERIFICATION_REQUIRED');
    if (this.publicationLocks.has(job.id)) throw new RepairError('PUBLICATION_IN_FLIGHT');
    this.publicationLocks.add(job.id);
    try {
      const proposal = this.getProposal(runId, job.proposalId);
      if (this.config.documents.get('repair-publication-intent', job.id)) {
        await this.recoverPublication(job);
        return this.view(runId).find((item) => item.id === jobId);
      }
      const pending = this.store.requestPublication({
        proposalId: proposal.id,
        title: `Fix ${job.findingId} subscription access mismatch`,
        body: 'This generated change passed the recorded original reproduction and all four regression scenarios using signed synthetic local replay. Review the diff and attached evidence before merging. No merge or deployment is authorized.',
      });
      if (
        !pending.approval ||
        pending.approval.decision !== 'pending' ||
        pending.approval.expiresAt <= Date.now()
      )
        throw new RepairError('FRESH_PUBLICATION_APPROVAL_REQUIRED');
      this.config.documents.put('repair-publication-intent', job.id, {
        previousTurnId: job.turnId,
        approvalId: pending.approval.id,
        at: Date.now(),
      });
      const turn = await this.runtime
        .continueTurn({
          sessionId: job.sessionId,
          previousTurnId: job.turnId,
          input: `The owner requested a publication approval for verified proposal ${proposal.id}. Call publish_repair_pr exactly once with runId ${runId} and operationId ${proposal.id}. This tool must pause for owner approval of the exact diff and destination. Do not approve it yourself. Do not use shell, GitHub directly, other tools, merge or deploy. If denied, do nothing and state that publication was denied.`,
        })
        .catch(async (error) => {
          await this.recoverPublication(job);
          throw error;
        });
      this.trackPublication(job, turn.id, pending.approval.id);
      return this.view(runId).find((item) => item.id === jobId);
    } finally {
      this.publicationLocks.delete(job.id);
    }
  }
  private trackPublication(job: RepairJob, turnId: string, approvalId: string) {
    if (this.closed) return;
    job.turnId = turnId;
    this.save(job);
    this.config.documents.put('repair-publication-runtime', job.id, {
      sessionId: job.sessionId,
      turnId,
      approvalId,
      status: 'running',
    });
    void this.watchPublication(job.id);
  }
  private async recoverPublication(job: RepairJob) {
    const raw =
      this.config.documents.get('repair-publication-decision-intent', job.id) ??
      this.config.documents.get('repair-publication-intent', job.id);
    if (!raw) return;
    const intent = publicationIntentSchema.parse(raw);
    const state = publicationRuntimeSchema.safeParse(
      this.config.documents.get('repair-publication-runtime', job.id),
    );
    if (state.success && state.data.turnId !== intent.previousTurnId) {
      void this.watchPublication(job.id);
      return;
    }
    // A POST may have reached TrueForge even when its response was lost. Reads only.
    try {
      const continuation = await this.runtime.findContinuation({
        sessionId: job.sessionId,
        previousTurnId: intent.previousTurnId,
      });
      if (continuation) this.trackPublication(job, continuation.id, intent.approvalId);
      else if (!this.closed)
        this.config.documents.put('repair-publication-runtime', job.id, {
          sessionId: job.sessionId,
          turnId: intent.previousTurnId,
          approvalId: intent.approvalId,
          status: 'error',
          error: 'PUBLICATION_OUTCOME_UNKNOWN_NO_REDISPATCH',
        });
    } catch {
      if (!this.closed)
        this.config.documents.put('repair-publication-runtime', job.id, {
          sessionId: job.sessionId,
          turnId: intent.previousTurnId,
          approvalId: intent.approvalId,
          status: 'error',
          error: 'PUBLICATION_RUNTIME_UNAVAILABLE',
        });
    }
  }
  private async watchPublication(jobId: string) {
    const state = publicationRuntimeSchema.parse(
      this.config.documents.get('repair-publication-runtime', jobId),
    );
    const key = `${jobId}:${state.turnId}`;
    if (
      this.closed ||
      this.publicationWatchers.has(key) ||
      state.error === 'PUBLICATION_OUTCOME_UNKNOWN_NO_REDISPATCH'
    )
      return;
    const abort = new AbortController();
    this.publicationWatchers.set(key, abort);
    const stillCurrent = () =>
      !this.closed &&
      publicationRuntimeSchema.safeParse(
        this.config.documents.get('repair-publication-runtime', jobId),
      ).data?.turnId === state.turnId;
    try {
      const initial = await this.runtime.inspectTurn(state);
      if (initial.state.status !== 'done')
        for await (const event of await this.runtime.resumeStream({
          ...state,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(900_000)]),
        })) {
          void event;
          if (!stillCurrent()) return;
        }
      const turn = await this.runtime.inspectTurn(state);
      state.status =
        turn.state.status === 'done'
          ? turn.state.requiredActions.length
            ? 'approval'
            : 'done'
          : 'error';
      delete state.error;
      if (stillCurrent()) this.config.documents.put('repair-publication-runtime', jobId, state);
    } catch {
      if (stillCurrent())
        this.config.documents.put('repair-publication-runtime', jobId, {
          ...state,
          status: 'error',
          error: 'PUBLICATION_RUNTIME_UNAVAILABLE',
        });
    } finally {
      this.publicationWatchers.delete(key);
    }
  }
  async decidePublication(runId: string, jobId: string, approvalId: string, input: unknown) {
    const request = z
        .strictObject({
          decision: z.enum(['allow', 'deny']),
          bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(input),
      job = this.job(runId, jobId);
    if (!job.proposalId) throw new RepairError('VERIFICATION_REQUIRED');
    if (this.publicationLocks.has(job.id)) throw new RepairError('PUBLICATION_IN_FLIGHT');
    this.publicationLocks.add(job.id);
    try {
      const record = this.getProposal(runId, job.proposalId),
        state = publicationRuntimeSchema.parse(
          this.config.documents.get('repair-publication-runtime', jobId),
        );
      if (
        record.approval?.id !== approvalId ||
        record.approval.bindingHash !== request.bindingHash ||
        state.approvalId !== approvalId
      )
        throw new RepairError('APPROVAL_STALE');
      const priorIntent = this.config.documents.get('repair-publication-decision-intent', job.id);
      if (priorIntent) {
        const intent = publicationIntentSchema.parse(priorIntent);
        if (intent.decision !== request.decision || intent.approvalId !== approvalId)
          throw new RepairError('APPROVAL_CONFLICT');
        await this.recoverPublication(job);
        return this.view(runId).find((item) => item.id === jobId);
      }
      if (state.status !== 'approval') throw new RepairError('RUNTIME_APPROVAL_PENDING');
      const pending = await this.runtime.inspectApprovals(state);
      if (pending.length !== 1) throw new RepairError('RUNTIME_APPROVAL_PENDING');
      const [gate] = pending;
      if (
        !gate ||
        gate.tool.toolInfo.type !== 'mcp' ||
        gate.tool.toolInfo.name !== 'publish_repair_pr' ||
        gate.tool.toolInfo.serverId !== `paywallproof_${runId.replaceAll('-', '')}`
      )
        throw new RepairError('RUNTIME_APPROVAL_MISMATCH');
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(gate.tool.function.arguments);
      } catch {
        throw new RepairError('RUNTIME_APPROVAL_MISMATCH');
      }
      const args = z
        .strictObject({ runId: z.literal(runId), operationId: z.literal(record.id) })
        .safeParse(argumentsValue);
      if (!args.success) throw new RepairError('RUNTIME_APPROVAL_MISMATCH');
      this.store.decidePublication({
        proposalId: record.id,
        approvalId,
        bindingHash: request.bindingHash,
        decision: request.decision,
      });
      this.config.documents.put('repair-publication-decision-intent', job.id, {
        previousTurnId: state.turnId,
        approvalId,
        decision: request.decision,
        at: Date.now(),
      });
      const turn = await this.runtime
        .continueApproval({
          sessionId: state.sessionId,
          turnId: state.turnId,
          decisions: [
            {
              threadId: gate.threadId,
              toolCallId: gate.toolCallId,
              approval:
                request.decision === 'allow'
                  ? { status: 'allow' }
                  : { status: 'deny', reason: 'The owner denied publication.' },
            },
          ],
        })
        .catch(async (error) => {
          await this.recoverPublication(job);
          throw error;
        });
      this.trackPublication(job, turn.id, approvalId);
      return this.view(runId).find((item) => item.id === jobId);
    } finally {
      this.publicationLocks.delete(job.id);
    }
  }
  async publishFromTool(runId: string, proposalId: string) {
    const record = this.getProposal(runId, proposalId);
    if (!record.approval || record.approval.decision !== 'allow')
      throw new RepairError('APPROVAL_REQUIRED');
    const { stdout } = await execute('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 16384,
    });
    const token = stdout.trim();
    if (!token) throw new RepairError('GITHUB_CREDENTIAL_REQUIRED');
    const result = await publishRepair({
      store: this.store,
      adapter: new GitHubPublicationAdapter({ repository: this.config.repository, token }),
      proposalId,
      approvalId: record.approval.id,
    });
    return { state: result.kind, receipt: result.receipt };
  }
  async recover() {
    for (const value of this.config.documents.list('repair-job-index')) {
      const { runId, id } = z.object({ runId: z.string(), id: z.string() }).parse(value),
        job = jobSchema.parse(this.config.documents.get(`repair-job:${runId}`, id));
      if (!['preparing', 'testing'].includes(job.state)) {
        await this.recoverPublication(job);
        continue;
      }
      await this.runtime.cancel({ sessionId: job.sessionId });
      job.state = 'abandoned';
      job.error = 'REPAIR_INTERRUPTED_NO_REDISPATCH';
      this.save(job);
    }
  }
  cancel(runId: string, jobId: string) {
    const job = this.jobs(runId).find((item) => item.id === jobId);
    if (!job) throw new RepairError('NOT_FOUND');
    this.active.get(jobId)?.abort();
    return job;
  }
  getProposal(runId: string, proposalId: string): RepairRecord {
    const record = this.store.get(proposalId);
    if (record.proposal.runId !== runId) throw new RepairError('REPAIR_SCOPE_REJECTED');
    return record;
  }
  close() {
    this.closed = true;
    for (const abort of [...this.active.values(), ...this.publicationWatchers.values()])
      abort.abort();
    this.store.close();
  }
}
