import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const token = (await readFile('.local/operator-token', 'utf8')).trim();
const response = await fetch('http://127.0.0.1:8787/api/reference/reset', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Request-Id': randomUUID(),
  },
  body: '{}',
  signal: AbortSignal.timeout(30_000),
});
const result: unknown = await response.json();
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (!response.ok) process.exitCode = 1;
