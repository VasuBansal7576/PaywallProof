import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RepairJobCard, RepairsPanel } from '../components/repairs';
import { detailSchema, runSchema, type Run, type RunDetail } from './contracts';
import { failedFindingId, presentRepair, repairCheckArtifacts, repairCheckSchema, repairJobSchema, repairStartBlocker, type RepairJob } from './repair-presentation';

// Synthetic presentation fixtures only. These do not run or certify a repair workflow.
const now = 1_800_000_000_000;
const sha = 'a'.repeat(40);
const policyHash = 'b'.repeat(64);
function runFixture(): Run {
  return runSchema.parse({
    id: 'run_presentation', projectId: 'project_presentation', targetBuild: sha, featureConfigHash: 'f'.repeat(64), mode: 'local_replay', status: 'completed', outcome: 'failed',
    policy: { schemaVersion: 1, priceId: 'price_test', featureId: 'pro_export', featureConfigHash: 'f'.repeat(64), cancellation: 'allow_until_period_end', requireInitialInvoicePaid: true, syncWindowSeconds: 60, predicateVersion: 'reference-export-v1', hash: policyHash },
    createdAt: now - 100_000, startedAt: now - 90_000, verdicts: ['failed'], approval: { id: 'original_approval', bindingHash: 'a'.repeat(64), expiresAt: now - 10_000, decision: 'allow' },
  });
}
function jobFixture(): RepairJob {
  const proposal = {
    runId: 'run_presentation', findingId: 'SC01:api', attempt: 1, baseCommit: sha, baseBranch: 'main', repository: 'example/app', branch: 'paywallproof/repair-presentation-1',
    policyHash, oracleHash: 'c'.repeat(64), allowedPaths: ['packages/reference/src/billing.ts'], changes: [{ path: 'packages/reference/src/billing.ts', content: '<script>alert("source")</script>\n' }, { path: 'packages/reference/src/unused.ts', content: null }],
    diffHash: 'd'.repeat(64), verificationMode: 'local_replay', failureCode: 'ACCESS_LEAK', summary: 'Candidate for the recorded SC01 API failure.', reportUrl: 'http://localhost:3000/runs/run_presentation',
  };
  const receipt = { id: 'receipt_before', executionId: 'execution_before', checkId: 'SC01:api', oracleHash: proposal.oracleHash, policyHash, baseCommit: sha, diffHash: null, artifactHash: 'e'.repeat(64), observedAt: now - 2000, exitCode: 1, outcome: 'fail', failureCode: proposal.failureCode };
  const after = { ...receipt, id: 'receipt_after', executionId: 'execution_after', diffHash: proposal.diffHash, observedAt: now - 1000, exitCode: 0, outcome: 'pass', failureCode: null };
  return repairJobSchema.parse({
    id: randomUUID(), runId: proposal.runId, findingId: proposal.findingId, attempt: 1, createdAt: now - 10_000, deadline: now + 890_000, state: 'verified_local', mode: 'local_replay',
    sessionId: 'session_presentation', turnId: 'turn_presentation', proposalId: 'proposal_presentation', error: null, runtimeOperations: [], publicationRuntime: null,
    checks: [{ phase: 'before', artifactHash: receipt.artifactHash, exitCode: 1, scenarios: [{ id: 'SC01', api: { verdict: 'fail', code: 'ACCESS_LEAK' }, browser: { verdict: 'inconclusive', code: 'NOT_COLLECTED' }, state: { verdict: 'pass', code: 'STATE_MATCH' }, observationIds: [] }], runtime: { sessionId: 'session_presentation', operationId: 'execution_before' } }],
    proposal: { id: 'proposal_presentation', createdAt: now - 5000, proposal, state: 'verified_local', manifest: { ...proposal, requiredRegressionChecks: ['SC01'], verification: { before: receipt, after, regressions: [{ ...after, id: 'regression_SC01', checkId: 'SC01' }] } }, manifestHash: 'f'.repeat(64), approval: null, progress: null },
  });
}
function withApproval(job: RepairJob) {
  if (!job.proposal) throw new Error('Presentation fixture requires a proposal');
  job.proposal.state = 'awaiting_publication';
  job.proposal.approval = { id: 'approval_presentation', bindingHash: '1'.repeat(64), expiresAt: now + 30_000, decision: 'pending', args: { repository: job.proposal.proposal.repository, baseBranch: 'main', branch: job.proposal.proposal.branch, draft: true, title: 'Fix <recorded> failure', body: 'Exact body\n<script>untrusted()</script>\n' } };
  job.publicationRuntime = { sessionId: job.sessionId, turnId: 'turn_publication', approvalId: job.proposal.approval.id, status: 'approval' };
  return job;
}
function withPublished(job: RepairJob) {
  withApproval(job);
  if (!job.proposal?.approval) throw new Error('Presentation fixture requires approval');
  job.proposal.state = 'published'; job.proposal.approval.decision = 'allow';
  job.proposal.progress = { transportMode: 'github', treeSha: '2'.repeat(40), commitSha: '3'.repeat(40), prAttempted: true, result: { kind: 'published', receipt: { repository: job.proposal.proposal.repository, branch: job.proposal.proposal.branch, baseCommit: sha, commitSha: '3'.repeat(40), treeSha: '2'.repeat(40), prNumber: 42, url: 'https://github.com/example/app/pull/42', draft: true, manifestHash: 'f'.repeat(64), collectedAt: now, transportMode: 'github' } } };
  return job;
}
function recorded(job: RepairJob) {
  const view = presentRepair(job, runFixture(), now);
  if (view.kind !== 'recorded') throw new Error(view.reason);
  return view;
}
function detailFixture(): RunDetail {
  return detailSchema.parse({ run: runFixture(), runtime: null, scenarios: [{ id: 'SC01', api: { verdict: 'fail', code: 'ACCESS_LEAK' }, browser: { verdict: 'inconclusive', code: 'NOT_COLLECTED' }, state: { verdict: 'pass', code: 'STATE_MATCH' }, observationIds: [] }], repairs: [], observations: [], cleanup: [], coverageLimits: [] });
}
const noMutation = async () => {};
function childScreenshotFixture() {
  const job = jobFixture();
  const child = { id: `${randomUUID()}.png`, runId: 'child_execution', observationId: 'child_browser', sha256: 'a'.repeat(64), contentType: 'image/png', source: 'browser', collectedAt: new Date(now).toISOString() };
  const check = repairCheckSchema.parse({
    ...repairCheckSchema.parse(job.checks[0]),
    scenarios: [{ id: 'SC01', api: { verdict: 'fail', code: 'ACCESS_LEAK' }, browser: { verdict: 'fail', code: 'ACCESS_LEAK' }, state: { verdict: 'pass', code: 'STATE_MATCH' }, observationIds: ['child_browser'] }],
    observations: [{ id: 'child_browser', runId: child.runId, scenarioId: 'SC01', subjectId: 'child_user', source: 'browser', policyHash, targetBuild: sha, observedAt: now, billingTime: null, mode: 'local_replay', sha256: 'b'.repeat(64), payload: {} }], artifacts: [child],
  });
  const parent = { ...child, runId: job.runId, repairRunId: child.runId, repairJobId: job.id, phase: check.phase };
  return { job, check, child, parent };
}

