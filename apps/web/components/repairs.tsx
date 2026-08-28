'use client';

import { useEffect, useState } from 'react';
import type { RunDetail } from '../lib/contracts';
import { presentRepair, repairCheckArtifacts, repairCheckSchema, repairStartBlocker, type RepairJob } from '../lib/repair-presentation';
import { AssertionBadge, Badge, EmptyState, JsonDetails, ModeBadge, formatDate } from './shared';
import { ArtifactScreenshot } from './evidence';

type Mutation = (name: string, path: string, body: unknown) => Promise<void>;

export function RepairsPanel({ detail, busy, onRequest, onMutation }: { detail: RunDetail; busy: string | null; onRequest: () => Promise<void>; onMutation: Mutation }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const blocker = repairStartBlocker(detail);
  return <section className="panel">
    <div className="panel-heading"><div><h2>Repair and publication</h2><p>Inspect the generated application files and recorded checks before authorizing a draft PR.</p></div><button className="button primary" disabled={!!busy || !!blocker} title={blocker ?? undefined} onClick={() => void onRequest()}>{busy === 'repair' ? 'Requesting repair…' : 'Prepare repair'}</button></div>
    <div className="panel-inset">
      <div className="coverage-note"><span aria-hidden="true">◇</span><div><strong>The original run keeps its recorded outcome.</strong><p>A repair job has its own evidence. Preparing one does not publish, merge, or deploy it. Each run permits at most two jobs, with one local execution at a time and a 15-minute limit per job.</p><p>Repair verification uses synthetic local replay. Even a verified local candidate is eligible only for a draft PR, not a Polar sandbox pass.</p></div></div>
      {blocker && <p className="repair-action-note" role="status">{blocker}</p>}
      {detail.repairs.length ? detail.repairs.map((raw, index) => {
        const view = presentRepair(raw, detail.run, now);
        return view.kind === 'unavailable' ? <article className="repair-card" key={index}><Badge tone="amber">Repair data unavailable</Badge><p>{view.reason}</p><JsonDetails title="Unrecognized repair receipt" value={raw} /></article> : <RepairJobCard key={view.job.id} view={view} busy={busy} onMutation={onMutation} now={now} parentArtifacts={detail.artifacts ?? []} />;
      }) : <EmptyState title="No repair prepared">A completed run with a confirmed failure can request a bounded application change. Missing infrastructure or failed checks remain explicit blockers.</EmptyState>}
    </div>
  </section>;
}

type RecordedRepair = Extract<ReturnType<typeof presentRepair>, { kind: 'recorded' }>;

