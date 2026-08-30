'use client';

import Link from 'next/link';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Info,
  ShieldCheck,
} from 'lucide-react';
import { CopyButton } from './copy-button';
import {
  adjacentTab,
  approvalFeatureLabel,
  parseRunTab,
  runTabs,
  type RunTab,
} from '../lib/workspace-presentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiSession, errorMessage, get } from '../lib/api';
import {
  detailSchema,
  eventSchema,
  runSchema,
  scenarios,
  type Config,
  type Project,
  type RunDetail,
  type RunEvent,
} from '../lib/contracts';
import {
  AssertionBadge,
  Badge,
  EmptyState,
  ErrorNotice,
  JsonDetails,
  ModeBadge,
  ReplayNotice,
  RunBadge,
  formatDate,
  shortId,
} from './shared';

import { EvidenceLedger } from './evidence';
import { Finding } from './findings';
import { RunReport } from './report';
import { RepairsPanel } from './repairs';
import { failedFindingId, repairStartBlocker } from '../lib/repair-presentation';

const eventBatchSchema = z.object({
  events: z.array(eventSchema),
  cursor: z.number().int().nonnegative(),
});
const checkoutContinuationSchema = z.object({
  status: z.literal('resumed'),
  turnId: z.string(),
});

export function RunView({
  id,
  api,
  config,
  projects,
  onChanged,
}: {
  id: string;
  api: ApiSession;
  config: Config;
  projects: Project[];
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [tab, updateTab] = useState<RunTab>('scenarios');
  useEffect(() => {
    const readTab = () => updateTab(parseRunTab(window.location.hash));
    readTab();
    window.addEventListener('hashchange', readTab);
    window.addEventListener('popstate', readTab);
    return () => {
      window.removeEventListener('hashchange', readTab);
      window.removeEventListener('popstate', readTab);
    };
  }, []);
  function setTab(next: RunTab) {
    updateTab(next);
    if (window.location.hash !== `#${next}`) window.history.pushState(null, '', `#${next}`);
  }
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorMessage> | null>(null);
  const [readError, setReadError] = useState<ReturnType<typeof errorMessage> | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastRead, setLastRead] = useState<number | null>(null);
  const cursor = useRef(0);
  const polling = useRef(false);
  const actionInFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const [detail, batch] = await Promise.all([
        get(`/runs/${encodeURIComponent(id)}`, detailSchema),
        get(`/runs/${encodeURIComponent(id)}/events?after=${cursor.current}`, eventBatchSchema),
      ]);
      setDetail(detail);
      setEvents((previous) => {
        const bySequence = new Map(previous.map((event) => [event.sequence, event]));
        for (const event of batch.events) bySequence.set(event.sequence, event);
        return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
      });
      cursor.current = Math.max(cursor.current, batch.cursor);
      setConnected(true);
      setReadError(null);
      setLastRead(Date.now());
    } finally {
      polling.current = false;
    }
  }, [id]);
  useEffect(() => {
    let active = true;
    const load = () =>
      refresh().catch((error) => {
        if (active) {
          setReadError(errorMessage(error));
          setConnected(false);
        }
      });
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);

  async function action(name: string, execute: () => Promise<unknown>) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(name);
    setError(null);
    try {
      await execute();
      await refresh();
      onChanged();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      actionInFlight.current = false;
      setBusy(null);
    }
  }
  if (!detail)
    return (
      <>
        <ErrorNotice error={readError} />
        <EmptyState title={readError ? 'Run data is unavailable' : 'Loading the saved run'}>
          {readError
            ? 'The run has not been restarted. Retry the read when the worker is reachable.'
            : 'Restoring observations and the durable event cursor. No new test objects are created.'}
        </EmptyState>
        <button
          className="button secondary"
          onClick={() => {
            setReadError(null);
            void refresh().catch((error) => setReadError(errorMessage(error)));
          }}
        >
          Retry connection
        </button>
      </>
    );
  const { run } = detail;
  const project = projects.find((project) => project.id === run.projectId);
  const pendingApproval =
    run.status === 'awaiting_plan_approval' && run.approval.decision === 'pending';
  const stopping = run.status === 'stopping';
  const expired = Date.now() >= run.approval.expiresAt;
  const failures = detail.scenarios.filter((scenario) =>
    [scenario.api, scenario.browser, scenario.state].some(
      (assertion) => assertion.verdict === 'fail',
    ),
  );
  const assertions = detail.scenarios.flatMap((scenario) => [
    scenario.api,
    scenario.browser,
    scenario.state,
  ]);
  const passed = assertions.filter((assertion) => assertion.verdict === 'pass').length;
  const elapsed = run.startedAt
    ? Math.max(
        0,
        Math.floor(
          ((run.status === 'running' || stopping
            ? Date.now()
            : (events.at(-1)?.occurredAt ?? run.startedAt)) -
            run.startedAt) /
            1000,
        ),
      )
    : 0;
  const stateOnly =
    failures.length > 0 &&
    failures.every(
      (scenario) => scenario.api.verdict !== 'fail' && scenario.browser.verdict !== 'fail',
    );
  async function decide(decision: 'allow' | 'deny') {
    await action(decision, () =>
      api.mutate(
        `/runs/${encodeURIComponent(run.id)}/approvals/${encodeURIComponent(run.approval.id)}`,
        { decision, bindingHash: run.approval.bindingHash },
        runSchema,
      ),
    );
  }
  const requestRepair = async (findingId?: string) => {
    if (repairStartBlocker(detail)) return;
    await action('repair', () =>
      api.mutate(
        `/runs/${encodeURIComponent(run.id)}/repairs`,
        findingId ? { findingId } : {},
        z.unknown(),
      ),
    );
  };

  return (
    <>
      <div className="page-heading run-heading">
        <div>
          <p className="eyebrow">
            {project?.name ?? 'Project'} <span className="description-dot">/</span> Access
            verification
          </p>
          <div className="run-title">
            <h1>Run {shortId(run.id)}</h1>
            <CopyButton value={run.id} label="Copy run ID" />
          </div>
          <p className="page-description">
            Created {formatDate(run.createdAt)} <span className="description-dot">·</span> Build{' '}
            <code>{shortId(run.targetBuild)}</code>
          </p>
        </div>
        <div className="heading-actions">
          <a
            className="button secondary"
            href={`/api/runs/${encodeURIComponent(run.id)}/report?format=markdown`}
            download
          >
            Download report <ArrowDownToLine size={16} aria-hidden="true" />
          </a>
          <button
            className="button danger-subtle"
            disabled={!!busy || stopping || ['completed', 'canceled'].includes(run.status)}
            onClick={() =>
              void action('cancel', () =>
                api.mutate(`/runs/${encodeURIComponent(run.id)}/cancel`, {}, runSchema),
              )
            }
          >
            {busy === 'cancel' || stopping ? 'Stopping…' : 'Stop run'}
          </button>
        </div>
      </div>
      <ErrorNotice error={error} />
      <ErrorNotice error={readError} />
      <ErrorNotice error={detail.runtimeError ?? null} />
      {run.mode === 'local_replay' && <ReplayNotice />}
      {run.mode === 'polar_sandbox' && run.status === 'running' && (
        <section className="panel">
          <h2>Sandbox checkout</h2>
          <p>
            Complete checkout with only Polar&apos;s documented test payment details. Never enter a
            real card. The run pauses durably while checkout is open, so no orchestration request
            has to remain connected while you pay.
          </p>
          <div className="heading-actions">
            <a
              className="button secondary"
              href={`/api/runs/${encodeURIComponent(run.id)}/checkout`}
              target="_blank"
              rel="noreferrer"
            >
              Open sandbox checkout
            </a>
            {detail.runtime?.status === 'waiting_external' && (
              <button
                className="button primary"
                disabled={!!busy}
                onClick={() =>
                  void action('checkout', () =>
                    api.mutate(
                      `/runs/${encodeURIComponent(run.id)}/checkout/continue`,
                      {},
                      checkoutContinuationSchema,
                    ),
                  )
                }
              >
                {busy === 'checkout' ? 'Verifying with Polar…' : 'I completed sandbox checkout'}
              </button>
            )}
          </div>
          {detail.runtime?.status === 'waiting_external' && (
            <p className="muted">
              This does not trust the browser result. PaywallProof resumes only after an owned, paid
              Polar sandbox subscription is independently confirmed.
            </p>
          )}
        </section>
      )}
      <div className="run-summary">
        <div>
          <span className="summary-caption">Run status</span>
          <RunBadge run={run} />
        </div>
        <div>
          <span className="summary-caption">Execution</span>
          <ModeBadge mode={run.mode} />
        </div>
        <div>
          <span className="summary-caption">Required checks passed</span>
          <strong>
            {passed}
            <small> / 12</small>
          </strong>
        </div>
        <div>
          <span className="summary-caption">Elapsed</span>
          <strong>
            {run.startedAt ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : 'Not started'}
          </strong>
        </div>
        <div className="connection-status">
          <span className={`connection-dot ${connected ? 'connected' : ''}`} />
          <span>
            {connected ? 'Connected' : 'Read disconnected'}
            <small>
              {lastRead
                ? `Last read ${new Date(lastRead).toLocaleTimeString()}`
                : 'No saved data read yet'}
            </small>
          </span>
        </div>
      </div>
      {stopping && (
        <div className="coverage-note" role="status">
          <Info size={17} aria-hidden="true" />
          <div>
            <strong>The run is stopping.</strong>
            <p>
              No new scenario may begin. The worker is accounting for in-flight actions and cleanup
              before confirming cancellation. Repair actions remain disabled until stopping
              finishes.
            </p>
          </div>
        </div>
      )}
      {run.status === 'canceled' && (
        <div className="coverage-note">
          <Info size={17} aria-hidden="true" />
          <div>
            <strong>The run is stopped.</strong>
            <p>
              No new scenario is authorized. Check cleanup receipts for remaining fixtures and any
              unresolved cleanup work.
            </p>
          </div>
        </div>
      )}
      {detail.runtime?.error !== undefined && (
        <section className="runtime-warning">
          <Badge tone="amber">Runtime blocked</Badge>
          <p>The orchestration runtime reported an error. Incomplete assertions are not passes.</p>
          <JsonDetails title="Runtime error receipt" value={detail.runtime.error} open />
        </section>
      )}
      {pendingApproval && (
        <section className="approval-panel">
          <div className="approval-heading">
            <span className="approval-icon">
              <ShieldCheck size={23} aria-hidden="true" />
            </span>
            <div>
              <p className="eyebrow">Owner approval required</p>
              <h2>Review exactly what this run may do.</h2>
              <p>
                No fixture creation or billing mutation is authorized until you approve this scope.
              </p>
            </div>
            <Badge tone={expired ? 'red' : 'amber'}>
              {expired ? 'Approval expired' : 'Awaiting decision'}
            </Badge>
          </div>
          <div className="approval-grid">
            <dl className="definition-list">
              <div>
                <dt>Target</dt>
                <dd>{config.target.origin}</dd>
              </div>
              <div>
                <dt>Target build</dt>
                <dd>
                  <code>{run.targetBuild}</code>
                </dd>
              </div>
              <div>
                <dt>Price</dt>
                <dd>
                  <code>{run.policy.priceId}</code>
                </dd>
              </div>
              <div>
                <dt>Feature</dt>
                <dd>{approvalFeatureLabel(run)}</dd>
              </div>
              <div>
                <dt>Execution mode</dt>
                <dd>{run.mode}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{config.model}</dd>
              </div>
              <div>
                <dt>Approval expires</dt>
                <dd>{formatDate(run.approval.expiresAt)}</dd>
              </div>
            </dl>
            <div>
              <h3>Permitted side effects</h3>
              <p>
                Create up to two app users and one run-owned customer, checkout, and subscription.
                Change only that subscription through activation and cancellation. Remove only this
                run's fixtures during cleanup.
              </p>
              <p>
                At most 100 operations and 15 active minutes. Local replay uses synthetic billing
                events and does not create Polar objects.
              </p>
              <p>
                <strong>This approval does not authorize a PR, merge, or deployment.</strong>
              </p>
              <JsonDetails title="Frozen access policy" value={run.policy} />
              <JsonDetails
                title="Approval binding and configured limits"
                value={{
                  approval: run.approval,
                  limits: config.limits,
                  scenarios: scenarios.map((scenario) => scenario.id),
                }}
              />
            </div>
          </div>
          <div className="approval-actions">
            <p>
              If the runtime has not reached its matching approval pause, the server will ask you to
              retry. Expired or changed scope requires a new approval.
            </p>
            <button
              className="button secondary"
              disabled={!!busy || expired}
              onClick={() => void decide('deny')}
            >
              {busy === 'deny' ? 'Denying…' : 'Deny plan'}
            </button>
            <button
              className="button primary"
              disabled={!!busy || expired}
              onClick={() => void decide('allow')}
            >
              {busy === 'allow' ? 'Approving…' : 'Approve test plan'}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </section>
      )}
      <div className="run-tabs" role="tablist" aria-label="Run details">
        {runTabs.map((candidate) => (
          <button
            key={candidate}
            id={`tab-${candidate}`}
            role="tab"
            aria-label={
              candidate === 'evidence'
                ? `Evidence, ${detail.observations.length} observations`
                : candidate === 'findings' && failures.length > 0
                  ? `Findings, ${failures.length} scenarios`
                  : undefined
            }
            aria-selected={tab === candidate}
            tabIndex={tab === candidate ? 0 : -1}
            onKeyDown={(event) => {
              const next = adjacentTab(candidate, event.key);
              if (!next) return;
              event.preventDefault();
              setTab(next);
              document.getElementById(`tab-${next}`)?.focus();
            }}
            aria-controls={`panel-${candidate}`}
            className={tab === candidate ? 'active' : ''}
            onClick={() => setTab(candidate)}
          >
            {candidate[0]?.toUpperCase()}
            {candidate.slice(1)}
            {candidate === 'findings' && failures.length > 0 && (
              <span className="tab-count">{failures.length}</span>
            )}
            {candidate === 'evidence' && <span>{detail.observations.length}</span>}
          </button>
        ))}
      </div>
      <section id={`panel-${tab}`} role="tabpanel" tabIndex={0} aria-labelledby={`tab-${tab}`}>
        {tab === 'scenarios' && (
          <>
            <div className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Subscription lifecycle</h2>
                  <p>
                    {detail.scenarios.length} of 4 scenarios have recorded assertions. API, browser,
                    and stored state are evaluated separately.
                  </p>
                </div>
                <Badge>
                  {assertions.length ? `${assertions.length} checks recorded` : 'Untested'}
                </Badge>
              </div>
              <div className="table-scroll">
                <table className="scenario-table">
                  <thead>
                    <tr>
                      <th>Scenario</th>
                      <th>API access</th>
                      <th>Browser</th>
                      <th>Stored state</th>
                      <th>
                        <span className="sr-only">Inspect scenario</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {scenarios.map((expected) => {
                      const scenario = detail.scenarios.find(
                        (scenario) => scenario.id === expected.id,
                      );
                      return (
                        <tr key={expected.id}>
                          <td>
                            <div className="scenario-cell">
                              <code>{expected.id}</code>
                              <div>
                                <strong>{expected.title}</strong>
                                <span>{expected.description}</span>
                              </div>
                            </div>
                          </td>
                          <td>
                            <AssertionBadge assertion={scenario?.api} />
                          </td>
                          <td>
                            <AssertionBadge assertion={scenario?.browser} />
                          </td>
                          <td>
                            <AssertionBadge assertion={scenario?.state} />
                          </td>
                          <td>
                            {scenario && (
                              <button
                                className="text-button"
                                aria-label={`Inspect ${scenario.id}`}
                                onClick={() => {
                                  setSelectedScenario(scenario.id);
                                  setTab('findings');
                                }}
                              >
                                Inspect <ArrowUpRight size={15} aria-hidden="true" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="two-column">
              <section className="panel summary-panel">
                <h3>What makes a result credible?</h3>
                <p>
                  A passing comparison needs fresh provider state, an application snapshot, an
                  ordinary API probe, and an actual browser action. An HTTP 200 alone is not proof
                  of access.
                </p>
                <p>
                  The final probe must contain the run's private fixture marker to establish
                  success.
                </p>
              </section>
              <section className="panel summary-panel">
                <h3>Runtime and cleanup</h3>
                <div className="runtime-status">
                  <span>Runtime</span>
                  <Badge>{detail.runtime?.status ?? 'Not started'}</Badge>
                </div>
                <JsonDetails title="Runtime receipt" value={detail.runtime} />
                <JsonDetails
                  title="Cleanup receipts and unresolved fixtures"
                  value={detail.cleanup}
                />
              </section>
            </div>
          </>
        )}
        {tab === 'findings' && (
          <div className="panel">
            <div className="panel-heading">
              <div>
                <h2>{selectedScenario ? `Inspect ${selectedScenario}` : 'Recorded findings'}</h2>
                <p>
                  {stateOnly
                    ? 'The recorded failures concern application state. They do not prove an API access leak.'
                    : 'An observed contradiction is separate from a suspected cause in the code.'}
                </p>
              </div>
              {selectedScenario && (
                <button className="text-button" onClick={() => setSelectedScenario(null)}>
                  All findings
                </button>
              )}
            </div>
            {(selectedScenario
              ? detail.scenarios.filter((scenario) => scenario.id === selectedScenario)
              : failures
            ).length ? (
              (selectedScenario
                ? detail.scenarios.filter((scenario) => scenario.id === selectedScenario)
                : failures
              ).map((scenario) => (
                <Finding
                  key={scenario.id}
                  scenario={scenario}
                  detail={detail}
                  onRepair={() => {
                    setTab('repairs');
                    void requestRepair(failedFindingId(scenario));
                  }}
                  busy={!!busy || !!repairStartBlocker(detail)}
                />
              ))
            ) : (
              <EmptyState
                title={
                  detail.scenarios.length ? 'No confirmed failures recorded' : 'No findings yet'
                }
              >
                {detail.scenarios.length
                  ? 'Check scenario coverage before treating an absence of findings as assurance. Untested, skipped, and inconclusive checks do not pass.'
                  : 'Findings appear only after executed behavior contradicts the approved policy.'}
              </EmptyState>
            )}
          </div>
        )}
        {tab === 'evidence' && <EvidenceLedger detail={detail} />}
        {tab === 'report' && (
          <RunReport
            detail={detail}
            reviewing={busy === 'evidence-review'}
            onReview={() =>
              void action('evidence-review', () =>
                api.mutate(`/runs/${encodeURIComponent(run.id)}/evidence-review`, {}, z.unknown()),
              )
            }
          />
        )}
        {tab === 'activity' && (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Run activity</h2>
                <p>
                  Durable events, replayed from sequence {cursor.current}. Reconnecting does not
                  create a new turn.
                </p>
              </div>
              <Badge tone={connected ? 'green' : 'amber'}>
                {connected ? 'Read connection active' : 'Disconnected'}
              </Badge>
            </div>
            {events.length ? (
              <ol className="activity-feed">
                {events.map((event) => (
                  <li key={event.sequence}>
                    <span className="activity-point" />
                    <div>
                      <div className="activity-title">
                        <strong>{event.type.replaceAll('_', ' ')}</strong>
                        <time>{formatDate(event.occurredAt)}</time>
                      </div>
                      <span className="activity-sequence">Event #{event.sequence}</span>
                      <JsonDetails title="Event receipt" value={event.payload} />
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState title="No activity received">
                The worker has not returned durable events for this run.
              </EmptyState>
            )}
          </section>
        )}
        {tab === 'repairs' && (
          <RepairsPanel
            detail={detail}
            busy={busy}
            onRequest={requestRepair}
            onMutation={(name, path, body) =>
              action(name, () => api.mutate(path, body, z.unknown()))
            }
          />
        )}
      </section>
      {detail.coverageLimits.length > 0 && (
        <section className="coverage-note">
          <Info size={17} aria-hidden="true" />
          <div>
            <strong>Coverage and limitations</strong>
            {detail.coverageLimits.map((limit, index) => (
              <p key={index}>{limit}</p>
            ))}
          </div>
        </section>
      )}
      <div className="run-bottom-links">
        <Link href={`/projects/${encodeURIComponent(run.projectId)}`}>
          <ArrowLeft size={15} aria-hidden="true" />
          Back to project
        </Link>
        <div>
          <code title={run.policy.hash}>Policy {shortId(run.policy.hash)}</code>
          <CopyButton value={run.policy.hash} label="Copy policy hash" />
        </div>
      </div>
    </>
  );
}
