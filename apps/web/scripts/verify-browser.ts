import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect, type Page } from '@playwright/test';
import { z } from 'zod';
import { configSchema, detailSchema, projectSchema, runSchema } from '../lib/contracts';

// Live checks read the existing local workspace. Isolated fixture routes below are
// presentation tests only: no fixture is sent to the worker or saved as evidence.
const origin = 'http://127.0.0.1:3000';
const output = 'apps/web/.local';
const token = (await readFile('.local/operator-token', 'utf8')).trim();
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const checks: string[] = [];
const record = (name: string) => { checks.push(name); process.stdout.write(`PASS ${name}\n`); };
async function noOverflow(page: Page) {
  const layout = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth, overflow: Array.from(document.querySelectorAll('body *')).filter(element => element.getBoundingClientRect().right > window.innerWidth + 1).map(element => ({ tag: element.tagName, class: element.getAttribute('class'), width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right, position: getComputedStyle(element).position })).slice(0, 12) }));
  if (layout.scroll > layout.width + 1) await page.screenshot({ path: `${output}/overflow-debug.png`, fullPage: true });
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width + 1);
}
try {
  await mkdir(output, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel('Operator token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Trust the evidence.', exact: true })).toBeVisible();
  const [projects, runs, config] = await Promise.all([
    context.request.get(`${origin}/api/projects`).then(async response => { expect(response.ok()).toBe(true); return z.array(projectSchema).parse(await response.json()); }),
    context.request.get(`${origin}/api/runs`).then(async response => { expect(response.ok()).toBe(true); return z.array(runSchema).parse(await response.json()); }),
    context.request.get(`${origin}/api/config`).then(async response => { expect(response.ok()).toBe(true); return configSchema.parse(await response.json()); }),
  ]);
  expect(await page.locator('[data-run-id]').count()).toBe(runs.length);
  await noOverflow(page);
  await page.screenshot({ path: `${output}/overview.png`, fullPage: true });
  record('real sign-in, saved-data counts, desktop layout');

  const run = [...runs].sort((a, b) => b.createdAt - a.createdAt)[0];
  assert(run, 'A real recorded run is required for live UI verification');
  await page.getByRole('searchbox', { name: 'Search runs' }).fill(run.id.slice(9, 23));
  await expect(page.locator('[data-run-id]')).toHaveCount(1);
  await expect(page.locator('[data-run-id]')).toHaveAttribute('data-run-id', run.id);
  await page.getByRole('searchbox', { name: 'Search runs' }).fill('no-such-run-in-this-workspace');
  await expect(page.getByRole('heading', { name: 'No matching runs' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('[data-run-id]')).toHaveCount(runs.length);
  await page.getByRole('button', { name: 'Passed', exact: true }).click();
  await expect(page.locator('[data-run-id]')).toHaveCount(runs.filter(value => value.outcome === 'passed').length);
  await page.getByRole('button', { name: 'All runs', exact: true }).click();
  await page.getByRole('button', { name: 'Copy latest run ID', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(run.id);
  record('search hidden identifier segments, result filtering, reset, exact clipboard binding');

  await page.goto(`${origin}/runs/${encodeURIComponent(run.id)}#evidence`);
  await expect(page.getByRole('tab', { name: /^Evidence/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toBeVisible();
  await page.getByRole('tab', { name: /^Evidence/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Report', exact: true })).toBeFocused();
  await expect(page).toHaveURL(/#report$/);
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Repairs', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Scenarios', exact: true })).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Repairs', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Repairs', exact: true })).toHaveAttribute('aria-selected', 'true');
  record('deep-link restoration, roving tab focus, keyboard wraparound, history and reload');

  const detail = detailSchema.parse(await (await context.request.get(`${origin}/api/runs/${encodeURIComponent(run.id)}`)).json());
  await page.getByRole('tab', { name: 'Scenarios', exact: true }).click();
  await expect(page.locator('.scenario-table tbody tr')).toHaveCount(4);
  for (const scenario of detail.scenarios) {
    const row = page.locator('.scenario-table tbody tr').filter({ hasText: scenario.id });
    for (const [index, channel] of ['api', 'browser', 'state'].entries()) {
      const assertion = channel === 'api' ? scenario.api : channel === 'browser' ? scenario.browser : scenario.state;
      await expect(row.locator('td').nth(index + 1)).toHaveText(assertion.verdict);
    }
  }
  if (run.mode === 'local_replay') await expect(page.locator('.replay-warning')).toContainText('does not verify Polar');
  await page.screenshot({ path: `${output}/run-scenarios.png`, fullPage: true });
  await page.getByRole('tab', { name: 'Report', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: /JSON/ }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  assert(downloadPath);
  const exported = await readFile(downloadPath, 'utf8');
  expect(exported).toContain(run.id);
  expect(exported).toContain(run.policy.hash);
  expect(exported).toContain(run.mode);
  await page.getByRole('tab', { name: /^Evidence/ }).click();
  await page.screenshot({ path: `${output}/run-evidence.png`, fullPage: true });
  record('UI assertions match real receipts; downloaded report preserves run, mode and policy');

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow(page);
    await page.goto(origin);
    await expect(page.getByRole('heading', { name: 'Trust the evidence.' })).toBeVisible();
    await noOverflow(page);
    if (width < 760) {
      await expect(page.getByRole('navigation', { name: 'Projects', exact: true })).not.toBeVisible();
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.getByRole('navigation', { name: 'Projects', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
      await expect(page.getByRole('navigation', { name: 'Projects', exact: true })).not.toBeVisible();
    }
    if (width === 390) await page.screenshot({ path: `${output}/mobile-overview.png`, fullPage: true });
  }
  record('320px, 390px and 768px layouts; mobile navigation, Escape and focus return');

  const project = projects.find(project => project.id === run.projectId);
  assert(project);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/projects/${project.id}`);
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check prerequisites', exact: true })).toBeDisabled();
  await page.getByRole('radio').first().check();
  const preflightResponse = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/preflight`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Check prerequisites', exact: true }).click();
  const preflightReply = await preflightResponse;
  if (project.ref !== config.defaultRef || project.repository !== config.repository) {
    expect(preflightReply.status()).toBe(422);
    expect(await preflightReply.json()).toMatchObject({ error: { code: 'PROJECT_CONFIG_CHANGED' } });
    await expect(page.getByRole('status', { name: 'Project configuration changed' })).toContainText(config.defaultRef);
    await expect(page.getByRole('link', { name: 'Connect current configuration' })).toHaveAttribute('href', '/projects/new');
    await expect(page.getByRole('button', { name: 'Review run approval', exact: true })).toBeDisabled();
    await expect(page.locator('.check-row')).toHaveCount(0);
  } else {
    expect(preflightReply.ok()).toBe(true);
    await expect(page.locator('.check-row')).toHaveCount(3, { timeout: 30_000 });
  }
  await page.screenshot({ path: `${output}/project-policy.png`, fullPage: true });
  await page.reload();
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check prerequisites', exact: true })).toBeDisabled();
  await page.goto(`${origin}/projects/new`);
  await expect(page.getByRole('button', { name: 'Connect project', exact: true })).toBeDisabled();
  await page.getByLabel('Project name', { exact: true }).fill('UI verification, not submitted');
  await page.getByRole('checkbox', { name: /I own or am authorized/ }).check();
  await expect(page.getByRole('button', { name: 'Connect project', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: /I approve processing/ }).check();
  await expect(page.getByRole('button', { name: 'Connect project', exact: true })).toBeEnabled();
  await page.screenshot({ path: `${output}/connect-project.png`, fullPage: true });
  record(`real read-only local preflight ${project.ref !== config.defaultRef || project.repository !== config.repository ? 'rejects changed configuration' : 'returns capability checks'}, explicit mode reset, ownership and model-consent gates`);

  // This separate context cannot send API requests to the live worker.
  const fixtureContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const fixturePage = await fixtureContext.newPage();
  fixturePage.on('pageerror', error => errors.push(error.message));
  let responseMode: 'empty' | 'stress' | 'unavailable' | 'run-disconnected' | 'run-recovered' = 'empty';
  let fixtureMutations = 0;
  const fixtureRuns = Array.from({ length: 300 }, (_, index) => ({ ...run, id: `presentation-only-${index}`, createdAt: index, outcome: index % 2 === 0 ? 'passed' : 'inconclusive' }));
  const hostileProject = { ...project, name: `<script>throw Error('unsafe')</script>${'long project name '.repeat(12)}` };
  await fixtureContext.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') { fixtureMutations++; await route.fulfill({ status: 409, json: { error: { code: 'PRESENTATION_ONLY', message: 'No writes are permitted by this test.' } } }); return; }
    if (path === '/api/session') { await route.fulfill({ json: { csrfToken: 'presentation-only-no-auth' } }); return; }
    if (path.startsWith(`/api/runs/${run.id}/events`)) { await route.fulfill({ json: { events: [], cursor: 0 } }); return; }
    if (path === `/api/runs/${run.id}`) { await route.fulfill(responseMode === 'run-disconnected' ? { status: 503, json: { error: { code: 'READ_DISCONNECTED', message: 'Presentation test of a disconnected run read.' } } } : { json: detail }); return; }
    if (responseMode === 'unavailable') { await route.fulfill({ status: 503, json: { error: { code: 'WORKER_UNAVAILABLE', message: 'Presentation test of worker read failure.' } } }); return; }
    const value = path === '/api/config' ? config : path === '/api/projects' ? responseMode === 'stress' ? [hostileProject] : [] : path === '/api/runs' ? responseMode === 'stress' ? fixtureRuns : [] : null;
    await route.fulfill({ status: value === null ? 404 : 200, json: value ?? { error: { code: 'NOT_FOUND', message: 'Presentation fixture not found.' } } });
  });
  await fixturePage.goto(origin);
  await expect(fixturePage.getByRole('heading', { name: 'No runs recorded', exact: true })).toBeVisible();
  await expect(fixturePage.getByRole('heading', { name: 'No connected projects', exact: true })).toBeVisible();
  await noOverflow(fixturePage);
  responseMode = 'stress'; await fixturePage.reload();
  await expect(fixturePage.locator('[data-run-id]')).toHaveCount(300);
  await expect(fixturePage.getByRole('heading', { name: hostileProject.name, exact: true }).first()).toBeVisible();
  await noOverflow(fixturePage);
  await fixturePage.getByRole('searchbox', { name: 'Search runs' }).fill('presentation-only-0');
  await expect(fixturePage.locator('[data-run-id]')).toHaveCount(1);
  await fixturePage.getByRole('button', { name: 'Inconclusive', exact: true }).click();
  await expect(fixturePage.getByRole('heading', { name: 'No matching runs' })).toBeVisible();
  responseMode = 'unavailable'; await fixturePage.reload();
  await expect(fixturePage.getByRole('alert').filter({ hasText: 'Presentation test of worker read failure.' })).toBeVisible();
  responseMode = 'empty'; await fixturePage.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(fixturePage.getByRole('heading', { name: 'No runs recorded', exact: true })).toBeVisible();
  await expect(fixturePage.getByRole('alert').filter({ hasText: 'Presentation test of worker read failure.' })).toHaveCount(0);
  record('isolated presentation fixtures: empty state, 300 runs, hostile long names, combined filters, read failure and retry');
  responseMode = 'run-disconnected';
  await fixturePage.goto(`${origin}/runs/${run.id}`);
  await expect(fixturePage.getByRole('heading', { name: 'Run data is unavailable' })).toBeVisible();
  responseMode = 'run-recovered';
  await fixturePage.getByRole('button', { name: 'Retry connection' }).click();
  await expect(fixturePage.locator('.run-summary')).toBeVisible();
  await expect(fixturePage.locator('.error-notice')).toHaveCount(0);
  responseMode = 'run-disconnected';
  await expect(fixturePage.locator('.error-notice')).toContainText('READ DISCONNECTED', { timeout: 7000 });
  await expect(fixturePage.locator('.run-summary')).toContainText('Read disconnected');
  responseMode = 'run-recovered';
  await expect(fixturePage.locator('.error-notice')).toHaveCount(0, { timeout: 7000 });
  await expect(fixturePage.locator('.run-summary')).toContainText('Connected');
  expect(fixtureMutations).toBe(0);
  record('run-read recovery clears stale errors, retains saved results and creates no mutations');
  expect(errors).toEqual([]);
  await writeFile(`${output}/verification.json`, JSON.stringify({ at: new Date().toISOString(), liveRunId: run.id, checks, browserErrors: errors, providerMutations: 0, newProjects: 0, newRuns: 0, fixturesPersisted: false }, null, 2));
} finally { await browser.close(); }
