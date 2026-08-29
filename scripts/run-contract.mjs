import { spawnSync } from 'node:child_process';
import process from 'node:process';

const contract = process.argv[2];
const definitions = {
  'turn-selection': [
    'src/integrations/trueforge.implementation.test.ts',
    'src/repair/sandbox.implementation.test.ts',
    '-t',
    'newest-turn|first turn',
  ],
  'evidence-review': [
    'apps/worker/src/evidence-review.test.ts',
    'src/integrations/trueforge.implementation.test.ts',
    '-t',
    'skill-backed|evidence-review configuration',
  ],
};
const args = definitions[contract];
if (!args) throw new Error('Unknown contract');
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...args, '--maxWorkers=1'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write(`${contract} contract passed\n`);
