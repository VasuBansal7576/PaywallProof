import { z } from 'zod';
import { scenarioSchema, type Run, type RunDetail, type Scenario } from './contracts';
import { artifactSchema, observationSchema, type Artifact } from './evidence-presentation';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.number().int().nonnegative();
const findingId = z.string().regex(/^SC0[1-4]:(api|browser|state)$/);
const proposalSchema = z.object({
  runId: z.string(),
  findingId,
  attempt: z.union([z.literal(1), z.literal(2)]),
  baseCommit: commit,
  baseBranch: z.string(),
  repository: z.string(),
  branch: z.string(),
  policyHash: hash,
  oracleHash: hash,
  allowedPaths: z.array(z.string()),
  changes: z.array(z.object({ path: z.string(), content: z.string().nullable() })).min(1),
  diffHash: hash,
  verificationMode: z.enum(['local_replay', 'polar_sandbox']),
  failureCode: z.string(),
  summary: z.string(),
  reportUrl: z.string(),
});
const verificationReceiptSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  checkId: z.string(),
  oracleHash: hash,
  policyHash: hash,
  baseCommit: commit,
  diffHash: hash.nullable(),
  artifactHash: hash,
  observedAt: timestamp,
  exitCode: z.number().int().min(0).max(255),
  outcome: z.enum(['pass', 'fail']),
  failureCode: z.string().nullable(),
});
const manifestSchema = proposalSchema.extend({
  requiredRegressionChecks: z.array(z.string()).min(1),
  verification: z.object({
    before: verificationReceiptSchema,
    after: verificationReceiptSchema,
    regressions: z.array(verificationReceiptSchema).min(1),
  }),
});
const publicationReceiptSchema = z.object({
  repository: z.string(),
  branch: z.string(),
  baseCommit: commit,
  commitSha: commit,
  treeSha: commit,
  prNumber: z.number().int().positive(),
  url: z.string(),
  draft: z.boolean(),
  manifestHash: hash,
  collectedAt: timestamp,
  transportMode: z.enum(['github', 'synthetic']),
});
const repairRecordSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  proposal: proposalSchema,
  state: z.enum([
    'proposed',
    'verified_local',
    'verified_polar_sandbox',
    'awaiting_publication',
    'published',
    'abandoned',
  ]),
  manifest: manifestSchema.nullable(),
  manifestHash: hash.nullable(),
  approval: z
    .object({
      id: z.string(),
      bindingHash: hash,
      expiresAt: timestamp,
      decision: z.enum(['pending', 'allow', 'deny']),
      args: z.object({
        repository: z.string(),
        baseBranch: z.string(),
        branch: z.string(),
        draft: z.boolean(),
        title: z.string(),
        body: z.string(),
      }),
    })
    .nullable(),
  progress: z
    .object({
      transportMode: z.enum(['github', 'synthetic']),
      treeSha: commit.nullable(),
      commitSha: commit.nullable(),
      prAttempted: z.boolean(),
      result: z
        .object({ kind: z.enum(['published', 'synthetic']), receipt: publicationReceiptSchema })
        .nullable(),
    })
    .nullable(),
});
export const repairJobSchema = z.object({
  id: z.string().uuid(),
  runId: z.string(),
  findingId,
  attempt: z.union([z.literal(1), z.literal(2)]),
  createdAt: timestamp,
  deadline: timestamp,
  state: z.enum(['preparing', 'testing', 'verified_local', 'abandoned']),
  mode: z.literal('local_replay'),
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
  proposal: repairRecordSchema.nullable(),
  publicationRuntime: z
    .object({
      sessionId: z.string(),
      turnId: z.string(),
      approvalId: z.string().optional(),
      status: z.enum(['running', 'approval', 'done', 'error']),
      error: z.string().optional(),
    })
    .nullable(),
});
const securityControlSchema = z.object({
  id: z.string(),
  outcome: z.enum(['pass', 'fail']),
  expectedStatus: z.number().int(),
  actualStatus: z.number().int(),
  responseHash: hash,
  stateBeforeHash: hash,
  stateAfterHash: hash,
  observedAt: timestamp,
});
export const repairCheckSchema = z.object({
  phase: z.enum(['before', 'after']),
  artifactHash: hash,
  exitCode: z.number().int().min(0).max(255),
  scenarios: z.array(scenarioSchema),
  controls: z.array(securityControlSchema).optional(),
  runtime: z.unknown(),
  observations: z.array(z.unknown()).optional(),
  artifacts: z.array(z.unknown()).optional(),
});
export type RepairJob = z.infer<typeof repairJobSchema>;
type RepairPresentation =
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'recorded';
      job: RepairJob;
      verified: boolean;
      canRequestPublication: boolean;
      canDecide: boolean;
      publicationBlocker: string | null;
      published: z.infer<typeof publicationReceiptSchema> | null;
    };

