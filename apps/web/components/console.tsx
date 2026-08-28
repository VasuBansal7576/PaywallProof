'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, ChevronRight, FolderGit2, LayoutDashboard, LockKeyhole, Menu, Plus, ShieldCheck, SquareTerminal, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { ApiSession, errorMessage, get, login } from '../lib/api';
import { configSchema, projectSchema, runSchema, type Config, type Project, type Run } from '../lib/contracts';
import { newestRuns } from '../lib/workspace-presentation';
import { EmptyState, ErrorNotice, shortId } from './shared';
import { Overview } from './overview';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const loading = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let active = true;
    get('/session', z.object({ csrfToken: z.string() })).then(result => {
      if (active) setSession(new ApiSession(result.csrfToken));
    }).catch(error => {
      const parsed = errorMessage(error);
      if (active && !['AUTH_REQUIRED', 'UNAUTHORIZED', 'HTTP_401', 'AUTHENTICATION_REQUIRED'].includes(parsed.code)) setError(parsed);
    }).finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, []);

  const refresh = useCallback(() => {
    if (loading.current) return loading.current;
    loading.current = Promise.all([
      get('/config', configSchema), get('/projects', z.array(projectSchema)), get('/runs', z.array(runSchema)),
    ]).then(([config, projects, runs]) => {
      setData({ config, projects, runs: newestRuns(runs) });
      setError(null);
    }).finally(() => { loading.current = null; });
    return loading.current;
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
  const pageTitle = view.kind === 'overview' ? 'Overview' : view.kind === 'new_project' ? 'Connect project' : view.kind === 'project' ? currentProject?.name ?? 'Project' : 'Run details';
  return <div className={`console-shell${menuOpen ? ' menu-open' : ''}`} onKeyDown={event => {
    if (event.key === 'Escape' && menuOpen) { setMenuOpen(false); menuButton.current?.focus(); }
  }}>
    <a href="#main-content" className="skip-link">Skip to content</a>
    <aside className="sidebar" id="workspace-navigation">
      <Link href="/" className="brand"><span className="brand-icon"><ShieldCheck size={23} aria-hidden="true" /></span>PaywallProof<span className="beta">LOCAL</span></Link>
      <div className="workspace-switcher"><span className="workspace-avatar"><SquareTerminal size={18} aria-hidden="true" /></span><div><strong>Local workspace</strong><span>Private operator console</span></div></div>
      <div className="sidebar-scroll" onClick={event => { if (event.target instanceof Element && event.target.closest('a')) setMenuOpen(false); }}>
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <Link className={`nav-item${view.kind === 'overview' ? ' active' : ''}`} aria-current={view.kind === 'overview' ? 'page' : undefined} href="/"><LayoutDashboard size={17} aria-hidden="true" />Overview</Link>
          <Link className={`nav-item${view.kind === 'new_project' ? ' active' : ''}`} aria-current={view.kind === 'new_project' ? 'page' : undefined} href="/projects/new"><Plus size={17} aria-hidden="true" />Connect project</Link>
        </nav>
        <div className="nav-heading"><span className="nav-caption">PROJECTS</span><Link href="/projects/new" className="icon-button" aria-label="Connect a project"><Plus size={15} aria-hidden="true" /></Link></div>
        {data?.projects.length ? <nav aria-label="Projects">{data.projects.map(project => <Link key={project.id} href={`/projects/${encodeURIComponent(project.id)}`} title={project.name} aria-current={view.kind === 'project' && view.id === project.id ? 'page' : undefined} className={`nav-item${view.kind === 'project' && view.id === project.id ? ' active' : ''}`}><FolderGit2 size={16} aria-hidden="true" /><span className="nav-truncate">{project.name}</span></Link>)}</nav> : <p className="sidebar-empty">No projects connected</p>}
        <div className="nav-caption run-caption">RECENT RUNS</div>
        {data?.runs.length ? <nav aria-label="Recent runs">{data.runs.slice(0, 5).map(run => <Link key={run.id} href={`/runs/${encodeURIComponent(run.id)}`} aria-current={view.kind === 'run' && view.id === run.id ? 'page' : undefined} className={`nav-item small${view.kind === 'run' && view.id === run.id ? ' active' : ''}`}><span className={`run-dot ${run.outcome ?? run.status}`} /><code>{shortId(run.id)}</code><span className="sr-only">{run.outcome ?? run.status}</span></Link>)}</nav> : <p className="sidebar-empty">No recorded runs yet</p>}
      </div>
      <div className="sidebar-bottom"><div className="safety-mini"><ShieldCheck size={17} aria-hidden="true" /><div><strong>Bounded by design</strong><p>Sandbox only. Owner approved.<br />No automatic deployment.</p></div></div><div className="operator"><span className="operator-avatar">O</span><div><strong>Local operator</strong><span>{session ? 'Authenticated session' : 'Session required'}</span></div><span className={`connection-dot${session ? ' connected' : ''}`} /></div></div>
    </aside>
    <div className="console-body">
      <header className="topbar"><button ref={menuButton} type="button" className="icon-button mobile-menu" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={21} aria-hidden="true" /> : <Menu size={21} aria-hidden="true" />}</button><nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Workspace</Link><ChevronRight size={13} aria-hidden="true" /><span aria-current="page">{pageTitle}</span></nav><div className="topbar-status"><span className="local-indicator" />Local environment<span className="topbar-divider" /><LockKeyhole size={14} aria-hidden="true" /><span className="private-label">Private</span></div></header>
      <main id="main-content" className="page-content" tabIndex={-1}>
        {checkingSession ? <div className="loading-state" role="status"><span className="loading-dot" />Restoring your session…</div> : !session ? <section className="login-layout"><div className="login-intro"><p className="eyebrow">Subscription access, verified</p><h1>Who gets through<br />your paywall?</h1><p className="page-description">Test the promise your billing makes. Trace each result to an ordinary customer session, recorded state and a real browser action.</p><ol className="login-principles"><li><span>01</span><strong>Define the access rule</strong></li><li><span>02</span><strong>Approve the test boundary</strong></li><li><span>03</span><strong>Inspect the evidence</strong></li></ol></div><form className="panel login-card" onSubmit={event => void submitLogin(event)}><div className="section-icon"><LockKeyhole size={22} aria-hidden="true" /></div><h2>Open your workspace</h2><p>Use the operator token created by your local launcher.</p><label htmlFor="operator-token">Operator token</label><input id="operator-token" type="password" required value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste your local operator token" /><p className="field-hint">Find it in <code>.local/operator-token</code> after running <code>pnpm dev</code>.</p><ErrorNotice error={error} /><button className="button primary wide" disabled={loggingIn}>{loggingIn ? 'Opening workspace…' : 'Open workspace'}<ArrowRight size={17} aria-hidden="true" /></button><p className="login-footnote">No hosted account. No production billing access.</p></form></section> : <>
          <ErrorNotice error={error} />
          {!data ? <div className="loading-state" role="status">Loading saved projects and runs…<button className="text-button" onClick={() => void refresh().catch(error => setError(errorMessage(error)))}>Retry</button></div> : <>
            {view.kind === 'overview' && <Overview {...data} />}
            {view.kind === 'new_project' && <ProjectSetup config={data.config} api={session} onCreated={async project => { await refresh(); router.push(`/projects/${encodeURIComponent(project.id)}`); }} />}
            {view.kind === 'project' && (currentProject ? <ProjectView key={currentProject.id} config={data.config} project={currentProject} api={session} runs={data.runs.filter(run => run.projectId === currentProject.id)} onRun={async run => { await refresh(); router.push(`/runs/${encodeURIComponent(run.id)}`); }} /> : <EmptyState title="Project not found" action={<Link href="/" className="button secondary">Back to overview</Link>}>This project is not in the current workspace.</EmptyState>)}
            {view.kind === 'run' && <RunView key={view.id} id={view.id} api={session} config={data.config} projects={data.projects} onChanged={() => void refresh().catch(error => setError(errorMessage(error)))} />}
          </>}
        </>}
        <footer className="page-footer"><span><ShieldCheck size={14} aria-hidden="true" />PaywallProof</span><span>Evidence before confidence.</span></footer>
      </main>
    </div>
  </div>;
}
