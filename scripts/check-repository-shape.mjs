import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const failures = [];
const forbidden = [
  'packages',
  'docs/free-model.md',
  'docs/real-world',
  'scripts/configure-free-model.ts',
  'scripts/configure-local-model.ts',
  'scripts/inspect-local-run.ts',
  'scripts/start-free-model.ts',
  'src/integrations/free-model.ts',
];
for (const path of forbidden)
  if (existsSync(join(root, path))) failures.push(`forbidden path: ${path}`);

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs']);
function walk(directory) {
  for (const name of readdirSync(directory)) {
    if (['.git', '.local', '.next', 'node_modules'].includes(name)) continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if ([...sourceExtensions].some((extension) => name.endsWith(extension))) {
      const text = readFileSync(path, 'utf8');
      if (/packages\/(?:core|control|evidence|adapters|reference|repair)\/src/.test(text)) {
        failures.push(`legacy source import: ${relative(root, path)}`);
      }
      const generatedProtocolLine = text.split('\n').findIndex((line) => line.length > 2_000);
      if (generatedProtocolLine >= 0) {
        failures.push(
          `line over 2,000 columns: ${relative(root, path)}:${generatedProtocolLine + 1}`,
        );
      }
    }
  }
}
walk(join(root, 'apps'));
walk(join(root, 'scripts'));
walk(join(root, 'src'));
walk(join(root, 'tests'));

const controller = readFileSync(join(root, 'apps/worker/src/controller.ts'), 'utf8');
if (controller.includes('control_documents')) {
  failures.push('worker controller bypasses the control-document module');
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('repository shape passed\n');