export function failedFindingId(scenario: Scenario): string | undefined {
  const channel = (
    ['api', 'browser', 'state'] satisfies Array<keyof Pick<Scenario, 'api' | 'browser' | 'state'>>
  ).find((channel) => scenario[channel].verdict === 'fail');
  return channel ? `${scenario.id}:${channel}` : undefined;
}

export function repairStartBlocker(detail: RunDetail): string | null {
  if (detail.run.status !== 'completed')
    return 'Wait for the original run to finish before preparing a repair.';
  if (detail.run.outcome !== 'failed' || !detail.scenarios.some(failedFindingId))
    return 'A confirmed failed assertion is required. Inconclusive checks cannot authorize a repair.';
  if (detail.repairs.length >= 2) return 'This run has reached its limit of two repair jobs.';
  for (const raw of detail.repairs) {
    const parsed = repairJobSchema.safeParse(raw);
    if (!parsed.success || parsed.data.runId !== detail.run.id)
      return 'A saved repair receipt is unavailable. Resolve it before starting another job.';
    if (['preparing', 'testing'].includes(parsed.data.state))
      return 'One repair is already executing. Wait for it to finish or request its cancellation.';
    if (['running', 'approval'].includes(parsed.data.publicationRuntime?.status ?? ''))
      return 'Resolve the current publication operation before preparing another repair.';
  }
  return null;
}

/** Presentation checks only. The worker verifies immutable evidence and the exact runtime tool gate. */
export function presentRepair(raw: unknown, run: Run, now: number): RepairPresentation {
  const parsed = repairJobSchema.safeParse(raw);
  if (!parsed.success)
    return {
      kind: 'unavailable',
      reason:
        'This repair receipt is incomplete or uses an unsupported format. No action is enabled.',
    };
  const job = parsed.data;
  const record = job.proposal;
  if (
    job.runId !== run.id ||
    (record
      ? record.id !== job.proposalId ||
        record.proposal.runId !== run.id ||
        record.proposal.findingId !== job.findingId ||
        record.proposal.policyHash !== run.policy.hash ||
        record.proposal.baseCommit !== run.targetBuild ||
        record.proposal.verificationMode !== job.mode
      : job.proposalId !== null)
  ) {
    return {
      kind: 'unavailable',
      reason:
        'The repair does not match this run, finding, build, or policy. No action is enabled.',
    };
  }
  const manifestMatches =
    !!record?.manifest &&
    !!record.manifestHash &&
    JSON.stringify(proposalSchema.parse(record.manifest)) === JSON.stringify(record.proposal);
  const verified =
    job.state === 'verified_local' &&
    manifestMatches &&
    !!record &&
    ['verified_local', 'awaiting_publication', 'published', 'abandoned'].includes(record.state);
  const approval = record?.approval;
  const approvalMatches =
    !!approval &&
    !!record &&
    approval.args.repository === record.proposal.repository &&
    approval.args.baseBranch === record.proposal.baseBranch &&
    approval.args.branch === record.proposal.branch &&
    approval.args.draft;
  const canRequestPublication =
    run.status === 'completed' &&
    verified &&
    record?.state === 'verified_local' &&
    approval === null &&
    job.publicationRuntime === null;
  const canDecide =
    run.status === 'completed' &&
    verified &&
    record?.state === 'awaiting_publication' &&
    approvalMatches &&
    approval?.decision === 'pending' &&
    now < approval.expiresAt &&
    job.publicationRuntime?.status === 'approval' &&
    job.publicationRuntime.sessionId === job.sessionId &&
    job.publicationRuntime.approvalId === approval.id;
  let publicationBlocker: string | null = null;
  if (!verified)
    publicationBlocker =
      'Publication requires a recorded verified manifest for this exact candidate.';
  else if (record?.state === 'abandoned')
    publicationBlocker = 'This proposal was abandoned. It cannot be published.';
  else if (approval && !approvalMatches)
    publicationBlocker = 'The approval destination or draft flag does not match the candidate.';
  else if (approval?.decision === 'deny')
    publicationBlocker = 'Publication was denied. No new write is authorized.';
  else if (approval && now >= approval.expiresAt && record?.state !== 'published')
    publicationBlocker = 'The publication approval expired. No new provider write is authorized.';
  else if (approval?.decision === 'allow' && record?.state !== 'published')
    publicationBlocker =
      'Publication was allowed, but no matching provider receipt has been recorded yet.';
  else if (approval?.decision === 'pending' && !canDecide)
    publicationBlocker =
      'Waiting for the runtime to pause on the matching publication tool. A saved approval alone cannot publish.';
  const published =
    verified && approvalMatches && approval?.decision === 'allow' && record?.state === 'published'
      ? providerReceipt(record)
      : null;
  return {
    kind: 'recorded',
    job,
    verified,
    canRequestPublication,
    canDecide,
    publicationBlocker,
    published,
  };
}

