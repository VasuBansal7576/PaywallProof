import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Overview } from '../components/overview';
import { ProjectView } from '../components/project';
import { ApiSession } from './api';
import { configSchema, projectSchema, runSchema, type Run } from './contracts';
import { adjacentTab, needsAttention, newestRuns, parseRunTab, runTabs, visibleRuns } from './workspace-presentation';

// Synthetic presentation fixtures. They are never stored as product evidence.
const project = projectSchema.parse({ id: 'project-test', name: 'Access Example', repository: 'example/repository', ref: 'main', targetId: 'reference', ownershipConfirmed: true, modelConsent: true });
const config = configSchema.parse({ target: { id: 'reference', origin: 'http://127.0.0.1:3001' }, repository: project.repository, defaultRef: 'main', polarConfigured: false, priceId: 'price-test', model: 'test-model', limits: {}, coverageLimits: ['Test fixture coverage only.'] });
function fixture(id: string, createdAt = 1000, overrides: Partial<Run> = {}): Run {
  return runSchema.parse({ id, createdAt, projectId: project.id, targetBuild: 'a'.repeat(40), featureConfigHash: 'b'.repeat(64), mode: 'local_replay', status: 'completed', outcome: 'inconclusive', startedAt: 900, verdicts: [], policy: { schemaVersion: 2, priceId: config.priceId, featureId: 'pro_export', featureConfigHash: 'b'.repeat(64), cancellation: 'allow_until_period_end', requireInitialPaymentConfirmed: true, syncWindowSeconds: 60, predicateVersion: 'reference-export-v1', hash: 'c'.repeat(64) }, approval: { id: 'test-approval', bindingHash: 'd'.repeat(64), expiresAt: 0, decision: 'allow' }, ...overrides });
}

describe('workspace presentation', () => {
  it('sorts by recorded creation time without mutating API data and breaks ties deterministically', () => {
    const input = [fixture('old', 1), fixture('z', 2), fixture('a', 2)];
    expect(newestRuns(input).map(run => run.id)).toEqual(['a', 'z', 'old']);
    expect(input.map(run => run.id)).toEqual(['old', 'z', 'a']);
  });
  it('searches full identifiers, builds and project names with all case-insensitive terms', () => {
    const run = fixture('prefix-middle-hidden-suffix');
    expect(visibleRuns([run], [project], ' ACCESS middle-hidden ', 'all')).toEqual([run]);
    expect(visibleRuns([run], [project], run.targetBuild, 'all')).toEqual([run]);
    expect(visibleRuns([run], [project], 'access nonexistent', 'all')).toEqual([]);
    expect(visibleRuns([run], [], project.id, 'all')).toEqual([run]);
  });
  it('does not truncate search results to ten recent runs', () => {
    const runs = Array.from({ length: 1200 }, (_, index) => fixture(`run-${index}`, index));
    expect(visibleRuns(runs, [project], '', 'all')).toHaveLength(1200);
    expect(visibleRuns(runs, [project], 'run-0', 'all').map(run => run.id)).toEqual(['run-0']);
  });
  it('never counts null, incomplete or canceled outcomes as passed', () => {
    const runs = [fixture('pass', 1, { outcome: 'passed' }), fixture('fail', 2, { outcome: 'failed' }), fixture('unknown', 3), fixture('pending', 4, { status: 'awaiting_plan_approval', outcome: null }), fixture('running', 5, { status: 'running', outcome: null }), fixture('stopping', 6, { status: 'stopping', outcome: null }), fixture('canceled', 7, { status: 'canceled', outcome: null })];
    expect(visibleRuns(runs, [project], '', 'passed').map(run => run.id)).toEqual(['pass']);
    expect(visibleRuns(runs, [project], '', 'active').map(run => run.id)).toEqual(['stopping', 'running']);
    expect(visibleRuns(runs, [project], '', 'attention').map(run => run.id)).toEqual(['pending', 'unknown', 'fail']);
    expect(visibleRuns(runs, [project], '', 'failed').map(run => run.id)).toEqual(['fail']);
    expect(visibleRuns(runs, [project], '', 'inconclusive').map(run => run.id)).toEqual(['unknown']);
    expect(needsAttention(fixture('expired', 1, { status: 'awaiting_plan_approval', outcome: null }))).toBe(true);
  });
  it('renders real empty-state counts without invented activity or exports', () => {
    const html = renderToStaticMarkup(createElement(Overview, { config, projects: [], runs: [] }));
    expect(html).toContain('No runs recorded');
    expect(html).toContain('No connected projects');
    expect(html).not.toContain('/report?format=json');
    expect(html).toContain('No test has run yet.');
  });
  it('explains a changed configuration without rebinding saved projects or approvals', () => {
    const html = renderToStaticMarkup(createElement(ProjectView, { config: { ...config, defaultRef: 'new-commit' }, project, api: new ApiSession('presentation-only'), runs: [], onRun: async () => {} }));
    expect(html).toContain('This project uses an earlier configuration');
    expect(html).toContain('Existing approvals cannot authorize a different build.');
    expect(html).toContain('new-commit');
    expect(html).toContain('Connect current configuration');
    expect(html).toContain('href="/projects/new"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Review run approval/);
    expect(project.ref).toBe('main');
  });
  it('escapes untrusted names and preserves exact run bindings in links and machine-readable data', () => {
    const run = fixture('run/<untrusted>');
    const html = renderToStaticMarkup(createElement(Overview, { config, projects: [{ ...project, name: '<script>malicious()</script>' }], runs: [run] }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;malicious()&lt;/script&gt;');
    expect(html).toContain('href="/runs/run%2F%3Cuntrusted%3E"');
    expect(html).toContain('data-run-id="run/&lt;untrusted&gt;"');
    expect(html).toContain('Local replay does not verify provider delivery.');
  });
});

describe('deep links and keyboard tab navigation', () => {
  it.each(runTabs)('restores the %s deep link', tab => expect(parseRunTab(`#${tab}`)).toBe(tab));
  it.each(['', '#unknown', '#REPORT', '#report?approve=true', '#__proto__'])('defaults safely for %s without interpreting commands', hash => expect(parseRunTab(hash)).toBe('scenarios'));
  it.each(runTabs)('supports keyboard navigation from %s', tab => {
    const index = runTabs.indexOf(tab);
    expect(adjacentTab(tab, 'ArrowRight')).toBe(runTabs[(index + 1) % runTabs.length]);
    expect(adjacentTab(tab, 'ArrowLeft')).toBe(runTabs[(index + runTabs.length - 1) % runTabs.length]);
    expect(adjacentTab(tab, 'Home')).toBe('scenarios');
    expect(adjacentTab(tab, 'End')).toBe('repairs');
    expect(adjacentTab(tab, 'Enter')).toBe(null);
    expect(adjacentTab(tab, 'Tab')).toBe(null);
  });
});
