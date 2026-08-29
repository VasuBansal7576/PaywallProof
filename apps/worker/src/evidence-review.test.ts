import { describe, expect, it, vi } from 'vitest';
import { EvidenceReviewCoordinator, type ReviewRuntime } from './evidence-review.ts';

const runId = 'run-review-contract';
const report = {
  run: {
    id: runId,
    status: 'completed',
    outcome: 'passed',
    targetBuild: 'a'.repeat(40),
    policy: { hash: 'b'.repeat(64) },
  },
  scenarios: [
    {
      id: 'SC01',
      api: { verdict: 'pass', code: 'DENIED' },
      browser: { verdict: 'pass', code: 'HIDDEN' },
      state: { verdict: 'pass', code: 'FREE' },
      observationIds: ['observation-1'],
    },
  ],
  observations: [{ id: 'observation-1', runId }],
  cleanup: [],
  coverageLimits: ['Synthetic contract fixture.'],
};
const completedReview = {
  runId,
  operationId: 'record-review',
  verdict: 'confirmed',
  summary: 'Both independent checks found the saved outcome internally consistent.',
  reviewers: [
    {
      role: 'coverage',
      verdict: 'confirmed',
      summary: 'Coverage is internally consistent.',
      findings: [],
    },
    {
      role: 'binding',
      verdict: 'confirmed',
      summary: 'Bindings are internally consistent.',
      findings: [
        {
          code: 'BINDING_OK',
          severity: 'info',
          summary: 'The cited observation belongs to this run.',
          scenarioId: 'SC01',
          observationIds: ['observation-1'],
        },
      ],
    },
  ],
};

function fixture() {
  const values = new Map<string, unknown>();
  const documents = {
    put: (kind: string, id: string, value: unknown) => values.set(`${kind}:${id}`, value),
    get: (kind: string, id: string) => values.get(`${kind}:${id}`) ?? null,
    list: (kind: string) =>
      [...values.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value),
  };
  const registerSkill = vi.fn<ReviewRuntime['registerSkill']>(async () => undefined);
  const registerMcpServer = vi.fn<ReviewRuntime['registerMcpServer']>(async () => undefined);
  const createSession = vi.fn<ReviewRuntime['createSession']>(async () => ({
    id: 'review-session',
  }));
  const beginTurn = vi.fn<ReviewRuntime['beginTurn']>(async () => ({ id: 'review-turn' }));
  const cancel = vi.fn<ReviewRuntime['cancel']>(async () => undefined);
  const resumeStream = vi.fn<ReviewRuntime['resumeStream']>(() => new Promise<never>(() => {}));
  const inspectTurn = vi.fn<ReviewRuntime['inspectTurn']>();
  const runtime = {
    registerSkill,
    registerMcpServer,
    createSession,
    beginTurn,
    cancel,
    resumeStream,
    inspectTurn,
  };
  const coordinator = new EvidenceReviewCoordinator({
    runtime,
    documents,
    report: (requestedRunId) => {
      expect(requestedRunId).toBe(runId);
      return report;
    },
    workerOrigin: 'http://127.0.0.1:8787',
    repository: 'example/paywallproof',
  });
  return { coordinator, runtime, documents };
}

