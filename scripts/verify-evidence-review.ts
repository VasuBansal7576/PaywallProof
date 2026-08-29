import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const origin = 'http://127.0.0.1:8787';
const token = (await readFile('.local/operator-token', 'utf8')).trim();
const sourceReport = z
  .object({
    run: z.object({
      id: z.string().uuid(),
      status: z.literal('completed'),
      outcome: z.literal('passed'),
      targetBuild: z.string().regex(/^[a-f0-9]{40}$/),
    }),
  })
  .parse(JSON.parse(await readFile('.local/local-workflow-report.json', 'utf8')));
const runId = process.argv[2] ?? sourceReport.run.id;
if (runId !== sourceReport.run.id) throw new Error('REVIEW_RUN_MUST_MATCH_WORKFLOW_RECEIPT');

async function call(path: string, body?: unknown) {
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Request-Id': randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return value;
}

const reviewer = z.object({
  role: z.enum(['coverage', 'binding']),
  verdict: z.enum(['confirmed', 'needs_attention', 'inconclusive']),
  summary: z.string().min(1),
  findings: z.array(z.unknown()),
});
const completedReview = z.object({
  runId: z.literal(runId),
  status: z.literal('completed'),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/),
  verdict: z.enum(['confirmed', 'needs_attention', 'inconclusive']),
  summary: z.string().min(1),
  reviewers: z.array(reviewer).length(2),
  skill: z.object({
    name: z.literal('paywallproof-evidence-review'),
    ref: z.literal(sourceReport.run.targetBuild),
    path: z.literal('skills/paywallproof-evidence-review'),
    dynamicSubAgents: z.literal(true),
  }),
});
const reviewState = z.object({
  status: z.enum(['starting', 'running', 'completed', 'error']),
  error: z.string().nullable(),
});

await call(`/api/runs/${runId}/evidence-review`, {});
const deadline = Date.now() + 10 * 60 * 1000;
let receipt: z.infer<typeof completedReview> | undefined;
while (Date.now() < deadline) {
  const detail = z
    .object({ evidenceReview: reviewState.nullable() })
    .parse(await call(`/api/runs/${runId}`));
  if (detail.evidenceReview?.status === 'error') {
    throw new Error(detail.evidenceReview.error ?? 'EVIDENCE_REVIEW_FAILED');
  }
  if (detail.evidenceReview?.status === 'completed') {
    receipt = completedReview.parse(detail.evidenceReview);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (!receipt) throw new Error('EVIDENCE_REVIEW_TIMEOUT');
if (new Set(receipt.reviewers.map((item) => item.role)).size !== 2) {
  throw new Error('EVIDENCE_REVIEW_ROLES_INVALID');
}
const directory = `.local/workflow-${runId}`;
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(`${directory}/evidence-review.json`, JSON.stringify(receipt, null, 2), {
  mode: 0o600,
});
process.stdout.write(
  `${JSON.stringify({
    status: 'passed',
    runId,
    verdict: receipt.verdict,
    reviewerRoles: receipt.reviewers.map((item) => item.role).sort(),
    skill: receipt.skill,
    reportHash: receipt.reportHash,
    receiptPath: `${directory}/evidence-review.json`,
  })}\n`,
);
