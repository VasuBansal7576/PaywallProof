import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  adapterDoctorReportSchema,
  type AdapterDoctorReport,
} from '../src/adapter-doctor/report.ts';
import {
  assertLocalWorkflowComplete,
  assertPolarWorkflowComplete,
} from './workflow-verification.ts';

export type WorkflowMode = 'local_replay' | 'polar_sandbox';

const origin = 'http://127.0.0.1:8787';
const workflowConfigSchema = z.object({
  target: z.object({ id: z.string() }),
  repository: z.string(),
  defaultRef: z.string(),
  priceId: z.string(),
});
const workflowPreflightSchema = z.object({
  ready: z.boolean(),
  adapter: adapterDoctorReportSchema,
  connections: z.array(z.unknown()),
});
const runDetailSchema = z.object({
  run: z.object({ status: z.string(), outcome: z.string().nullable() }),
  runtime: z.object({ status: z.string(), error: z.string().optional() }).nullable(),
  runtimeError: z.unknown().nullable(),
  scenarios: z.array(
    z.object({
      id: z.string(),
      api: z.object({ verdict: z.string() }),
      browser: z.object({ verdict: z.string() }),
      state: z.object({ verdict: z.string() }),
    }),
  ),
});

async function operatorToken() {
  return (await readFile('.local/operator-token', 'utf8')).trim();
}

