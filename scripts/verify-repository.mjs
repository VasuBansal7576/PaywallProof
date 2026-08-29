import { spawnSync } from 'node:child_process';
import process from 'node:process';

const live = process.argv.includes('--live');
const commands = [
  ['pnpm', ['format:check']],
  ['pnpm', ['check:repository']],
  ['pnpm', ['check:delivery']],
  ['pnpm', ['check:skill']],
  ['pnpm', ['typecheck']],
  ['pnpm', ['lint']],
  ['pnpm', ['test']],
  ['pnpm', ['exec', 'next', 'build', 'apps/web']],
  ...(live ? [['pnpm', ['exec', 'tsx', 'apps/web/scripts/verify-browser.ts']]] : []),
];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
process.stdout.write(`PaywallProof verification passed${live ? ' with browser contract' : ''}\n`);
