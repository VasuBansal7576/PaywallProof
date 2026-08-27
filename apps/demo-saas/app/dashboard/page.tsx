'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

const accountSchema = z.object({
  principalId: z.string(), plan: z.enum(['Free', 'Pro']), canExport: z.boolean(),
  subscriptionStatus: z.string(), cancelAtPeriodEnd: z.boolean(), periodEnd: z.number().nullable(),
  executionMode: z.enum(['none', 'local_replay', 'stripe_sandbox']),
});
type Account = z.infer<typeof accountSchema>;
type AccountState = { kind: 'loading' } | { kind: 'ready'; account: Account } | { kind: 'signed_out' } | { kind: 'unavailable' };
type ExportState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'allowed'; marker: string } | { kind: 'denied' } | { kind: 'unavailable' };

export default function Dashboard() {
  const [state, setState] = useState<AccountState>({ kind: 'loading' });
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' });
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (response.status === 401) { setState({ kind: 'signed_out' }); return; }
        if (!response.ok) { setState({ kind: 'unavailable' }); return; }
        const body: unknown = await response.json();
        setState({ kind: 'ready', account: accountSchema.parse(body) });
      } catch { if (!controller.signal.aborted) setState({ kind: 'unavailable' }); }
    }
    void load();
    return () => controller.abort();
  }, []);

  async function exportData() {
    setExportState({ kind: 'loading' });
    try {
      // The browser never receives an adapter token. Every export uses its ordinary session.
      const response = await fetch('/api/export', { cache: 'no-store', credentials: 'same-origin' });
      const body: unknown = await response.json();
      if (response.status === 403 && z.object({ error: z.literal('ACCESS_DENIED') }).safeParse(body).success) {
        setExportState({ kind: 'denied' });
        return;
      }
      const parsed = z.object({ fixtureMarker: z.string().min(1) }).safeParse(body);
      if (!response.ok || !parsed.success) { setExportState({ kind: 'unavailable' }); return; }
      setExportState({ kind: 'allowed', marker: parsed.data.fixtureMarker });
    } catch { setExportState({ kind: 'unavailable' }); }
  }

  const account = state.kind === 'ready' ? state.account : undefined;
  return <div className="workspace">
    <aside className="sidebar"><Link href="/" className="brand"><span className="brand-mark">L</span>Ledger &amp; co.</Link><div className="workspace-label">YOUR WORKSPACE</div><nav aria-label="Workspace"><Link href="/dashboard" aria-current="page"><span aria-hidden="true">▦</span> Overview</Link></nav><div className="sidebar-note"><span className="status-dot" />Reference target<p>Real session.<br />Server enforced access.</p></div></aside>
    <main className="main-content"><header className="topbar"><span>Workspace <span className="breadcrumb">/ Overview</span></span><span className="environment">Test environment</span></header>
      <section className="page-heading"><p className="eyebrow">A place for your work</p><h1>Workspace overview</h1><p>Keep your records close. Take them with you when you need to.</p></section>
      {state.kind === 'loading' && <div className="notice" role="status">Loading your session…</div>}
      {state.kind === 'signed_out' && <div className="notice" role="status"><h2>A workspace session is required</h2><p>Open this page through a PaywallProof run. Its trusted runner creates an ordinary, short lived user session. This public page cannot create test users or grant Pro access.</p></div>}
      {state.kind === 'unavailable' && <div className="notice" role="alert"><h2>The workspace is unavailable</h2><p>Account state could not be loaded. No access result has been recorded.</p></div>}
      {account && <>
        {account.executionMode === 'local_replay' && <div className="replay-notice" role="note">Local replay · Billing events are synthetic test fixtures. This is not a Stripe sandbox verification.</div>}
        <div className="content-grid"><section className="export-card"><div className="card-topline"><span className="export-icon" aria-hidden="true">↗</span><span className="pro-label">PRO FEATURE</span></div><h2>Your data, ready to go.</h2><p>Export the private fixture attached to your workspace. The server checks your subscription on every request.</p><div className="export-details"><span>Workspace export</span><span>JSON</span></div><button className="button" data-testid="export-button" onClick={() => void exportData()} disabled={exportState.kind === 'loading'}>{exportState.kind === 'loading' ? 'Requesting export…' : 'Export workspace data'}<span aria-hidden="true">↓</span></button>{!account.canExport && <p className="upgrade-note">Upgrade to Pro to export. No checkout or payment is offered in this reference app.</p>}<div data-testid="export-result" data-status={exportState.kind} className={`export-result ${exportState.kind}`} role="status" aria-live="polite">{exportState.kind === 'allowed' && <><strong>Export ready</strong><pre>{exportState.marker}</pre></>}{exportState.kind === 'denied' && <><strong>Pro access required</strong><p>Access denied. Your workspace data was not exported.</p></>}{exportState.kind === 'unavailable' && <><strong>Export unavailable</strong><p>We could not confirm an access result. Try again when the target is reachable.</p></>}</div></section>
          <section className="plan-card"><p className="eyebrow">Current plan</p><h2>{account.plan}<span className="plan-dot" /></h2><p>{account.canExport ? 'Your paid workspace includes the Pro export.' : 'Your workspace is available. Pro export is restricted.'}</p><dl><div><dt>Billing status</dt><dd>{account.subscriptionStatus === 'none' ? 'No subscription' : account.subscriptionStatus}</dd></div><div><dt>Export access</dt><dd>{account.canExport ? 'Available' : 'Restricted'}</dd></div><div><dt>Cancellation</dt><dd>{account.cancelAtPeriodEnd ? 'At period end' : 'Not scheduled'}</dd></div></dl>{account.cancelAtPeriodEnd && account.canExport && <p className="period-note">Access continues while the provider confirms this subscription is active.</p>}<div className="plan-footer">Plan labels describe stored state. The export response is the access check.</div></section></div>
        <section className="identity-card"><div><p className="eyebrow">Ordinary user session</p><code>{account.principalId}</code></div><span className="session-pill">Session active</span></section>
      </>}
      <footer className="page-footer">Ledger &amp; co. <span>PaywallProof reference application · Test data only</span></footer>
    </main>
  </div>;
}
