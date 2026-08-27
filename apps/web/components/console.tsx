'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { ApiSession, errorMessage, get, login } from '../lib/api';
import { configSchema, projectSchema, runSchema, type Config, type Project, type Run } from '../lib/contracts';
import { Badge, EmptyState, ErrorNotice, ModeBadge, RunBadge, formatDate, shortId } from './shared';
import { ProjectSetup, ProjectView } from './project';
import { RunView } from './run';

type View = { kind: 'overview' } | { kind: 'new_project' } | { kind: 'project'; id: string } | { kind: 'run'; id: string };
type DashboardData = { config: Config; projects: Project[]; runs: Run[] };

export function Console({ view }: { view: View }) {
  const router = useRouter();
  const [session, setSession] = useState<ApiSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [token, setToken] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorMessage> | null>(null);

  useEffect(() => {
    let active = true;
    get('/session', z.object({ csrfToken: z.string() })).then(result => { if (active) setSession(new ApiSession(result.csrfToken)); }).catch(error => {
      const parsed = errorMessage(error);
      if (active && !['AUTH_REQUIRED', 'UNAUTHORIZED', 'HTTP_401', 'AUTHENTICATION_REQUIRED'].includes(parsed.code)) setError(parsed);
    }).finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, []);
  const refresh = useCallback(async () => {
    const [config, projects, runs] = await Promise.all([get('/config', configSchema), get('/projects', z.array(projectSchema)), get('/runs', z.array(runSchema))]);
    setData({ config, projects, runs });
  }, []);
  useEffect(() => {
    if (!session) return;
    let active = true;
    const load = () => refresh().catch(error => { if (active) setError(errorMessage(error)); });
    void load();
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 6000);
    return () => { active = false; clearInterval(interval); };
  }, [session, refresh]);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setLoggingIn(true); setError(null);
    try { setSession(new ApiSession(await login(token))); setToken(''); }
    catch (error) { setError(errorMessage(error)); }
    finally { setLoggingIn(false); }
  }

  const currentProject = data?.projects.find(project => view.kind === 'project' && project.id === view.id);
  const failedRuns = data?.runs.filter(run => run.outcome === 'failed').length ?? 0;
  return <div className="console-shell">
    <aside className="sidebar"><Link href="/" className="brand"><span className="brand-icon" aria-hidden="true">P<span /></span>paywallproof<span className="beta">BETA</span></Link><div className="workspace-switcher"><span className="workspace-avatar">L</span><div><strong>Local workspace</strong><span>Single operator</span></div><span aria-hidden="true">⌄</span></div><div className="nav-caption">WORKSPACE</div><nav aria-label="Main navigation"><Link className={view.kind === 'overview' ? 'nav-item active' : 'nav-item'} href="/"><span aria-hidden="true">▦</span>Overview</Link><Link className={view.kind === 'new_project' ? 'nav-item active' : 'nav-item'} href="/projects/new"><span aria-hidden="true">⊕</span>Connect project</Link></nav><div className="nav-heading"><span className="nav-caption">PROJECTS</span><Link href="/projects/new" aria-label="Connect a project">+</Link></div>{data?.projects.length ? <nav aria-label="Projects">{data.projects.map(project => <Link key={project.id} href={`/projects/${encodeURIComponent(project.id)}`} className={view.kind === 'project' && view.id === project.id ? 'nav-item active' : 'nav-item'}><span className="project-dot" />{project.name}</Link>)}</nav> : <p className="sidebar-empty">No projects connected</p>}<div className="nav-caption run-caption">RECENT RUNS</div>{data?.runs.length ? <nav aria-label="Recent runs">{data.runs.slice(0, 5).map(run => <Link key={run.id} href={`/runs/${encodeURIComponent(run.id)}`} className={view.kind === 'run' && view.id === run.id ? 'nav-item active small' : 'nav-item small'}><span className={`run-dot ${run.outcome ?? run.status}`} />{shortId(run.id)}</Link>)}</nav> : <p className="sidebar-empty">Your first run starts here</p>}<div className="sidebar-bottom"><div className="safety-mini"><span aria-hidden="true">◇</span><div><strong>Sandbox only</strong><p>No live billing. No auto-deploy.</p></div></div><div className="operator"><span className="operator-avatar">O</span><div><strong>Local operator</strong><span>{session ? 'Authenticated session' : 'Session required'}</span></div></div></div></aside>
    <div className="console-body"><header className="topbar"><div className="breadcrumbs"><Link href="/">Workspace</Link><span>/</span><strong>{view.kind === 'overview' ? 'Overview' : view.kind === 'new_project' ? 'Connect project' : view.kind === 'project' ? currentProject?.name ?? 'Project' : 'Run details'}</strong></div><div className="topbar-status"><span className="local-indicator" />Local environment<Badge>v0.1</Badge></div></header>
      <main id="main-content" className="page-content">
        {checkingSession ? <div className="loading-state" role="status">Restoring your session…</div> : !session ? <section className="login-layout"><div><p className="eyebrow">Subscription access, verified</p><h1>Know who gets<br />through your paywall.</h1><p className="page-description">Compare your billing policy with what an ordinary customer can actually do. Every result has evidence. Every change needs your approval.</p><div className="login-principles"><span>01 <strong>Set the rule</strong></span><span>02 <strong>Test real access</strong></span><span>03 <strong>Review the proof</strong></span></div></div><form className="panel login-card" onSubmit={event => void submitLogin(event)}><div className="section-icon" aria-hidden="true">⌁</div><h2>Open your workspace</h2><p>Use the operator token created by the local launcher. It stays between this browser and your worker.</p><label htmlFor="operator-token">Operator token</label><input id="operator-token" type="password" required value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste your local operator token" /><p className="field-hint">Find it in <code>.local/operator-token</code> after running <code>pnpm dev</code>.</p><ErrorNotice error={error} /><button className="button primary wide" disabled={loggingIn}>{loggingIn ? 'Opening workspace…' : 'Open workspace'}<span aria-hidden="true">→</span></button><p className="login-footnote">No hosted account. No production billing access.</p></form></section> : <>
          <ErrorNotice error={error} />
          {!data ? <div className="loading-state" role="status">Loading saved projects and runs… <button className="text-button" onClick={() => { setError(null); void refresh().catch(error => setError(errorMessage(error))); }}>Retry</button></div> : <>
            {view.kind === 'overview' && <><div className="page-heading"><div><p className="eyebrow">Your access, accounted for</p><h1>Workspace overview</h1><p className="page-description">Make sure your paywall keeps the promise your billing makes.</p></div><Link className="button primary" href="/projects/new"><span aria-hidden="true">+</span> Connect project</Link></div><div className="metric-grid"><Metric title="Connected projects" value={String(data.projects.length)} detail="Owned reference integrations" /><Metric title="Recorded runs" value={String(data.runs.length)} detail={data.runs.length ? 'Persisted in your local workspace' : 'No tests have been executed'} /><Metric title="Failed runs" value={data.runs.length ? String(failedRuns) : '—'} detail="Based on recorded assertions" /><Metric title="Awaiting approval" value={String(data.runs.filter(run => run.status === 'awaiting_plan_approval').length)} detail="Nothing executes before approval" /></div>
              <section className="panel"><div className="panel-heading"><div><h2>Projects</h2><p>One protected feature. A complete subscription lifecycle.</p></div><span className="count-label">{data.projects.length} connected</span></div>{data.projects.length ? <div className="project-list">{data.projects.map(project => { const runs = data.runs.filter(run => run.projectId === project.id); const latest = runs[0]; return <Link className="project-row" key={project.id} href={`/projects/${encodeURIComponent(project.id)}`}><span className="project-avatar">{project.name.slice(0, 1).toUpperCase()}</span><div><strong>{project.name}</strong><span>{project.repository} · {project.ref}</span></div><div className="project-row-end">{latest ? <RunBadge run={latest} /> : <Badge>Untested</Badge>}<span aria-hidden="true">↗</span></div></Link>; })}</div> : <EmptyState title="Connect your first project" action={<Link href="/projects/new" className="button secondary">Connect the reference app <span aria-hidden="true">→</span></Link>}>Choose your owned repository and staging target. You will review the test policy and permitted changes before any run begins.</EmptyState>}</section>
              <section className="panel"><div className="panel-heading"><div><h2>Recent runs</h2><p>Saved results, including incomplete and blocked work.</p></div></div>{data.runs.length ? <div className="table-scroll"><table><thead><tr><th>Run</th><th>Project</th><th>Execution mode</th><th>Result</th><th>Started</th></tr></thead><tbody>{data.runs.slice(0, 10).map(run => <tr key={run.id}><td><Link className="table-link" href={`/runs/${encodeURIComponent(run.id)}`}>{shortId(run.id)}</Link></td><td>{data.projects.find(project => project.id === run.projectId)?.name ?? run.projectId}</td><td><ModeBadge mode={run.mode} /></td><td><RunBadge run={run} /></td><td>{formatDate(run.createdAt)}</td></tr>)}</tbody></table></div> : <EmptyState title="No runs yet">Once a project is connected, choose a policy and review your first test plan. Untested is not a passing result.</EmptyState>}</section>
              <div className="coverage-note"><span aria-hidden="true">ⓘ</span><div><strong>Clear limits are part of the result.</strong><p>{data.config.stripeConfigured ? 'Stripe credentials are configured. A run must still pass preflight before it can use the sandbox.' : 'Stripe credentials are not configured. Local replay remains explicitly separate from Stripe sandbox verification.'}</p>{data.config.coverageLimits.map((limit, index) => <p key={index}>{limit}</p>)}</div></div>
            </>}
            {view.kind === 'new_project' && <ProjectSetup config={data.config} api={session} onCreated={async project => { await refresh(); router.push(`/projects/${encodeURIComponent(project.id)}`); }} />}
            {view.kind === 'project' && (currentProject ? <ProjectView key={currentProject.id} config={data.config} project={currentProject} api={session} runs={data.runs.filter(run => run.projectId === currentProject.id)} onRun={async run => { await refresh(); router.push(`/runs/${encodeURIComponent(run.id)}`); }} /> : <EmptyState title="Project not found">This project is not in the current workspace. Refresh the saved data or return to the overview.</EmptyState>)}
            {view.kind === 'run' && <RunView key={view.id} id={view.id} api={session} config={data.config} projects={data.projects} onChanged={() => void refresh().catch(error => setError(errorMessage(error)))} />}
          </>}
        </>}
        <footer className="page-footer"><span>PaywallProof <span className="footer-separator">/</span> Evidence before confidence.</span><span>Sandbox only · Owner approved · No automatic deployment</span></footer>
      </main>
    </div>
  </div>;
}

function Metric({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <section className="metric"><span>{title}</span><strong>{value}</strong><p>{detail}</p></section>;
}
