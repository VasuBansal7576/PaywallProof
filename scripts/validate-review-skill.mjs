import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const skill = readFileSync(resolve(root, 'skills/paywallproof-evidence-review/SKILL.md'), 'utf8');
const reference = resolve(
  root,
  'skills/paywallproof-evidence-review/references/review-contract.md',
);
const failures = [];
if (!skill.startsWith('---\nname: paywallproof-evidence-review\ndescription: '))
  failures.push('skill frontmatter is invalid');
if (!skill.includes('dynamic-subagent facility'))
  failures.push('dynamic-subagent procedure is missing');
if (!skill.includes('read_run_report') || !skill.includes('record_evidence_review'))
  failures.push('review tool contract is missing');
for (const phrase of ['complete report', 'reportHash', 'do not call MCP tools']) {
  if (!skill.includes(phrase)) failures.push(`subagent handoff contract is missing: ${phrase}`);
}
if (!existsSync(reference)) failures.push('review contract reference is missing');
if (skill.length > 20_000) failures.push('SKILL.md exceeds 20 KB');
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('review skill passed\n');