async function call(token: string, path: string, body?: unknown) {
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
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

/** Internal test seam for the worker's private checkout redirect contract. */
export async function checkoutReadyForVerification(
  token: string,
  runId: string,
  transport: typeof fetch = fetch,
): Promise<boolean> {
  const response = await transport(new URL(`/api/runs/${runId}/checkout`, origin), {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 409) return false;
  if (response.status !== 303 || !response.headers.get('location'))
    throw new Error(`CHECKOUT_ROUTE_${response.status}`);
  return true;
}

/** Polls the provider-confirmed continuation boundary without treating 409 as success. */
export async function continueCheckoutForVerification(
  token: string,
  runId: string,
  transport: typeof fetch = fetch,
): Promise<boolean> {
  const response = await transport(new URL(`/api/runs/${runId}/checkout/continue`, origin), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Request-Id': randomUUID(),
    },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 409) return false;
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(`CHECKOUT_CONTINUATION_${response.status}`);
  z.object({ status: z.literal('resumed'), turnId: z.string() }).parse(value);
  return true;
}

export function workflowDeadlineAfterPoll(
  deadline: number,
  previousPollAt: number,
  polledAt: number,
  runtimeStatus: string | undefined,
) {
  return runtimeStatus === 'waiting_external'
    ? deadline + Math.max(0, polledAt - previousPollAt)
    : deadline;
}

export function workflowReadyForReport(runStatus: string, runtimeStatus: string | undefined) {
  return runStatus === 'completed' && runtimeStatus === 'done';
}

export function workflowProjectRequest(
  config: z.infer<typeof workflowConfigSchema>,
  mode: WorkflowMode,
  createdAt: string,
) {
  return {
    name: `${mode === 'polar_sandbox' ? 'Polar' : 'Local'} workflow verification ${createdAt}`,
    repository: config.repository,
    ref: config.defaultRef,
    targetId: config.target.id,
    ownershipConfirmed: true,
    modelConsent: true,
  };
}

export function workflowPolicyRequest(
  config: z.infer<typeof workflowConfigSchema>,
  report: AdapterDoctorReport,
) {
  if (report.verdict !== 'compatible') throw new Error('ADAPTER_DOCTOR_BLOCKED');
  return {
    schemaVersion: 2,
    priceId: config.priceId,
    featureId: report.receipt.description.feature.id,
    featureConfigHash: report.receipt.featureConfigHash,
    cancellation: 'allow_until_period_end',
    requireInitialPaymentConfirmed: true,
    syncWindowSeconds: 5,
    predicateVersion: 'paywallproof-entitlement-v1',
  } as const;
}

async function createRun(token: string, mode: WorkflowMode) {
  const config = workflowConfigSchema.parse(await call(token, '/api/config'));
  const project = z
    .object({ id: z.string() })
    .parse(
      await call(
        token,
        '/api/projects',
        workflowProjectRequest(config, mode, new Date().toISOString()),
      ),
    );
  const preflight = workflowPreflightSchema.parse(
    await call(token, `/api/projects/${project.id}/preflight`, { mode }),
  );
  if (!preflight.ready)
    throw new Error(
      `Preflight blocked: ${JSON.stringify({ adapter: preflight.adapter, connections: preflight.connections })}`,
    );
  const policy = z
    .object({ hash: z.string() })
    .parse(
      await call(
        token,
        `/api/projects/${project.id}/policies`,
        workflowPolicyRequest(config, preflight.adapter),
      ),
    );
  return z
    .object({
      id: z.string(),
      mode: z.literal(mode),
      approval: z.object({ id: z.string(), bindingHash: z.string() }),
    })
    .parse(
      await call(token, '/api/runs', {
        projectId: project.id,
        policyHash: policy.hash,
        mode,
      }),
    );
}

async function preserveReceipt(mode: WorkflowMode, runId: string, report: unknown) {
  const directory = `.local/workflow-${runId}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  const convenience =
    mode === 'local_replay'
      ? '.local/local-workflow-report.json'
      : '.local/polar-workflow-report.json';
  try {
    await writeFile(`${directory}/previous-report.json`, await readFile(convenience), {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await writeFile(convenience, JSON.stringify(report, null, 2), { mode: 0o600 });
  return `${directory}/report.json`;
}

/** Runs one controller-owned workflow through its public HTTP interface. */
export async function verifyWorkflow(mode: WorkflowMode): Promise<void> {
  const token = await operatorToken();
  const run = await createRun(token, mode);
  const directory = `.local/workflow-${run.id}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  process.stdout.write(
    `${JSON.stringify({ runId: run.id, mode, url: `http://127.0.0.1:3000/runs/${run.id}` })}\n`,
  );
  let deadline = performance.now() + (mode === 'polar_sandbox' ? 30 : 20) * 60 * 1000,
    previousPollAt = performance.now();
  let approved = false,
    checkoutAnnounced = false,
    checkoutContinued = false,
    previous = '',
    passed = false;
  try {
    while (performance.now() < deadline) {
      const detail = runDetailSchema.parse(await call(token, `/api/runs/${run.id}`));
      const polledAt = performance.now();
      deadline = workflowDeadlineAfterPoll(
        deadline,
        previousPollAt,
        polledAt,
        detail.runtime?.status,
      );
      previousPollAt = polledAt;
      const summary = JSON.stringify({
        status: detail.run.status,
        runtime: detail.runtime?.status,
        scenarios: detail.scenarios,
      });
      if (summary !== previous) {
        process.stdout.write(`${summary}\n`);
        previous = summary;
      }
      if (detail.runtimeError || detail.runtime?.status === 'error')
        throw new Error(`Runtime failed: ${JSON.stringify(detail.runtimeError ?? detail.runtime)}`);
      if (detail.run.status === 'canceled')
        throw new Error('The verification run was canceled; no pass is claimed.');
      if (!approved && detail.runtime?.status === 'approval') {
        await call(token, `/api/runs/${run.id}/approvals/${run.approval.id}`, {
          decision: 'allow',
          bindingHash: run.approval.bindingHash,
        });
        approved = true;
      }
      if (
        mode === 'polar_sandbox' &&
        !checkoutAnnounced &&
        (await checkoutReadyForVerification(token, run.id))
      ) {
        checkoutAnnounced = true;
        process.stdout.write(
          `${JSON.stringify({
            status: 'checkout_required',
            runId: run.id,
            url: `http://127.0.0.1:3000/runs/${run.id}`,
          })}\n`,
        );
      }
      if (
        mode === 'polar_sandbox' &&
        checkoutAnnounced &&
        !checkoutContinued &&
        (await continueCheckoutForVerification(token, run.id))
      ) {
        checkoutContinued = true;
        process.stdout.write(
          `${JSON.stringify({ status: 'checkout_confirmed', runId: run.id })}\n`,
        );
      }
      if (workflowReadyForReport(detail.run.status, detail.runtime?.status)) {
        const report = await call(token, `/api/runs/${run.id}/report?format=json`);
        if (mode === 'local_replay') assertLocalWorkflowComplete(report);
        else assertPolarWorkflowComplete(report);
        const reportPath = await preserveReceipt(mode, run.id, report);
        passed = true;
        process.stdout.write(
          `${JSON.stringify({
            status: 'passed',
            mode,
            runId: run.id,
            credentialedPolarExecuted: mode === 'polar_sandbox',
            reportPath,
          })}\n`,
        );
        break;
      }
      if (detail.runtime?.status === 'done' && approved && detail.run.status === 'running')
        throw new Error('The agent ended before completing the required workflow.');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!passed) throw new Error('Workflow verification exceeded its deadline.');
  } catch (error) {
    let cancellation: 'confirmed' | 'unconfirmed' = 'unconfirmed';
    try {
      await call(token, `/api/runs/${run.id}/cancel`, {});
      cancellation = 'confirmed';
    } catch {
      /* Preserve the original failure and disclose uncertain cleanup. */
    }
    await writeFile(
      `${directory}/failure.json`,
      JSON.stringify(
        { status: 'failed', runId: run.id, at: new Date().toISOString(), cancellation },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    throw error;
  }
}