describe('skill-backed evidence review', () => {
  it('starts an isolated skill and dynamic-subagent session', async () => {
    const { coordinator, runtime } = fixture();
    const state = await coordinator.start(runId);

    expect(state).toMatchObject({
      runId,
      status: 'running',
      attempt: 1,
      sessionId: 'review-session',
      turnId: 'review-turn',
      skill: {
        name: 'paywallproof-evidence-review',
        dynamicSubAgents: true,
      },
    });
    expect(runtime.registerSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'paywallproof-evidence-review',
        repositoryUrl: 'https://github.com/example/paywallproof.git',
        ref: 'a'.repeat(40),
        path: 'skills/paywallproof-evidence-review',
      }),
    );
    expect(runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: expect.stringContaining('read-report-a1'),
        enableTools: ['read_run_report', 'record_evidence_review'],
        requireApprovalForTools: [],
        skills: ['paywallproof-evidence-review'],
        dynamicSubAgents: true,
        sandbox: true,
      }),
    );
    expect(runtime.beginTurn).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.stringContaining('record-review-a1') }),
    );
  });

  it('persists and cancels a created session when the first turn fails', async () => {
    const { coordinator, runtime } = fixture();
    runtime.beginTurn.mockRejectedValueOnce(new Error('synthetic begin failure'));

    await expect(coordinator.start(runId)).rejects.toThrow('synthetic begin failure');

    expect(runtime.cancel).toHaveBeenCalledWith({ sessionId: 'review-session' });
    expect(coordinator.view(runId)).toMatchObject({
      status: 'error',
      sessionId: 'review-session',
      turnId: null,
      error: 'synthetic begin failure',
    });
  });

  it('serves the bound report and records two distinct grounded reviews', async () => {
    const { coordinator, runtime } = fixture();
    await coordinator.start(runId);
    const registration = runtime.registerMcpServer.mock.calls[0]?.[0];
    const token = new Headers(registration?.headers).get('authorization')?.replace(/^Bearer /, '');
    expect(token).toBeTruthy();
    expect(coordinator.authorize(runId, token ?? '')).toBe(true);

    const read = await coordinator.tool(runId, 'read_run_report', {
      runId,
      operationId: 'read-report',
    });
    expect(read).toMatchObject({ report, reportHash: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const recorded = await coordinator.tool(runId, 'record_evidence_review', completedReview);
    expect(recorded).toMatchObject({ runId, status: 'completed', verdict: 'confirmed' });
    expect(coordinator.view(runId)).toEqual(recorded);
  });

  it('attaches only one recovery watcher to a running review', async () => {
    const { coordinator, runtime } = fixture();
    await coordinator.start(runId);

    await coordinator.recover();
    await coordinator.recover();

    expect(runtime.resumeStream).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a completed review while failed-session cancellation is pending', async () => {
    const { coordinator, runtime } = fixture();
    let finishCancellation: ((value: unknown) => void) | undefined;
    runtime.resumeStream.mockResolvedValueOnce({
      withMetadata: async function* () {
        yield* [] as unknown[];
      },
    });
    runtime.inspectTurn.mockResolvedValueOnce({
      id: 'review-turn',
      sessionId: 'review-session',
      previousTurnId: null,
      createdAt: new Date().toISOString(),
      state: {
        status: 'error',
        message: 'Synthetic terminal failure',
        completedAt: new Date().toISOString(),
      },
    });
    runtime.cancel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCancellation = resolve;
        }),
    );
    await coordinator.start(runId);
    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledTimes(1));

    const completed = await coordinator.tool(runId, 'record_evidence_review', completedReview);
    finishCancellation?.(undefined);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(coordinator.view(runId)).toEqual(completed);
  });

  it('archives a failed attempt, revokes its token, and retries the same bound report', async () => {
    const { coordinator, runtime, documents } = fixture();
    const first = await coordinator.start(runId);
    const firstRegistration = runtime.registerMcpServer.mock.calls[0]?.[0];
    const firstToken = new Headers(firstRegistration?.headers)
      .get('authorization')
      ?.replace(/^Bearer /, '');
    documents.put('evidence-review', runId, {
      ...first,
      status: 'error',
      error: 'CODEX_SUBSCRIPTION_UNAVAILABLE',
    });

    const second = await coordinator.start(runId);
    const secondRegistration = runtime.registerMcpServer.mock.calls[1]?.[0];
    const secondToken = new Headers(secondRegistration?.headers)
      .get('authorization')
      ?.replace(/^Bearer /, '');

    expect(second).toMatchObject({ status: 'running', attempt: 2 });
    expect(documents.get('evidence-review-attempt', `${runId}:1`)).toMatchObject({
      status: 'error',
      attempt: 1,
    });
    expect(coordinator.authorize(runId, firstToken ?? '')).toBe(false);
    expect(coordinator.authorize(runId, secondToken ?? '')).toBe(true);
    expect(runtime.registerSkill).toHaveBeenLastCalledWith(
      expect.objectContaining({ ref: report.run.targetBuild }),
    );
  });
});
