import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { detailSchema } from '../apps/web/lib/contracts.ts';
import { assertLocalWorkflowComplete } from './workflow-verification.ts';

// Records the real saved workspace. No intercepted routes, presentation fixtures,
// provider requests, model requests, run creation, or publication.
const origin = 'http://127.0.0.1:3000';
const seed: unknown = JSON.parse(await readFile('.local/local-workflow-report.json', 'utf8'));
assertLocalWorkflowComplete(seed);
const run = detailSchema.parse(seed).run;
const output = resolve('.local/submission', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true });
const chapters: Array<{ start: number; end: number; caption: string }> = [];
const errors: string[] = [];
const execute = promisify(execFile);
let moviePath: string | undefined;
try {
  const login = await browser.newContext();
  const signin = await login.newPage();
  await signin.goto(origin);
  await signin.getByLabel('Operator token', { exact: true }).fill((await readFile('.local/operator-token', 'utf8')).trim());
  await signin.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(signin.getByRole('heading', { name: 'Trust the evidence.', exact: true })).toBeVisible();
  // This state belongs only to the disposable test browser and stays in memory.
  const storageState = await login.storageState();
  await login.close();
  const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 1000 }, recordVideo: { dir: output, size: { width: 1440, height: 1000 } } });
  const response = await context.request.get(`${origin}/api/runs/${run.id}`);
  assert(response.ok(), 'The saved run must be available');
  const actual = detailSchema.parse(await response.json());
  assertLocalWorkflowComplete(actual);
  assert.equal(actual.run.targetBuild, run.targetBuild);
  assert.equal(actual.run.policy.hash, run.policy.hash);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const video = page.video();
  assert(video);
  const start = Date.now();
  async function chapter(caption: string, until: number) {
    const from = (Date.now() - start) / 1000;
    process.stdout.write(`Recording: ${caption}\n`);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, until * 1000 - (Date.now() - start))));
    chapters.push({ start: from, end: (Date.now() - start) / 1000, caption });
  }
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Trust the evidence.', exact: true })).toBeVisible();
  await chapter('PaywallProof checks whether billing policy and actual feature access agree. This walkthrough shows a real recorded local-replay run, not a Polar payment.', 25);
  await page.getByRole('searchbox', { name: 'Search runs' }).fill(run.id);
  await expect(page.locator('[data-run-id]')).toHaveCount(1);
  await chapter('Saved history includes successful and incomplete runs. Search uses the full run identity; earlier failures are not rewritten as passes.', 45);
  await page.goto(`${origin}/runs/${run.id}`);
  await expect(page.locator('.scenario-table tbody tr')).toHaveCount(4);
  await expect(page.locator('.replay-warning')).toContainText('does not verify Polar');
  await chapter('Four scenarios cover free access, paid activation, scheduled cancellation and expiry. API, browser and stored-state assertions are separate: twelve recorded passes.', 75);
  await page.getByRole('tab', { name: /^Evidence/ }).click();
  await page.getByRole('button', { name: 'View screenshot', exact: true }).first().click();
  await expect(page.getByAltText(/^Recorded browser action/).first()).toBeVisible();
  await chapter('The evidence ledger links actual observations and screenshots. The app checks downloaded screenshot bytes against the stored SHA-256 before displaying them.', 105);
  await page.getByRole('tab', { name: 'Report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Run report', exact: true })).toBeVisible();
  await chapter('Human-readable reports and structured JSON use the same evidence. Each result stays bound to its target build, approved policy and feature configuration.', 135);
  await page.getByRole('tab', { name: 'Repairs', exact: true }).click();
  await chapter('Repairs require a confirmed failure, isolated source changes and the frozen evaluator. Publication requires approval of the exact diff and destination. This passed scan has no repair to propose.', 155);
  await page.goto(`${origin}/projects/new`);
  await expect(page.locator('.consent-box')).toContainText('OpenAI receives selected source code');
  await expect(page.getByRole('button', { name: 'Connect project', exact: true })).toBeDisabled();
  await chapter('TrueForge owns orchestration, tools and approvals. Luna supplies decisions through the guarded Codex subscription. No Ollama, paid fallback, automatic merge or deployment.', 180);
  await context.close();
  const raw = await video.path();
  assert.deepEqual(errors, [], 'The recording must not conceal browser errors');
  const timestamp = (seconds: number) => new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23).replace('.', ',');
  const captions = chapters.map((c, i) => `${i + 1}\n${timestamp(c.start)} --> ${timestamp(c.end)}\n${c.caption}\n`).join('\n');
  const captionsPath = resolve(output, 'walkthrough.srt');
  await writeFile(captionsPath, captions);
  moviePath = resolve(output, 'paywallproof-walkthrough.mp4');
  await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', raw, '-i', captionsPath, '-map', '0:v:0', '-map', '1:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:s', 'mov_text', '-disposition:s:0', 'default', '-movflags', '+faststart', moviePath]);
  const bytes = await readFile(moviePath);
  await writeFile(resolve(output, 'recording.json'), JSON.stringify({ status: 'recorded', scope: 'real saved local-replay workspace walkthrough, not live provider acceptance', runId: run.id, targetBuild: run.targetBuild, policyHash: run.policy.hash, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, moviePath, chapters, browserErrors: errors }, null, 2));
  process.stdout.write(JSON.stringify({ status: 'recorded', moviePath }) + '\n');
} finally {
  await browser.close();
}