describe('repair presentation, not execution verification', () => {
  it('requires a matching recorded manifest before enabling a publication request', () => {
    const job = jobFixture();
    expect(recorded(job)).toMatchObject({ verified: true, canRequestPublication: true, canDecide: false, published: null });
    if (!job.proposal) throw new Error('Missing fixture proposal');
    job.proposal.manifest = null;
    expect(recorded(job)).toMatchObject({ verified: false, canRequestPublication: false });
  });

  it('does not treat a candidate with an altered manifest as verified', () => {
    const job = jobFixture();
    if (!job.proposal?.manifest) throw new Error('Missing fixture manifest');
    job.proposal.manifest.changes = [{ path: 'packages/reference/src/billing.ts', content: 'different content' }];
    expect(recorded(job).verified).toBe(false);
  });

  it.each(['run', 'policy', 'build', 'proposal', 'finding'])('rejects a mismatched %s association', field => {
    const job = jobFixture();
    if (!job.proposal) throw new Error('Missing fixture proposal');
    if (field === 'run') job.runId = 'other';
    if (field === 'policy') job.proposal.proposal.policyHash = '0'.repeat(64);
    if (field === 'build') job.proposal.proposal.baseCommit = '0'.repeat(40);
    if (field === 'proposal') job.proposalId = 'other';
    if (field === 'finding') job.findingId = 'SC02:api';
    expect(presentRepair(job, runFixture(), now).kind).toBe('unavailable');
  });

  it('enables decisions only for a pending, unexpired matching runtime approval', () => {
    const job = withApproval(jobFixture());
    expect(recorded(job).canDecide).toBe(true);
    expect(presentRepair(job, runFixture(), now + 30_000)).toMatchObject({ canDecide: false });
    for (const status of ['running', 'done', 'error'] satisfies Array<NonNullable<RepairJob['publicationRuntime']>['status']>) {
      job.publicationRuntime = { sessionId: job.sessionId, turnId: 'turn', approvalId: 'approval_presentation', status };
      expect(recorded(job).canDecide).toBe(false);
    }
    job.publicationRuntime = { sessionId: 'foreign_session', turnId: 'turn', approvalId: 'approval_presentation', status: 'approval' };
    expect(recorded(job).canDecide).toBe(false);
    job.publicationRuntime = { sessionId: job.sessionId, turnId: 'turn', approvalId: 'other_approval', status: 'approval' };
    expect(recorded(job).canDecide).toBe(false);
    job.publicationRuntime = { sessionId: job.sessionId, turnId: 'turn', status: 'approval' };
    expect(recorded(job).canDecide).toBe(false);
  });

  it.each(['draft', 'repository', 'branch', 'decision'])('does not enable a changed %s approval', field => {
    const job = withApproval(jobFixture());
    if (!job.proposal?.approval) throw new Error('Missing fixture approval');
    if (field === 'draft') job.proposal.approval.args.draft = false;
    if (field === 'repository') job.proposal.approval.args.repository = 'other/app';
    if (field === 'branch') job.proposal.approval.args.branch = 'main';
    if (field === 'decision') job.proposal.approval.decision = 'allow';
    expect(recorded(job).canDecide).toBe(false);
  });

  it('renders exact escaped source, deletion, immutable hashes and recorded check outcomes', () => {
    const job = withApproval(jobFixture());
    const markup = renderToStaticMarkup(createElement(RepairJobCard, { view: recorded(job), busy: null, onMutation: noMutation, now }));
    expect(markup).toContain('Replacement contents');
    expect(markup).toContain('Delete file');
    expect(markup).toContain('&lt;script&gt;alert(&quot;source&quot;)&lt;/script&gt;\n');
    expect(markup).toContain('Exact body\n&lt;script&gt;untrusted()&lt;/script&gt;\n');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('No patched execution receipt has been recorded.');
    expect(markup).toContain('inconclusive');
    expect(markup).toContain(policyHash);
    expect(markup).toContain('1'.repeat(64));
    expect(markup).not.toContain('href="https://github.com');
  });

  it('shows only a matching genuine provider publication as a linked draft PR', () => {
    const job = withPublished(jobFixture());
    expect(recorded(job).published?.url).toBe('https://github.com/example/app/pull/42');
    const markup = renderToStaticMarkup(createElement(RepairJobCard, { view: recorded(job), busy: null, onMutation: noMutation, now }));
    expect(markup).toContain('href="https://github.com/example/app/pull/42"');
    expect(markup).toContain('Draft PR #42');
    expect(runFixture().outcome).toBe('failed');
  });

  it('renders actual security controls without treating omitted controls as passed', () => {
    const job = jobFixture();
    job.checks = [{ phase: 'after', artifactHash: 'e'.repeat(64), exitCode: 1, scenarios: [], runtime: {}, controls: [{ id: 'SEC_SIGNATURE_INVALID', outcome: 'fail', expectedStatus: 400, actualStatus: 200, responseHash: '1'.repeat(64), stateBeforeHash: '2'.repeat(64), stateAfterHash: '3'.repeat(64), observedAt: now }] }];
    const markup = renderToStaticMarkup(createElement(RepairJobCard, { view: recorded(job), busy: null, onMutation: noMutation, now }));
    expect(markup).toContain('1 of 14 required control receipts recorded.');
    expect(markup).toContain('SEC_SIGNATURE_INVALID');
    expect(markup).toContain('<td>400</td><td>200</td>');
    expect(markup).toContain('3'.repeat(64));
    expect(markup).toContain('No original execution receipt has been recorded.');
  });

  it('links child screenshots through the same check browser observations and parent artifact record', () => {
    const { job, check, child, parent } = childScreenshotFixture();
    expect(repairCheckArtifacts(job, check, [parent])).toEqual({ artifacts: [child], invalidCount: 0 });
    job.checks = [check];
    const markup = renderToStaticMarkup(createElement(RepairJobCard, { view: recorded(job), busy: null, onMutation: noMutation, now, parentArtifacts: [parent] }));
    expect(markup).toContain('View screenshot');
    expect(markup).toContain('child_execution');
    expect(markup).not.toContain('<img');
  });

  it.each(['runId', 'repairRunId', 'repairJobId', 'phase', 'sha256', 'observationId'])('rejects a mismatched parent screenshot %s', field => {
    const { job, check, parent } = childScreenshotFixture();
    const mismatch = { ...parent, [field]: field === 'sha256' ? 'c'.repeat(64) : field === 'phase' ? 'after' : 'foreign' };
    expect(repairCheckArtifacts(job, check, [mismatch])).toEqual({ artifacts: [], invalidCount: 1 });
  });

  it('does not link a screenshot with an unreferenced or non-browser child observation', () => {
    const { job, check, parent } = childScreenshotFixture();
    check.scenarios = [];
    expect(repairCheckArtifacts(job, check, [parent]).artifacts).toHaveLength(0);
    const second = childScreenshotFixture();
    second.check.observations = [];
    expect(repairCheckArtifacts(second.job, second.check, [second.parent]).artifacts).toHaveLength(0);
  });

  it.each(['synthetic', 'manifest', 'draft', 'url', 'state', 'commit'])('does not link a %s publication mismatch', field => {
    const job = withPublished(jobFixture());
    const record = job.proposal;
    const result = record?.progress?.result;
    if (!record || !result) throw new Error('Missing fixture publication');
    if (field === 'synthetic') result.kind = 'synthetic';
    if (field === 'manifest') result.receipt.manifestHash = '0'.repeat(64);
    if (field === 'draft') result.receipt.draft = false;
    if (field === 'url') result.receipt.url = 'https://github.com.evil.test/example/app/pull/42';
    if (field === 'state') record.state = 'awaiting_publication';
    if (field === 'commit') result.receipt.commitSha = '0'.repeat(40);
    expect(recorded(job).published).toBeNull();
  });

  it('requires a completed failed run and respects active jobs and the two-attempt limit', () => {
    const detail = detailFixture();
    expect(repairStartBlocker(detail)).toBeNull();
    const [scenario] = detail.scenarios;
    if (!scenario) throw new Error('Missing fixture scenario');
    expect(failedFindingId(scenario)).toBe('SC01:api');
    detail.run.status = 'stopping'; expect(repairStartBlocker(detail)).toContain('finish');
    detail.run.status = 'completed'; detail.run.outcome = 'inconclusive'; expect(repairStartBlocker(detail)).toContain('confirmed failed');
    detail.run.outcome = 'failed'; detail.repairs = [{ ...jobFixture(), state: 'testing' }]; expect(repairStartBlocker(detail)).toContain('already executing');
    detail.repairs = [jobFixture(), jobFixture()]; expect(repairStartBlocker(detail)).toContain('two repair jobs');
  });

  it('keeps malformed receipts explicit and preserves the original failed result', () => {
    const detail = detailFixture(); detail.repairs = [{ id: 'malformed', state: 'published' }];
    const markup = renderToStaticMarkup(createElement(RepairsPanel, { detail, busy: null, onRequest: noMutation, onMutation: noMutation }));
    expect(markup).toContain('Repair data unavailable');
    expect(markup).toContain('The original run keeps its recorded outcome.');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('Draft PR published');
    expect(detail.run.outcome).toBe('failed');
  });
});
