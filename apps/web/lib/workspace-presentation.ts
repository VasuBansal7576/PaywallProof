import type { Project, Run } from './contracts';

export const runFilters = ['all', 'attention', 'active', 'passed', 'failed', 'inconclusive'] as const;
export type RunFilter = typeof runFilters[number];
export const runTabs = ['scenarios', 'findings', 'evidence', 'report', 'activity', 'repairs'] as const;
export type RunTab = typeof runTabs[number];

export function parseRunTab(hash: string): RunTab {
  return runTabs.find(tab => `#${tab}` === hash) ?? 'scenarios';
}

export function adjacentTab(current: RunTab, key: string): RunTab | null {
  const index = runTabs.indexOf(current);
  if (key === 'Home') return runTabs[0];
  if (key === 'End') return runTabs.at(-1) ?? 'scenarios';
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  return runTabs[(index + (key === 'ArrowRight' ? 1 : -1) + runTabs.length) % runTabs.length] ?? 'scenarios';
}

export function needsAttention(run: Run) {
  return run.status === 'awaiting_plan_approval' || run.outcome === 'failed' || run.outcome === 'inconclusive';
}

export function newestRuns(runs: readonly Run[]): Run[] {
  return [...runs].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function visibleRuns(runs: readonly Run[], projects: readonly Project[], query: string, filter: RunFilter): Run[] {
  const names = new Map(projects.map(project => [project.id, project.name]));
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return newestRuns(runs).filter(run => {
    const matchesFilter = filter === 'all' || (filter === 'attention' ? needsAttention(run) : filter === 'active' ? ['running', 'stopping'].includes(run.status) : run.outcome === filter);
    const text = [run.id, run.projectId, names.get(run.projectId) ?? '', run.targetBuild, run.mode, run.status, run.outcome ?? ''].join(' ').toLowerCase();
    return matchesFilter && words.every(word => text.includes(word));
  });
}
