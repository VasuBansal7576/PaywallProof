'use client';

import Link from 'next/link';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  CircleCheck,
  FolderGit2,
  ListFilter,
  Plus,
  Search,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { useState } from 'react';
import type { Config, Project, Run } from '../lib/contracts';
import {
  needsAttention,
  newestRuns,
  runFilters,
  visibleRuns,
  type RunFilter,
} from '../lib/workspace-presentation';
import { Badge, EmptyState, ModeBadge, RunBadge, formatDate, shortId } from './shared';
import { CopyButton } from './copy-button';

const filterLabels: Record<RunFilter, string> = {
  all: 'All runs',
  attention: 'Needs attention',
  active: 'Active',
  passed: 'Passed',
  failed: 'Failed',
  inconclusive: 'Inconclusive',
};

export function Overview({
  config,
  projects,
  runs,
}: {
  config: Config;
  projects: Project[];
  runs: Run[];
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RunFilter>('all');
  const sorted = newestRuns(runs);
  const visible = visibleRuns(runs, projects, query, filter);
  const attention = sorted.filter(needsAttention);
  const latest = sorted[0];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Verification workspace</p>
          <h1>Trust the evidence.</h1>
          <p className="page-description">
            Your billing policy, tested against what customers can actually access.
          </p>
        </div>
        <Link className="button primary" href="/projects/new">
          <Plus size={17} aria-hidden="true" />
          Connect project
        </Link>
      </div>
      <div className="overview-grid">
        <section className="latest-run">
          <div className="section-kicker">
            <span className="live-dot" />
            Latest recorded run
          </div>
          {latest ? (
            <>
              <div className="latest-run-heading">
                <h2>
                  {projects.find((project) => project.id === latest.projectId)?.name ??
                    'Saved project'}
                </h2>
                <RunBadge run={latest} />
              </div>
              <p className="latest-description">
                {latest.outcome === 'passed'
                  ? 'The recorded assertions passed for this build and policy.'
                  : latest.outcome === 'failed'
                    ? 'The observed behavior contradicts the approved policy.'
                    : latest.outcome === 'inconclusive'
                      ? 'This run could not establish a complete result.'
                      : 'Review the saved run for execution progress and next steps.'}
              </p>
              <div className="latest-binding">
                <code>{shortId(latest.id)}</code>
                <CopyButton value={latest.id} label="Copy latest run ID" />
                <ModeBadge mode={latest.mode} />
              </div>
              <div className="latest-run-footer">
                <span>{formatDate(latest.createdAt)}</span>
                <Link
                  href={`/runs/${encodeURIComponent(latest.id)}`}
                  className="button primary small"
                >
                  Open run
                  <ArrowUpRight size={16} aria-hidden="true" />
                </Link>
              </div>
            </>
          ) : (
            <>
              <h2>Your first proof starts here.</h2>
              <p className="latest-description">
                Connect a project, define its access policy, then approve the test plan. No test has
                run yet.
              </p>
              <Link href="/projects/new" className="button primary">
                Connect a project
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </>
          )}
        </section>
        <section className="workspace-pulse" aria-label="Workspace totals">
          <div className="pulse-heading">
            <span>Workspace at a glance</span>
            <ShieldCheck size={18} aria-hidden="true" />
          </div>
          <div className="pulse-stats">
            <div>
              <strong>{runs.length}</strong>
              <span>recorded runs</span>
            </div>
            <div>
              <strong>{projects.length}</strong>
              <span>projects</span>
            </div>
            <div>
              <strong>{runs.filter((run) => run.outcome === 'passed').length}</strong>
              <span>passed runs</span>
            </div>
            <div>
              <strong>{attention.length}</strong>
              <span>need attention</span>
            </div>
          </div>
          <p>Counts come from saved runs. Local replay does not verify provider delivery.</p>
        </section>
      </div>
      <div className="workspace-section-heading">
        <div>
          <h2>Projects</h2>
          <span>{projects.length} connected</span>
        </div>
        <Link className="text-button" href="/projects/new">
          Add project
          <Plus size={15} aria-hidden="true" />
        </Link>
      </div>
      {projects.length ? (
        <div className="project-cards">
          {projects.map((project) => {
            const projectRuns = sorted.filter((run) => run.projectId === project.id);
            const last = projectRuns[0];
            return (
              <Link
                href={`/projects/${encodeURIComponent(project.id)}`}
                className="project-card"
                key={project.id}
              >
                <div className="project-card-top">
                  <span className="project-avatar">
                    <FolderGit2 size={21} aria-hidden="true" />
                  </span>
                  <ArrowUpRight size={17} aria-hidden="true" />
                </div>
                <h3>{project.name}</h3>
                <p title={project.repository}>{project.repository}</p>
                <div className="project-card-meta">
                  <code>{project.ref}</code>
                  <span>
                    {projectRuns.length} {projectRuns.length === 1 ? 'run' : 'runs'}
                  </span>
                </div>
                <div className="project-card-bottom">
                  {last ? <RunBadge run={last} /> : <Badge>Untested</Badge>}
                  <span>
                    Open project
                    <ArrowRight size={14} aria-hidden="true" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <section className="panel">
          <EmptyState
            title="No connected projects"
            action={
              <Link className="button secondary" href="/projects/new">
                Connect a staging app
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            }
          >
            Start with your owned repository and staging target. Nothing runs before you approve its
            scope.
          </EmptyState>
        </section>
      )}
      <section className="attention-strip" aria-label="Decisions and follow-up">
        <div className="attention-label">
          {attention.length ? (
            <ListFilter size={19} aria-hidden="true" />
          ) : (
            <CircleCheck size={19} aria-hidden="true" />
          )}
          <div>
            <strong>
              {attention.length
                ? `${attention.length} ${attention.length === 1 ? 'run needs' : 'runs need'} attention`
                : 'No runs need attention'}
            </strong>
            <p>
              {attention.length
                ? 'Review pending plans, confirmed failures and incomplete results.'
                : 'There are no pending plans, failed runs or inconclusive runs in the saved list.'}
            </p>
          </div>
        </div>
        {attention.length > 0 && (
          <button
            className="text-button"
            onClick={() => {
              setQuery('');
              setFilter('attention');
              document.getElementById('runs-heading')?.scrollIntoView({ block: 'start' });
            }}
          >
            Review queue
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        )}
      </section>
      <section className="panel runs-panel" aria-labelledby="runs-heading">
        <div className="panel-heading">
          <div>
            <h2 id="runs-heading">Run history</h2>
            <p>Every saved run, including blocked and incomplete work.</p>
          </div>
          <span className="count-label" role="status">
            {visible.length} of {runs.length} runs
          </span>
        </div>
        <div className="run-toolbar">
          <label className="search-field">
            <Search size={17} aria-hidden="true" />
            <span className="sr-only">Search runs</span>
            <input
              type="search"
              placeholder="Search project, run ID or build…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="run-filters" role="group" aria-label="Filter runs">
            {runFilters.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={filter === candidate}
                onClick={() => setFilter(candidate)}
              >
                {filterLabels[candidate]}
              </button>
            ))}
          </div>
        </div>
        {visible.length ? (
          <div className="table-scroll">
            <table>
              <caption className="sr-only">Saved verification runs</caption>
              <thead>
                <tr>
                  <th scope="col">Run / project</th>
                  <th scope="col">Result</th>
                  <th scope="col">Execution</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className="sr-only">Open run</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((run) => (
                  <tr key={run.id} data-run-id={run.id}>
                    <td>
                      <div className="table-primary">
                        <Link
                          className="table-link"
                          href={`/runs/${encodeURIComponent(run.id)}`}
                          title={run.id}
                        >
                          {shortId(run.id)}
                        </Link>
                        <CopyButton value={run.id} label={`Copy run ID ${run.id}`} />
                      </div>
                      <span className="table-secondary">
                        {projects.find((project) => project.id === run.projectId)?.name ??
                          run.projectId}
                      </span>
                    </td>
                    <td>
                      <RunBadge run={run} />
                    </td>
                    <td>
                      <ModeBadge mode={run.mode} />
                    </td>
                    <td>
                      <time dateTime={new Date(run.createdAt).toISOString()}>
                        {formatDate(run.createdAt)}
                      </time>
                    </td>
                    <td>
                      <Link
                        className="icon-button"
                        href={`/runs/${encodeURIComponent(run.id)}`}
                        aria-label={`Open run ${run.id}`}
                      >
                        <ArrowUpRight size={17} aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={runs.length ? 'No matching runs' : 'No runs recorded'}
            action={
              runs.length ? (
                <button
                  className="button secondary"
                  onClick={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                >
                  Clear filters
                </button>
              ) : undefined
            }
          >
            {runs.length
              ? 'Try another project name, identifier or result filter.'
              : 'A saved policy describes the expected rule. Start an approved run to collect evidence.'}
          </EmptyState>
        )}
      </section>
      <section className="agent-handoff">
        <Terminal size={21} aria-hidden="true" />
        <div>
          <h3>Same proof. Human or agent.</h3>
          <p>
            Run pages have stable links, full identifiers and structured JSON reports. The exported
            evidence is the same evidence shown here.
          </p>
        </div>
        {latest && (
          <a
            className="button secondary small"
            href={`/api/runs/${encodeURIComponent(latest.id)}/report?format=json`}
            download
          >
            <ArrowDownToLine size={15} aria-hidden="true" />
            Latest run JSON
          </a>
        )}
      </section>
      <details className="coverage-details">
        <summary>Execution boundaries &amp; coverage limits</summary>
        <div>
          <p>
            {config.polarConfigured
              ? 'Polar credentials are configured. Each sandbox run must still pass preflight.'
              : 'Polar credentials are not configured. Local replay is available separately.'}
          </p>
          {config.coverageLimits.map((limit, index) => (
            <p key={index}>{limit}</p>
          ))}
        </div>
      </details>
    </>
  );
}