function providerReceipt(record: z.infer<typeof repairRecordSchema>) {
  const progress = record.progress;
  const result = progress?.result;
  if (!progress || progress.transportMode !== 'github' || result?.kind !== 'published') return null;
  const receipt = result.receipt;
  if (
    receipt.transportMode !== 'github' ||
    receipt.manifestHash !== record.manifestHash ||
    receipt.repository !== record.proposal.repository ||
    receipt.branch !== record.proposal.branch ||
    receipt.baseCommit !== record.proposal.baseCommit ||
    !receipt.draft ||
    receipt.commitSha !== progress.commitSha ||
    receipt.treeSha !== progress.treeSha
  )
    return null;
  try {
    const url = new URL(receipt.url);
    if (
      url.origin !== 'https://github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/${receipt.repository}/pull/${receipt.prNumber}`
    )
      return null;
    return receipt;
  } catch {
    return null;
  }
}

const parentRepairArtifactSchema = artifactSchema.extend({
  repairRunId: z.string(),
  repairJobId: z.string(),
  phase: z.enum(['before', 'after']),
});

/** Keep child evidence identity while using the parent run's authenticated download route. */
export function repairCheckArtifacts(
  job: RepairJob,
  check: z.infer<typeof repairCheckSchema>,
  parentArtifacts: unknown[],
): { artifacts: Artifact[]; invalidCount: number } {
  const observations = (check.observations ?? []).flatMap((raw) => {
    const parsed = observationSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  const parent = parentArtifacts.flatMap((raw) => {
    const parsed = parentRepairArtifactSchema.safeParse(raw);
    return parsed.success &&
      parsed.data.runId === job.runId &&
      parsed.data.repairJobId === job.id &&
      parsed.data.phase === check.phase
      ? [parsed.data]
      : [];
  });
  const artifacts: Artifact[] = [];
  let invalidCount = 0;
  for (const raw of check.artifacts ?? []) {
    const parsed = artifactSchema.safeParse(raw);
    if (!parsed.success || !job.proposal) {
      invalidCount++;
      continue;
    }
    const artifact = parsed.data;
    const matches = observations.filter(
      (observation) =>
        observation.id === artifact.observationId &&
        observation.runId === artifact.runId &&
        observation.source === 'browser' &&
        observation.policyHash === job.proposal?.proposal.policyHash &&
        observation.targetBuild === job.proposal?.proposal.baseCommit &&
        observation.mode === job.mode &&
        check.scenarios.some(
          (scenario) =>
            scenario.id === observation.scenarioId &&
            scenario.observationIds.includes(observation.id),
        ),
    );
    const downloads = parent.filter(
      (candidate) =>
        candidate.id === artifact.id &&
        candidate.repairRunId === artifact.runId &&
        candidate.observationId === artifact.observationId &&
        candidate.sha256 === artifact.sha256 &&
        candidate.collectedAt === artifact.collectedAt,
    );
    if (
      matches.length !== 1 ||
      downloads.length !== 1 ||
      artifacts.some((candidate) => candidate.id === artifact.id)
    ) {
      invalidCount++;
      continue;
    }
    artifacts.push(artifact);
  }
  return { artifacts, invalidCount };
}
