'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiSession, errorMessage, get } from '../lib/api';
import { detailSchema, eventSchema, runSchema, scenarios, type Config, type Project, type RunDetail, type RunEvent, type Scenario } from '../lib/contracts';
import { Badge, EmptyState, ErrorNotice, JsonDetails, ModeBadge, ReplayNotice, RunBadge, formatDate, shortId } from './shared';

type Tab = 'scenarios' | 'findings' | 'evidence' | 'activity' | 'repairs';
const eventBatchSchema = z.object({ events: z.array(eventSchema), cursor: z.number().int().nonnegative() });

export function RunView({ id, api, config, projects, onChanged }: { id: string; api: ApiSession; config: Config; projects: Project[]; onChanged: () => void }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [tab, setTab] = useState<Tab>('scenarios');
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorMessage> | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastRead, setLastRead] = useState<number | null>(null);
  const cursor = useRef(0);
  const polling = useRef(false);
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const [detail, batch] = await Promise.all([get(`/runs/${encodeURIComponent(id)}`, detailSchema), get(`/runs/${encodeURIComponent(id)}/events?after=${cursor.current}`, eventBatchSchema)]);
      setDetail(detail);
      setEvents(previous => {
        const bySequence = new Map(previous.map(event => [event.sequence, event]));
        for (const event of batch.events) bySequence.set(event.sequence, event);
        return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
      });
      cursor.current = Math.max(cursor.current, batch.cursor);
      setConnected(true); setLastRead(Date.now());
    } finally { polling.current = false; }
  }, [id]);
  useEffect(() => {
    let active = true;
    const load = () => refresh().catch(error => { if (active) { setError(errorMessage(error)); setConnected(false); } });
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [refresh]);

  async function action(name: string, execute: () => Promise<unknown>) {
    setBusy(name); setError(null);
    try { await execute(); await refresh(); onChanged(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(null); }
  }
  if (!detail) return <><ErrorNotice error={error} /><EmptyState title={error ? 'Run data is unavailable' : 'Loading the saved run'}>{error ? 'The run has not been restarted. Retry the read when the worker is reachable.' : 'Restoring observations and the durable event cursor. No new test objects are created.'}</EmptyState><button className="button secondary" onClick={() => { setError(null); void refresh().catch(error => setError(errorMessage(error))); }}>Retry connection</button></>;
  const { run } = detail;
  const project = projects.find(project => project.id === run.projectId);
  const pendingApproval = run.status === 'awaiting_plan_approval' && run.approval.decision === 'pending';
  const expired = Date.now() >= run.approval.expiresAt;
  const failures = detail.scenarios.filter(scenario => [scenario.api, scenario.browser, scenario.state].some(assertion => assertion.verdict === 'fail'));
  const assertions = detail.scenarios.flatMap(scenario => [scenario.api, scenario.browser, scenario.state]);
  const passed = assertions.filter(assertion => assertion.verdict === 'pass').length;
  const elapsed = run.startedAt ? Math.max(0, Math.floor(((run.status === 'running' ? Date.now() : events.at(-1)?.occurredAt ?? run.startedAt) - run.startedAt) / 1000)) : 0;
  const stateOnly = failures.length > 0 && failures.every(scenario => scenario.api.verdict !== 'fail' && scenario.browser.verdict !== 'fail');
  async function decide(decision: 'allow' | 'deny') {
    await action(decision, () => api.mutate(`/runs/${encodeURIComponent(run.id)}/approvals/${encodeURIComponent(run.approval.id)}`, { decision, bindingHash: run.approval.bindingHash }, runSchema));
  }
  const requestRepair = () => action('repair', () => api.mutate(`/runs/${encodeURIComponent(run.id)}/repairs`, {}, z.unknown()));

  return <><div className="page-heading run-heading"><div><p className="eyebrow">{project?.name ?? 'Project'} <span className="description-dot">/</span> Access verification</p><h1>Run {shortId(run.id)}</h1><p className="page-description">Created {formatDate(run.createdAt)} <span className="description-dot">·</span> Build <code>{shortId(run.targetBuild)}</code></p></div><div className="heading-actions"><a className="button secondary" href={`/api/runs/${encodeURIComponent(run.id)}/report?format=markdown`} download>Download report <span aria-hidden="true">↓</span></a><button className="button danger-subtle" disabled={!!busy || ['completed', 'canceled'].includes(run.status)} onClick={() => void action('cancel', () => api.mutate(`/runs/${encodeURIComponent(run.id)}/cancel`, {}, runSchema))}>{busy === 'cancel' ? 'Stopping…' : 'Stop run'}</button></div></div>
    <ErrorNotice error={error} />
    <ErrorNotice error={detail.runtimeError ?? null} />
    {run.mode === 'local_replay' && <ReplayNotice />}
    <div className="run-summary"><div><span className="summary-caption">Run status</span><RunBadge run={run} /></div><div><span className="summary-caption">Execution</span><ModeBadge mode={run.mode} /></div><div><span className="summary-caption">Required checks passed</span><strong>{passed}<small> / 12</small></strong></div><div><span className="summary-caption">Elapsed</span><strong>{run.startedAt ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : 'Not started'}</strong></div><div className="connection-status"><span className={`connection-dot ${connected ? 'connected' : ''}`} /><span>{connected ? 'Connected' : 'Read disconnected'}<small>{lastRead ? `Last read ${new Date(lastRead).toLocaleTimeString()}` : 'No saved data read yet'}</small></span></div></div>
    {run.status === 'canceled' && <div className="coverage-note"><span aria-hidden="true">ⓘ</span><div><strong>The run is stopped.</strong><p>An action already in flight may finish and be reconciled. No new scenario is authorized. Check cleanup receipts for remaining fixtures.</p></div></div>}
    {detail.runtime?.error !== undefined && <section className="runtime-warning"><Badge tone="amber">Runtime blocked</Badge><p>The orchestration runtime reported an error. Incomplete assertions are not passes.</p><JsonDetails title="Runtime error receipt" value={detail.runtime.error} open /></section>}
    {pendingApproval && <section className="approval-panel"><div className="approval-heading"><span className="approval-icon" aria-hidden="true">◇</span><div><p className="eyebrow">Owner approval required</p><h2>Review exactly what this run may do.</h2><p>No fixture creation or billing mutation is authorized until you approve this scope.</p></div><Badge tone={expired ? 'red' : 'amber'}>{expired ? 'Approval expired' : 'Awaiting decision'}</Badge></div><div className="approval-grid"><dl className="definition-list"><div><dt>Target</dt><dd>{config.target.origin}</dd></div><div><dt>Target build</dt><dd><code>{run.targetBuild}</code></dd></div><div><dt>Price</dt><dd><code>{run.policy.priceId}</code></dd></div><div><dt>Feature</dt><dd>Pro export · ordinary session</dd></div><div><dt>Execution mode</dt><dd>{run.mode}</dd></div><div><dt>Model</dt><dd>{config.model}</dd></div><div><dt>Approval expires</dt><dd>{formatDate(run.approval.expiresAt)}</dd></div></dl><div><h3>Permitted side effects</h3><p>Create up to two app users and one run-owned customer, clock, and subscription. Change only that subscription through activation and cancellation. Remove only this run's fixtures during cleanup.</p><p>At most 100 operations and 15 active minutes. Local replay uses synthetic billing events and does not create Stripe objects.</p><p><strong>This approval does not authorize a PR, merge, or deployment.</strong></p><JsonDetails title="Frozen access policy" value={run.policy} /><JsonDetails title="Approval binding and configured limits" value={{ approval: run.approval, limits: config.limits, scenarios: scenarios.map(scenario => scenario.id) }} /></div></div><div className="approval-actions"><p>If the runtime has not reached its matching approval pause, the server will ask you to retry. Expired or changed scope requires a new approval.</p><button className="button secondary" disabled={!!busy || expired} onClick={() => void decide('deny')}>{busy === 'deny' ? 'Denying…' : 'Deny plan'}</button><button className="button primary" disabled={!!busy || expired} onClick={() => void decide('allow')}>{busy === 'allow' ? 'Approving…' : 'Approve test plan'}<span aria-hidden="true">→</span></button></div></section>}
    <div className="run-tabs" role="tablist" aria-label="Run details">{(['scenarios', 'findings', 'evidence', 'activity', 'repairs'] satisfies Tab[]).map(candidate => <button key={candidate} id={`tab-${candidate}`} role="tab" aria-selected={tab === candidate} aria-controls={`panel-${candidate}`} className={tab === candidate ? 'active' : ''} onClick={() => setTab(candidate)}>{candidate[0]?.toUpperCase()}{candidate.slice(1)}{candidate === 'findings' && failures.length > 0 && <span className="tab-count">{failures.length}</span>}{candidate === 'evidence' && <span>{detail.observations.length}</span>}</button>)}</div>
    <section id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
      {tab === 'scenarios' && <><div className="panel"><div className="panel-heading"><div><h2>Subscription lifecycle</h2><p>{detail.scenarios.length} of 4 scenarios have recorded assertions. API, browser, and stored state are evaluated separately.</p></div><Badge>{assertions.length ? `${assertions.length} checks recorded` : 'Untested'}</Badge></div><div className="table-scroll"><table className="scenario-table"><thead><tr><th>Scenario</th><th>API access</th><th>Browser</th><th>Stored state</th><th /></tr></thead><tbody>{scenarios.map(expected => { const scenario = detail.scenarios.find(scenario => scenario.id === expected.id); return <tr key={expected.id}><td><div className="scenario-cell"><code>{expected.id}</code><div><strong>{expected.title}</strong><span>{expected.description}</span></div></div></td><td><AssertionBadge assertion={scenario?.api} /></td><td><AssertionBadge assertion={scenario?.browser} /></td><td><AssertionBadge assertion={scenario?.state} /></td><td>{scenario && <button className="text-button" onClick={() => { setSelectedScenario(scenario.id); setTab('findings'); }}>Inspect <span aria-hidden="true">↗</span></button>}</td></tr>; })}</tbody></table></div></div><div className="two-column"><section className="panel summary-panel"><h3>What makes a result credible?</h3><p>A passing comparison needs fresh provider state, an application snapshot, an ordinary API probe, and an actual browser action. An HTTP 200 alone is not proof of access.</p><p>The final probe must contain the run's private fixture marker to establish success.</p></section><section className="panel summary-panel"><h3>Runtime and cleanup</h3><div className="runtime-status"><span>Runtime</span><Badge>{detail.runtime?.status ?? 'Not started'}</Badge></div><JsonDetails title="Runtime receipt" value={detail.runtime} /><JsonDetails title="Cleanup receipts and unresolved fixtures" value={detail.cleanup} /></section></div></>}
      {tab === 'findings' && <div className="panel"><div className="panel-heading"><div><h2>{selectedScenario ? `Inspect ${selectedScenario}` : 'Recorded findings'}</h2><p>{stateOnly ? 'The recorded failures concern application state. They do not prove an API access leak.' : 'An observed contradiction is separate from a suspected cause in the code.'}</p></div>{selectedScenario && <button className="text-button" onClick={() => setSelectedScenario(null)}>All findings</button>}</div>{(selectedScenario ? detail.scenarios.filter(scenario => scenario.id === selectedScenario) : failures).length ? (selectedScenario ? detail.scenarios.filter(scenario => scenario.id === selectedScenario) : failures).map(scenario => <Finding key={scenario.id} scenario={scenario} detail={detail} onRepair={() => { setTab('repairs'); void requestRepair(); }} busy={!!busy} />) : <EmptyState title={detail.scenarios.length ? 'No confirmed failures recorded' : 'No findings yet'}>{detail.scenarios.length ? 'Check scenario coverage before treating an absence of findings as assurance. Untested, skipped, and inconclusive checks do not pass.' : 'Findings appear only after executed behavior contradicts the approved policy.'}</EmptyState>}</div>}
      {tab === 'evidence' && <section className="panel"><div className="panel-heading"><div><h2>Evidence ledger</h2><p>Persisted, redacted observations. Raw traces stay collapsed.</p></div><a className="button secondary small" href={`/api/runs/${encodeURIComponent(run.id)}/report?format=json`} download>Download JSON ↓</a></div><div className="panel-inset">{detail.observations.length ? detail.observations.map((observation, index) => <JsonDetails key={index} title={observationTitle(observation, index)} value={observation} />) : <EmptyState title="No observations collected">No provider snapshot, application state, API response, or browser result has been recorded for this run.</EmptyState>}</div></section>}
      {tab === 'activity' && <section className="panel"><div className="panel-heading"><div><h2>Run activity</h2><p>Durable events, replayed from sequence {cursor.current}. Reconnecting does not create a new turn.</p></div><Badge tone={connected ? 'green' : 'amber'}>{connected ? 'Read connection active' : 'Disconnected'}</Badge></div>{events.length ? <ol className="activity-feed">{events.map(event => <li key={event.sequence}><span className="activity-point" /><div><div className="activity-title"><strong>{event.type.replaceAll('_', ' ')}</strong><time>{formatDate(event.occurredAt)}</time></div><span className="activity-sequence">Event #{event.sequence}</span><JsonDetails title="Event receipt" value={event.payload} /></div></li>)}</ol> : <EmptyState title="No activity received">The worker has not returned durable events for this run.</EmptyState>}</section>}
      {tab === 'repairs' && <section className="panel"><div className="panel-heading"><div><h2>Finding and repair</h2><p>Review a bounded patch, its reproduction, and verification limits before publication.</p></div><button className="button primary" disabled={!!busy || !failures.length} onClick={() => void requestRepair()}>{busy === 'repair' ? 'Requesting repair…' : 'Prepare repair'}</button></div><div className="panel-inset"><div className="coverage-note"><span aria-hidden="true">◇</span><div><strong>Preparing a repair does not publish or deploy it.</strong><p>The original run keeps its recorded outcome. A local replay verification cannot become a Stripe sandbox pass.</p></div></div>{detail.repairs.length ? detail.repairs.map((repair, index) => <Repair key={index} repair={repair} index={index} />) : <EmptyState title={failures.length ? 'No repair prepared' : 'A verified failure is required'}>{failures.length ? 'Prepare repair asks the controller for an isolated checkout, a narrow change, and the unchanged reproduction. Missing infrastructure is reported as a blocker.' : 'There is no recorded failure to repair. Inconclusive evidence must be resolved before changing application code.'}</EmptyState>}<div className="publication-note"><h3>Publication requires a separate approval</h3><p>No publication action is exposed by the current worker contract. A patch must provide its exact diff, destination, tests, and approval binding before a PR can be published. Nothing is merged or deployed automatically.</p></div></div></section>}
    </section>
    {detail.coverageLimits.length > 0 && <section className="coverage-note"><span aria-hidden="true">ⓘ</span><div><strong>Coverage and limitations</strong>{detail.coverageLimits.map((limit, index) => <p key={index}>{limit}</p>)}</div></section>}
    <div className="run-bottom-links"><Link href={`/projects/${encodeURIComponent(run.projectId)}`}>← Back to project</Link><code>Policy {shortId(run.policy.hash)}</code></div>
  </>;
}

function AssertionBadge({ assertion }: { assertion?: Scenario['api'] }) {
  if (!assertion) return <Badge>Untested</Badge>;
  return <span title={assertion.code}><Badge tone={assertion.verdict === 'pass' ? 'green' : assertion.verdict === 'fail' ? 'red' : assertion.verdict === 'inconclusive' ? 'amber' : 'neutral'}>{assertion.verdict}</Badge></span>;
}

function Finding({ scenario, detail, onRepair, busy }: { scenario: Scenario; detail: RunDetail; onRepair: () => void; busy: boolean }) {
  const apiFailed = scenario.api.verdict === 'fail';
  const browserFailed = scenario.browser.verdict === 'fail';
  const stateFailed = scenario.state.verdict === 'fail';
  const title = scenario.api.code === 'PROTECTED_DATA_LEAK' ? 'Protected data was returned when access should be denied.' : scenario.api.code === 'PAID_ACCESS_DENIED' ? 'A confirmed paying user was denied protected access.' : apiFailed ? 'The API response contradicts the approved access policy.' : browserFailed ? 'The browser result contradicts the approved policy.' : stateFailed ? 'Stored application state differs from provider state.' : 'Recorded scenario evidence';
  const relevant = detail.observations.filter(observation => {
    const parsed = z.object({ id: z.string() }).safeParse(observation);
    return parsed.success && scenario.observationIds.includes(parsed.data.id);
  });
  return <article className="finding"><div className="finding-topline"><code>{scenario.id}</code><Badge tone={apiFailed ? 'red' : browserFailed || stateFailed ? 'amber' : 'neutral'}>{apiFailed ? 'High · Access mismatch' : stateFailed ? 'Medium · State drift' : browserFailed ? 'Medium · UI mismatch' : 'Evidence inspection'}</Badge></div><h3>{title}</h3><div className="finding-grid"><div><h4>Expected behavior</h4><p>{['SC02', 'SC03'].includes(scenario.id) ? 'An active subscription for the configured price with a paid initial invoice allows the protected export. Scheduled cancellation preserves access before the boundary.' : scenario.id === 'SC01' ? 'An authenticated user with no subscription is denied the protected export without receiving fixture data.' : 'After Stripe confirms cancellation and the synchronization window passes, the protected export is denied without returning fixture data.'}</p></div><div><h4>Observed behavior</h4><dl className="finding-assertions"><div><dt>API</dt><dd><AssertionBadge assertion={scenario.api} /><code>{scenario.api.code}</code></dd></div><div><dt>Browser</dt><dd><AssertionBadge assertion={scenario.browser} /><code>{scenario.browser.code}</code></dd></div><div><dt>Stored state</dt><dd><AssertionBadge assertion={scenario.state} /><code>{scenario.state.code}</code></dd></div></dl></div></div><h4>Evidence and reproduction</h4><p>Use scenario {scenario.id}, the immutable policy, target build, and linked observations in the report. A rerun must create fresh fixtures; do not reuse this lifecycle's canceled subscription.</p><JsonDetails title={`${scenario.observationIds.length} evidence references`} value={scenario.observationIds} />{relevant.map((observation, index) => <JsonDetails key={index} title={observationTitle(observation, index)} value={observation} />)}<div className="finding-limit"><strong>What remains uncertain</strong><p>No source-code cause is established by this observation alone. {detail.run.mode === 'local_replay' ? 'This run used local replay and does not verify real Stripe webhook delivery.' : 'Use the report to review synchronization, evidence freshness, and any remaining coverage limits.'}</p></div>{(apiFailed || browserFailed || stateFailed) && <button className="button secondary" disabled={busy} onClick={onRepair}>Prepare repair <span aria-hidden="true">↗</span></button>}</article>;
}

function observationTitle(value: unknown, index: number) {
  const metadata = z.object({ id: z.string(), source: z.string(), scenarioId: z.string() }).safeParse(value);
  return metadata.success ? `${metadata.data.scenarioId} · ${metadata.data.source} · ${shortId(metadata.data.id)}` : `Observation ${index + 1}`;
}

function Repair({ repair, index }: { repair: unknown; index: number }) {
  const parsed = z.object({ status: z.string().optional(), diff: z.string().optional(), checks: z.unknown().optional(), mode: z.string().optional() }).safeParse(repair);
  return <article className="repair-card"><div className="panel-heading compact"><h3>Repair {index + 1}</h3><Badge>{parsed.success ? parsed.data.status ?? 'Receipt recorded' : 'Receipt recorded'}</Badge></div>{parsed.success && parsed.data.mode === 'local_replay' && <ReplayNotice />}{parsed.success && parsed.data.diff && <details className="diff-view" open><summary>Proposed diff</summary><pre>{parsed.data.diff}</pre></details>}{parsed.success && parsed.data.checks !== undefined && <JsonDetails title="Verification evidence" value={parsed.data.checks} />}<JsonDetails title="Complete repair receipt" value={repair} /></article>;
}
