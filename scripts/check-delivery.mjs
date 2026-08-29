import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const qodo = read('.pr_agent.toml');
const template = read('.github/pull_request_template.md');
const packageJson = JSON.parse(read('package.json'));
const requiredScripts = [
  'format:check',
  'check:repository',
  'check:skill',
  'typecheck',
  'lint',
  'test',
];
const failures = requiredScripts.filter((name) => typeof packageJson.scripts?.[name] !== 'string');
if (!workflow.includes('pnpm verify:ci')) failures.push('CI does not run verify:ci');
if (!workflow.includes('pnpm exec playwright install --with-deps chromium')) {
  failures.push('CI does not install the pinned Playwright Chromium runtime');
}
if (!qodo.includes('/agentic_review')) failures.push('Qodo agentic review command is missing');
for (const phrase of ['Fixed every valid finding', 'follow-up review', 'merge-ready']) {
  if (!template.includes(phrase)) failures.push(`PR checklist is missing: ${phrase}`);
}
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('delivery configuration passed\n');