export function RepairJobCard({ view, busy, onMutation, now, parentArtifacts = [] }: { view: RecordedRepair; busy: string | null; onMutation: Mutation; now: number; parentArtifacts?: unknown[] }) {
  const { job, verified, canDecide, canRequestPublication, published } = view;
  const record = job.proposal;
  const approval = record?.approval;
  const active = job.state === 'preparing' || job.state === 'testing';
  const path = `/runs/${encodeURIComponent(job.runId)}/repairs/${encodeURIComponent(job.id)}`;
  const phase = job.state === 'verified_local' ? verified ? 'Verified locally' : 'Verification receipt missing' : job.state === 'abandoned' ? 'Abandoned' : job.state === 'testing' ? 'Testing candidate' : 'Preparing candidate';
  return <article className="repair-card">
    <div className="repair-heading"><div><p className="eyebrow">Attempt {job.attempt} of 2 · {job.findingId}</p><h3>Repair {job.id.slice(0, 8)}</h3></div><Badge tone={job.state === 'abandoned' ? 'red' : verified ? 'green' : 'amber'}>{phase}</Badge><ModeBadge mode={job.mode} /></div>
    <dl className="definition-list repair-bindings"><div><dt>Job ID</dt><dd><code>{job.id}</code></dd></div><div><dt>Created</dt><dd>{formatDate(job.createdAt)}</dd></div><div><dt>Execution deadline</dt><dd>{formatDate(job.deadline)}{active && now >= job.deadline ? ' · expired, awaiting worker state' : ''}</dd></div><div><dt>Runtime session</dt><dd><code>{job.sessionId}</code></dd></div><div><dt>Current turn</dt><dd><code>{job.turnId}</code></dd></div></dl>
    {job.error && <div className="error-notice" role="alert"><strong>Repair stopped with an error</strong><p><code>{job.error}</code></p><p>Any generated candidate and collected checks below remain available. This error is not a successful repair.</p></div>}
    {active && <div className="repair-actions"><p>Stopping requests termination of this local repair job. Its state changes only after the worker accounts for execution.</p><button className="button danger-subtle" disabled={!!busy} onClick={() => void onMutation(`repair-stop:${job.id}`, `${path}/cancel`, {})}>{busy === `repair-stop:${job.id}` ? 'Requesting stop…' : 'Request repair stop'}</button></div>}
    {record ? <>
      <section className="repair-section"><div className="repair-section-heading"><h4>Generated application files</h4><Badge>{record.proposal.changes.length} changed {record.proposal.changes.length === 1 ? 'file' : 'files'}</Badge></div><p>{record.proposal.summary}</p><p>These are the exact proposed replacement contents. They are not a unified diff. Review the base commit when comparing the change. A generated explanation is not proof of its cause.</p>{record.proposal.changes.map(change => <details className="repair-file" key={change.path}><summary><code>{change.path}</code><span>{change.content === null ? 'Delete file' : 'Replacement contents'}</span></summary>{change.content === null ? <p>This proposal deletes the file.</p> : <pre tabIndex={0} aria-label={`Replacement contents for ${change.path}`}><code>{change.content}</code></pre>}</details>)}</section>
      <section className="repair-section"><h4>Immutable repair bindings</h4><dl className="definition-list repair-bindings"><div><dt>Proposal</dt><dd><code>{record.id}</code></dd></div><div><dt>Repository</dt><dd>{record.proposal.repository}</dd></div><div><dt>Base branch</dt><dd><code>{record.proposal.baseBranch}</code></dd></div><div><dt>Base commit</dt><dd><code>{record.proposal.baseCommit}</code></dd></div><div><dt>Repair branch</dt><dd><code>{record.proposal.branch}</code></dd></div><div><dt>Policy SHA-256</dt><dd><code>{record.proposal.policyHash}</code></dd></div><div><dt>Oracle SHA-256</dt><dd><code>{record.proposal.oracleHash}</code></dd></div><div><dt>Diff SHA-256</dt><dd><code>{record.proposal.diffHash}</code></dd></div><div><dt>Manifest SHA-256</dt><dd><code>{record.manifestHash ?? 'No verified manifest recorded'}</code></dd></div><div><dt>Original failure code</dt><dd><code>{record.proposal.failureCode}</code></dd></div></dl><JsonDetails title="Permitted application paths" value={record.proposal.allowedPaths} /></section>
    </> : <EmptyState title="No generated candidate recorded">The job has not returned an application change. No files, test results, or verified manifest have been inferred.</EmptyState>}
    <RepairChecks job={job} parentArtifacts={parentArtifacts} />
    {record?.manifest && <JsonDetails title="Recorded verification manifest and reproduction receipts" value={record.manifest} />}
    <section className="repair-section publication-section"><div className="repair-section-heading"><h4>Publication approval</h4><Badge tone={published ? 'green' : 'neutral'}>{published ? 'Draft PR published' : record?.state === 'abandoned' ? 'Abandoned' : 'No confirmed publication'}</Badge></div><p>Local replay cannot verify Polar delivery. Publication creates a draft PR in the displayed repository and branch only. It never merges or deploys code.</p>
      {view.publicationBlocker && <p className="repair-action-note" role="status">{view.publicationBlocker}</p>}
      {!approval && <div className="repair-actions"><p>Requesting publication prepares the exact approval and asks the runtime to pause. It does not authorize a GitHub write.</p><button className="button primary" disabled={!!busy || !canRequestPublication} onClick={() => void onMutation(`publication-request:${job.id}`, `${path}/publication-request`, {})}>{busy === `publication-request:${job.id}` ? 'Requesting approval…' : 'Request publication approval'}</button></div>}
      {approval && <div className="repair-approval"><div className="repair-section-heading"><h4>Exact provider request</h4><Badge tone={approval.decision === 'deny' ? 'red' : 'amber'}>{approval.decision === 'pending' && now >= approval.expiresAt ? 'Expired' : approval.decision === 'pending' ? 'Pending owner decision' : approval.decision === 'allow' ? 'Allowed' : 'Denied'}</Badge></div><dl className="definition-list repair-bindings"><div><dt>Repository</dt><dd>{approval.args.repository}</dd></div><div><dt>Base branch</dt><dd><code>{approval.args.baseBranch}</code></dd></div><div><dt>Repair branch</dt><dd><code>{approval.args.branch}</code></dd></div><div><dt>Draft</dt><dd>{String(approval.args.draft)}</dd></div><div><dt>Approval ID</dt><dd><code>{approval.id}</code></dd></div><div><dt>Binding SHA-256</dt><dd><code>{approval.bindingHash}</code></dd></div><div><dt>Expires</dt><dd>{formatDate(approval.expiresAt)}</dd></div><div><dt>Runtime gate</dt><dd>{job.publicationRuntime?.status ?? 'Not recorded'}</dd></div></dl><h5>PR title</h5><pre className="publication-text">{approval.args.title}</pre><h5>PR body</h5><pre className="publication-text" tabIndex={0}>{approval.args.body}</pre><JsonDetails title="Exact publication arguments" value={approval.args} /><div className="repair-actions"><p>The server checks the approval ID, binding, deadline, and matching runtime tool again when you decide.</p><button className="button secondary" disabled={!!busy || !canDecide} onClick={() => void onMutation(`publication-deny:${job.id}`, `${path}/approvals/${encodeURIComponent(approval.id)}`, { decision: 'deny', bindingHash: approval.bindingHash })}>{busy === `publication-deny:${job.id}` ? 'Denying…' : 'Deny publication'}</button><button className="button primary" disabled={!!busy || !canDecide} onClick={() => void onMutation(`publication-allow:${job.id}`, `${path}/approvals/${encodeURIComponent(approval.id)}`, { decision: 'allow', bindingHash: approval.bindingHash })}>{busy === `publication-allow:${job.id}` ? 'Approving…' : 'Approve draft PR'}</button></div></div>}
      {job.publicationRuntime?.error && <div className="error-notice" role="alert"><strong>Publication runtime error</strong><p><code>{job.publicationRuntime.error}</code></p><p>An allowed decision or completed turn alone does not prove a PR was created.</p></div>}
      {published ? <div className="publication-receipt"><Badge tone="green">GitHub receipt recorded</Badge><h4>Draft PR #{published.prNumber}</h4><a href={published.url} target="_blank" rel="noopener noreferrer">Open recorded draft PR ↗</a><dl className="definition-list repair-bindings"><div><dt>Collected</dt><dd>{formatDate(published.collectedAt)}</dd></div><div><dt>Commit</dt><dd><code>{published.commitSha}</code></dd></div><div><dt>Tree</dt><dd><code>{published.treeSha}</code></dd></div></dl><JsonDetails title="Provider publication receipt" value={published} /></div> : record?.progress?.result ? <p className="repair-action-note">The saved publication result is synthetic or does not match this verified manifest. No provider PR link is available.</p> : null}
      {job.publicationRuntime && <JsonDetails title="Publication runtime receipt" value={job.publicationRuntime} />}
      {record?.progress && <JsonDetails title="Publication progress, not a completion claim" value={record.progress} />}
    </section>
    <JsonDetails title="Local runtime operations" value={job.runtimeOperations} />
  </article>;
}

function RepairChecks({ job, parentArtifacts }: { job: RepairJob; parentArtifacts: unknown[] }) {
  return <section className="repair-section"><h4>Original and patched checks</h4><p>These are recorded assertion outcomes from the unchanged evaluator. A missing check is untested. A failed original check can establish reproduction only when the worker binds it to the recorded failure.</p>{(['before', 'after'] satisfies Array<'before' | 'after'>).map(phase => {
    const matching = job.checks.flatMap(raw => { const parsed = repairCheckSchema.safeParse(raw); return parsed.success && parsed.data.phase === phase ? [parsed.data] : []; });
    return <div className="repair-check" key={phase}><div className="repair-section-heading"><h5>{phase === 'before' ? 'Before · original application' : 'After · proposed application'}</h5><Badge>{matching.length ? `${matching.length} execution ${matching.length === 1 ? 'receipt' : 'receipts'}` : 'Untested'}</Badge></div>{matching.length ? matching.map((check, index) => <CheckExecution key={`${check.artifactHash}:${index}`} check={check} job={job} parentArtifacts={parentArtifacts} />) : <p>No {phase === 'before' ? 'original' : 'patched'} execution receipt has been recorded.</p>}</div>;
  })}{job.checks.some(check => !repairCheckSchema.safeParse(check).success) && <div className="repair-action-note"><p>Some saved check receipts are unreadable. They have not been counted as executed checks.</p><JsonDetails title="All saved check receipts" value={job.checks} /></div>}</section>;
}

function CheckExecution({ check, job, parentArtifacts }: { check: ReturnType<typeof repairCheckSchema.parse>; job: RepairJob; parentArtifacts: unknown[] }) {
  const screenshots = repairCheckArtifacts(job, check, parentArtifacts);
  return <div><p>Process exit code <code>{check.exitCode}</code></p>
    <div className="table-scroll"><table className="scenario-table"><thead><tr><th>Recorded scenario</th><th>API</th><th>Browser</th><th>Stored state</th></tr></thead><tbody>{check.scenarios.map((scenario, index) => <tr key={`${scenario.id}:${index}`}><td><code>{scenario.id}</code></td><td><AssertionBadge assertion={scenario.api} /></td><td><AssertionBadge assertion={scenario.browser} /></td><td><AssertionBadge assertion={scenario.state} /></td></tr>)}</tbody></table></div>
    {check.scenarios.length === 0 && <p>No scenario assertions were recorded for this execution.</p>}
    <section className="artifact-gallery"><div className="artifact-heading"><h4>Repair execution screenshots</h4><span>{screenshots.artifacts.length} linked</span></div><p>These screenshots belong to this {check.phase} execution, not the original scan. Downloads use the parent run's authorization and are checked against the recorded SHA-256.</p>{screenshots.invalidCount > 0 && <p className="artifact-unavailable">{screenshots.invalidCount} screenshot receipts do not match this child execution, browser observation, or parent download record.</p>}{screenshots.artifacts.length ? screenshots.artifacts.map(artifact => <ArtifactScreenshot key={`${artifact.id}:${artifact.sha256}`} runId={job.runId} artifact={artifact} />) : <p className="artifact-unavailable">No matching child-execution screenshot is available. No image has been inferred.</p>}</section>
    <h5>Security controls</h5>
    {check.controls?.length ? <><p>{check.controls.length} of 14 required control receipts recorded. The worker checks their identities, outcomes, and state hashes before verification.</p><div className="table-scroll"><table className="scenario-table"><thead><tr><th>Control</th><th>Recorded outcome</th><th>Expected HTTP</th><th>Actual HTTP</th></tr></thead><tbody>{check.controls.map((control, index) => <tr key={`${control.id}:${index}`}><td><code>{control.id}</code></td><td><Badge tone={control.outcome === 'pass' ? 'green' : 'red'}>{control.outcome}</Badge></td><td>{control.expectedStatus}</td><td>{control.actualStatus}</td></tr>)}</tbody></table></div><JsonDetails title="Control response hashes, state hashes, and collection times" value={check.controls} /></> : <p>No security-control receipts were recorded for this execution. Missing controls do not pass.</p>}
    <dl className="definition-list repair-bindings"><div><dt>Artifact SHA-256</dt><dd><code>{check.artifactHash}</code></dd></div></dl><JsonDetails title="Execution provenance and assertion codes" value={check} />
  </div>;
}
