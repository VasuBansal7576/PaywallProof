import type { ReactNode } from 'react';
import type { Mode, Run, Scenario } from '../lib/contracts';

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}><span className="badge-dot" />{children}</span>;
}
export function ModeBadge({ mode }: { mode: Mode }) {
  return <Badge tone={mode === 'local_replay' ? 'amber' : 'blue'}>{mode === 'local_replay' ? 'Local replay' : 'Stripe sandbox'}</Badge>;
}
export function RunBadge({ run }: { run: Run }) {
  const label = run.status === 'stopping' ? 'Stopping' : run.outcome ?? ({ awaiting_plan_approval: 'Needs approval', running: 'Running', stopping: 'Stopping', canceled: 'Canceled', completed: 'Untested' })[run.status];
  return <Badge tone={run.status === 'stopping' ? 'amber' : run.outcome === 'passed' ? 'green' : run.outcome === 'failed' ? 'red' : run.status === 'running' ? 'blue' : 'neutral'}>{label}</Badge>;
}
export function AssertionBadge({ assertion }: { assertion?: Scenario['api'] }) {
  if (!assertion) return <Badge>Untested</Badge>;
  return <span title={assertion.code}><Badge tone={assertion.verdict === 'pass' ? 'green' : assertion.verdict === 'fail' ? 'red' : assertion.verdict === 'inconclusive' ? 'amber' : 'neutral'}>{assertion.verdict}</Badge></span>;
}
export function ErrorNotice({ error }: { error: { code: string; message: string } | null }) {
  return error ? <div className="error-notice" role="alert"><strong>{error.code.replaceAll('_', ' ')}</strong><p>{error.message}</p></div> : null;
}
export function ReplayNotice() {
  return <div className="replay-warning"><span aria-hidden="true">◈</span><div><strong>Local replay uses synthetic billing events.</strong><span> It exercises the real target and ordinary user session. It does not verify Stripe delivery or a live sandbox integration.</span></div></div>;
}
export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon" aria-hidden="true">▤</div><h3>{title}</h3><p>{children}</p>{action}</div>;
}
export function JsonDetails({ title, value, open = false }: { title: string; value: unknown; open?: boolean }) {
  return <details className="json-details" open={open}><summary>{title}</summary><pre>{JSON.stringify(value, null, 2) ?? 'No data recorded'}</pre></details>;
}
export function formatDate(value: number) { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
export function shortId(value: string) { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
