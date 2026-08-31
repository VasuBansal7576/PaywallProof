import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Controller,
  lifecycleAgentInstructions,
  lifecycleTurnInput,
  runtimeStatusAfterTurn,
  coverageForMode,
  coverageLimits,
  type ControllerConfig,
} from './controller.ts';
import { createControlApp, startAfterRecovery } from './http.ts';
import { createPolicy, hashValue } from '#domain';
import { observeFeature } from '#evidence/probe';
import { TrueForgeAdapter, type RuntimeTurn, type RuntimeApproval } from '#integrations/trueforge';
import { patchHash, repairBranch } from '#repair';
import { RepairCoordinator, type RepairJob, type RepairSource } from './repairs.ts';
import { SECURITY_CONTROLS } from '#repair/controls';
import { artifactRetentionFromDays } from './artifacts.ts';
import { ADAPTER_DOCTOR_SCOPE, adapterDoctorReportSchema } from '#adapter-doctor';
import { repairProfileFromEnvironment } from './repair-profile.ts';
import { bindTargetFeatureProbe } from '#integrations/target-contract';

// Implementation-aware failure-injection tests. No provider or runtime evidence.
const capacityMocks = vi.hoisted(() => ({ statfs: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  statfs: capacityMocks.statfs,
}));
const opened: { controller: Controller; directory: string }[] = [];
const feature = {
  id: 'pro_export',
  method: 'GET',
  path: '/api/export',
  denialStatuses: [403],
  browserPath: '/dashboard',
  actionTestId: 'export-button',
  resultTestId: 'export-result',
} as const;

function compatibleDoctorReport() {
  const featureProbe = bindTargetFeatureProbe(feature);
  return adapterDoctorReportSchema.parse({
    schemaVersion: 2,
    verdict: 'compatible',
    scope: ADAPTER_DOCTOR_SCOPE,
    targetId: 'reference',
    expectedBuildId: 'a'.repeat(40),
    checks: [
      ['description', 'DESCRIPTION_ACCEPTED'],
      ['build_binding', 'BUILD_MATCHES'],
      ['staging_authentication', 'STAGING_AUTH_REQUIRED'],
      ['ordinary_feature_isolation', 'ADAPTER_CREDENTIAL_ISOLATED'],
      ['response_cache_policy', 'NO_STORE_CONFIRMED'],
    ].map(([id, code]) => ({ id, status: 'pass', code, title: id, detail: code })),
    receipt: {
      description: {
        adapterVersion: '1',
        environment: 'test',
        buildId: 'a'.repeat(40),
        billingTimeModel: 'provider_status',
        feature,
      },
      featureConfigHash: hashValue(feature),
      featureProbe: featureProbe.contract,
      featureProbeHash: featureProbe.hash,
    },
  });
}

describe('mode-specific coverage limits', () => {
  it('labels synthetic replay without mislabeling native Polar sandbox evidence', () => {
    expect(coverageForMode('local_replay').coverageLimitCodes).toContain(
      'LOCAL_REPLAY_NOT_NATIVE_PROVIDER_DELIVERY',
    );
    expect(coverageForMode('polar_sandbox').coverageLimitCodes).not.toContain(
      'LOCAL_REPLAY_NOT_NATIVE_PROVIDER_DELIVERY',
    );
    expect(coverageForMode('polar_sandbox').coverageLimits.join(' ')).not.toMatch(
      /local replay|synthetic signed billing/i,
    );
    expect(coverageLimits.join(' ')).not.toMatch(/local replay|synthetic signed billing/i);
  });
});

describe('TrueForge lifecycle instructions', () => {
  it('makes the agent inspect the project and doctor-backed connections before requesting mutation', () => {
    const runId = randomUUID();

    const instructions = lifecycleAgentInstructions(runId);
    const input = lifecycleTurnInput(runId, 'local_replay');

    expect(instructions).toContain(
      'inspect_project; check_connections; prepare_fixture; probe_feature SC01',
    );
    expect(input).toContain('First call inspect_project with operationId step_inspect');
    expect(input).toContain('then check_connections with operationId step_connections');
    expect(input).toContain('Only then call prepare_fixture with operationId step_prepare');
  });
});

describe('external checkout runtime boundary', () => {
  it('persists a waiting state instead of failing an intentional terminal turn', () => {
    expect(
      runtimeStatusAfterTurn({
        requiredActions: 0,
        mode: 'polar_sandbox',
        checkoutStarted: true,
        subscriptionCreated: false,
      }),
    ).toBe('waiting_external');
  });

  it('keeps ordinary incomplete terminal turns fail-closed', () => {
    expect(
      runtimeStatusAfterTurn({
        requiredActions: 0,
        mode: 'local_replay',
        checkoutStarted: false,
        subscriptionCreated: false,
      }),
    ).toBe('done');
  });

  it('exposes an authenticated, request-idempotent continuation endpoint', async () => {
    const { controller, app } = setup(true);
    if (!app) throw new Error('HTTP fixture missing');
    const runId = randomUUID();
    const continuation = vi
      .spyOn(controller, 'continueCheckout')
      .mockResolvedValue({ status: 'resumed', turnId: 'synthetic-turn' });
    const response = await app.request(
      `http://127.0.0.1:39982/api/runs/${runId}/checkout/continue`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic-operator',
          'Content-Type': 'application/json',
          'X-Request-Id': 'synthetic-checkout-continuation',
        },
        body: '{}',
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'resumed', turnId: 'synthetic-turn' });
    expect(continuation).toHaveBeenCalledExactlyOnceWith(runId);
  });

  it('maps an external checkout wait to a retryable conflict', async () => {
    const { controller, app } = setup(true);
    if (!app) throw new Error('HTTP fixture missing');
    vi.spyOn(controller, 'continueCheckout').mockRejectedValue(
      new (await import('#run')).ControlError('CHECKOUT_CONTINUATION_NOT_READY'),
    );
    const response = await app.request(
      `http://127.0.0.1:39982/api/runs/${randomUUID()}/checkout/continue`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic-operator',
          'Content-Type': 'application/json',
          'X-Request-Id': 'synthetic-checkout-wait',
        },
        body: '{}',
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'CHECKOUT_CONTINUATION_NOT_READY' },
    });
  });

  it('reuses the exact durable wait credit after a crash before the controller marker', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000001';
    const productId = '00000000-0000-4000-8000-000000000002';
    const priceId = '00000000-0000-4000-8000-000000000003';
    const { controller, start } = setup(false, {
      polarToken: 'polar_oat_synthetic',
      polarOrganizationId: organizationId,
      polarProductId: productId,
      priceId,
      testCustomerEmail: 'owned-sandbox@example.test',
    });
    if (!controller.polar) throw new Error('Missing Polar fixture');
    const preflight = {
      provider: 'polar',
      mode: 'polar_sandbox',
      organizationId,
      productId,
      priceId,
      amount: 100,
      currency: 'usd',
      apiVersion: '2026-04',
      scope: 'read_only_preflight',
      lifecycleVerified: false,
    } as const;
    vi.spyOn(controller.polar, 'preflight').mockResolvedValue(preflight);
    vi.spyOn(controller.polar, 'ensurePreflight').mockResolvedValue(preflight);
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    vi.spyOn(controller.runtime, 'resumeStream').mockImplementation(() => new Promise(() => {}));
    const run = await start('polar_sandbox');
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-checkout-turn',
      lastSequenceNumber: 0,
      status: 'waiting_external',
    });
    controller.put('context', run.id, {
      ...controller.context(run.id),
      checkoutStarted: true,
    });
    const startedAt = Date.now();
    controller.put('external-wait', run.id, {
      waitId: 'polar_checkout',
      status: 'waiting',
      startedAt,
    });
    vi.spyOn(controller.polar, 'checkoutCompleted').mockResolvedValue(true);
    vi.spyOn(controller.runtime, 'continueTurn').mockResolvedValue(
      syntheticTurn('synthetic-checkout-resumed', 'synthetic-checkout-turn'),
    );
    const credit = vi.spyOn(controller.runs, 'creditExternalWait');
    const write = controller.put.bind(controller);
    let interrupted = true;
    vi.spyOn(controller, 'put').mockImplementation((kind, id, value) => {
      if (
        interrupted &&
        kind === 'external-wait' &&
        (value as { status?: string }).status === 'credited'
      ) {
        interrupted = false;
        throw new Error('synthetic crash after durable wait credit');
      }
      write(kind, id, value);
    });

    await expect(controller.continueCheckout(run.id)).rejects.toThrow('synthetic crash');
    const persisted = controller.runs.externalWaitCredit({
      runId: run.id,
      waitId: 'polar_checkout',
    });
    expect(persisted).toMatchObject({ startedAt, endedAt: expect.any(Number) });
    expect(controller.get('external-wait', run.id)).toMatchObject({ status: 'waiting' });

    await expect(controller.continueCheckout(run.id)).resolves.toMatchObject({
      status: 'resumed',
      turnId: 'synthetic-checkout-resumed',
    });
    const resumedRuntime = controller.get('runtime', run.id);
    await expect(controller.continueCheckout(run.id)).resolves.toEqual({
      status: 'resumed',
      turnId: 'synthetic-checkout-resumed',
    });
    expect(controller.get('runtime', run.id)).toEqual(resumedRuntime);
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-terminal-turn',
      lastSequenceNumber: 23,
      status: 'done',
    });
    controller.runs.finishRun({ runId: run.id, verdicts: ['pass'] });
    const terminalRuntime = controller.get('runtime', run.id);
    await expect(controller.continueCheckout(run.id)).resolves.toEqual({
      status: 'resumed',
      turnId: 'synthetic-checkout-resumed',
    });
    expect(controller.get('runtime', run.id)).toEqual(terminalRuntime);
    expect(credit).toHaveBeenCalledTimes(1);
    expect(controller.runtime.continueTurn).toHaveBeenCalledTimes(1);
    expect(controller.get('external-wait', run.id)).toEqual({
      waitId: 'polar_checkout',
      status: 'credited',
      startedAt,
      endedAt: persisted?.endedAt,
    });
  });

  it('converges to cancellation when the checkout continuation reaches its deadline at dispatch', async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse('2026-08-30T11:00:00.000Z');
    vi.setSystemTime(startedAt);
    const organizationId = '00000000-0000-4000-8000-000000000031';
    const productId = '00000000-0000-4000-8000-000000000032';
    const priceId = '00000000-0000-4000-8000-000000000033';
    const { controller, start } = setup(false, {
      polarToken: 'polar_oat_synthetic',
      polarOrganizationId: organizationId,
      polarProductId: productId,
      priceId,
      testCustomerEmail: 'owned-sandbox@example.test',
    });
    if (!controller.polar) throw new Error('Missing Polar fixture');
    const preflight = {
      provider: 'polar',
      mode: 'polar_sandbox',
      organizationId,
      productId,
      priceId,
      amount: 100,
      currency: 'usd',
      apiVersion: '2026-04',
      scope: 'read_only_preflight',
      lifecycleVerified: false,
    } as const;
    vi.spyOn(controller.polar, 'preflight').mockResolvedValue(preflight);
    vi.spyOn(controller.polar, 'ensurePreflight').mockResolvedValue(preflight);
    vi.spyOn(controller.polar, 'cleanup').mockResolvedValue([]);
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start('polar_sandbox');
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-checkout-turn',
      lastSequenceNumber: 0,
      status: 'waiting_external',
    });
    controller.put('context', run.id, {
      ...controller.context(run.id),
      checkoutStarted: true,
    });
    controller.put('external-wait', run.id, {
      waitId: 'polar_checkout',
      status: 'waiting',
      startedAt,
    });
    vi.spyOn(controller.polar, 'checkoutCompleted').mockResolvedValue(true);
    let runtimeRequests = 0;
    vi.spyOn(controller.runtime, 'continueTurn').mockImplementation(async (options) => {
      vi.setSystemTime(startedAt + 15 * 60 * 1000);
      options.beforeDispatch?.();
      runtimeRequests += 1;
      return syntheticTurn('must-not-dispatch', 'synthetic-checkout-turn');
    });

    await expect(controller.continueCheckout(run.id)).rejects.toMatchObject({
      code: 'EXECUTION_DEADLINE',
    });
    await expect.poll(() => controller.runs.getRun(run.id).status).toBe('canceled');
    expect(runtimeRequests).toBe(0);
    expect(controller.get('limit-hit', run.id)).toEqual({
      code: 'EXECUTION_DEADLINE',
      at: startedAt + 15 * 60 * 1000,
    });
  });

  it('reconciles an in-flight checkout continuation without leaving a running cursor after stop', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000041';
    const productId = '00000000-0000-4000-8000-000000000042';
    const priceId = '00000000-0000-4000-8000-000000000043';
    const { controller, start } = setup(false, {
      polarToken: 'polar_oat_synthetic',
      polarOrganizationId: organizationId,
      polarProductId: productId,
      priceId,
      testCustomerEmail: 'owned-sandbox@example.test',
    });
    if (!controller.polar) throw new Error('Missing Polar fixture');
    const preflight = {
      provider: 'polar',
      mode: 'polar_sandbox',
      organizationId,
      productId,
      priceId,
      amount: 100,
      currency: 'usd',
      apiVersion: '2026-04',
      scope: 'read_only_preflight',
      lifecycleVerified: false,
    } as const;
    vi.spyOn(controller.polar, 'preflight').mockResolvedValue(preflight);
    vi.spyOn(controller.polar, 'ensurePreflight').mockResolvedValue(preflight);
    vi.spyOn(controller.polar, 'cleanup').mockResolvedValue([]);
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start('polar_sandbox');
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-checkout-turn',
      lastSequenceNumber: 0,
      status: 'waiting_external',
    });
    controller.put('context', run.id, {
      ...controller.context(run.id),
      checkoutStarted: true,
    });
    controller.put('external-wait', run.id, {
      waitId: 'polar_checkout',
      status: 'waiting',
      startedAt: Date.now(),
    });
    vi.spyOn(controller.polar, 'checkoutCompleted').mockResolvedValue(true);
    let finishContinuation: ((turn: RuntimeTurn) => void) | undefined;
    const dispatch = vi.spyOn(controller.runtime, 'continueTurn').mockImplementation(
      () =>
        new Promise<RuntimeTurn>((resolve) => {
          finishContinuation = resolve;
        }),
    );
    const resume = vi
      .spyOn(controller.runtime, 'resumeStream')
      .mockImplementation(() => new Promise(() => {}));

    const continuation = controller.continueCheckout(run.id);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    await controller.cancel(run.id);
    finishContinuation?.(syntheticTurn('synthetic-checkout-resumed', 'synthetic-checkout-turn'));

    await expect(continuation).rejects.toMatchObject({ code: 'RUN_CANCELED' });
    await expect.poll(() => controller.runs.getRun(run.id).status).toBe('canceled');
    expect(controller.get('checkout-continuation', run.id)).toMatchObject({
      status: 'confirmed',
      turnId: 'synthetic-checkout-resumed',
    });
    expect(controller.get('runtime', run.id)).toMatchObject({
      turnId: 'synthetic-checkout-resumed',
      status: 'error',
      error: 'RUN_STOPPED_AFTER_CONTINUATION',
    });
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('adapter doctor control surface', () => {
  it('keeps request serving closed until persisted recovery finishes', async () => {
    let finishRecovery: (() => void) | undefined;
    const recover = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRecovery = resolve;
        }),
    );
    const serve = vi.fn(() => 'synthetic-server');

    const started = startAfterRecovery({ recover }, serve);
    await Promise.resolve();
    expect(serve).not.toHaveBeenCalled();
    finishRecovery?.();

    await expect(started).resolves.toBe('synthetic-server');
    expect(serve).toHaveBeenCalledTimes(1);
  });

  it('composes preflight from the doctor receipt without a second description request', async () => {
    const { controller, project } = setup();
    const describe = vi.spyOn(controller.target, 'describe');
    describe.mockClear();

    const preflight = await controller.preflight(project.id, 'local_replay');

    expect(preflight.adapter).toEqual(compatibleDoctorReport());
    expect(preflight.connections.map((check) => check.name)).toEqual(['Billing mode', 'TrueForge']);
    expect(preflight).not.toHaveProperty('target');
    expect(preflight).not.toHaveProperty('featureConfigHash');
    expect(describe).not.toHaveBeenCalled();
  });

  it('reads a persisted evidence review without recursively rebuilding the review source', async () => {
    const { controller, start } = setup();
    const lifecycleRegistration = vi
      .spyOn(controller.runtime, 'registerMcpServer')
      .mockImplementation(() => new Promise(() => {}));
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.runs.finishRun({ runId: run.id, verdicts: ['inconclusive'] });
    lifecycleRegistration.mockResolvedValue({
      data: {
        name: 'synthetic-review-server',
        authStatus: { status: 'not_required' },
        manifest: {
          type: 'remote',
          name: 'synthetic-review-server',
          url: 'http://127.0.0.1:39982/mcp/reviews/synthetic',
          description: 'Synthetic evidence review server',
        },
      },
    });
    vi.spyOn(controller.runtime, 'registerSkill').mockResolvedValue({
      data: {
        name: 'paywallproof-evidence-review',
        manifest: {
          type: 'git',
          name: 'paywallproof-evidence-review',
          description: 'Synthetic evidence review skill',
          url: 'https://github.com/synthetic/repository.git',
          ref: 'a'.repeat(40),
          path: 'skills/paywallproof-evidence-review',
        },
      },
    });
    vi.spyOn(controller.runtime, 'createSession').mockResolvedValue({
      id: 'review-session',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: 'synthetic',
      title: null,
      agent: { type: 'reference', id: 'synthetic-review-agent', name: null },
    });
    vi.spyOn(controller.runtime, 'beginTurn').mockResolvedValue(syntheticTurn('review-turn', null));
    vi.spyOn(controller.runtime, 'resumeStream').mockImplementation(() => new Promise(() => {}));

    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-lifecycle-turn',
      lastSequenceNumber: 4,
      status: 'running',
    });
    await expect(controller.startEvidenceReview(run.id, {})).rejects.toMatchObject({
      code: 'EVIDENCE_REVIEW_NOT_READY',
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-lifecycle-turn',
      lastSequenceNumber: 5,
      status: 'done',
    });

    await controller.startEvidenceReview(run.id, {});

    expect(controller.viewRun(run.id).evidenceReview).toMatchObject({
      status: 'running',
      reportCurrent: true,
    });
    await expect(
      controller.reviews.tool(run.id, 'read_run_report', {
        runId: run.id,
        operationId: 'read-report-a1',
      }),
    ).resolves.toMatchObject({
      report: { run: { id: run.id, status: 'completed' } },
      reportHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('invalidates plan approval when the configured Polar test mailbox changes', async () => {
    const { controller, start } = setup(false, {
      testCustomerEmail: 'first-owned-mailbox@example.test',
    });
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.config.testCustomerEmail = 'different-owned-mailbox@example.test';

    await expect(
      controller.decidePlan(run.id, run.approval.id, {
        decision: 'allow',
        bindingHash: run.approval.bindingHash,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
    expect(controller.runs.getRun(run.id).approval.decision).toBe('pending');
  });

  it('treats a Polar mailbox local-part case change as approval drift', async () => {
    const { controller, start } = setup(false, {
      testCustomerEmail: 'Owned.Mailbox@example.test',
    });
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.config.testCustomerEmail = 'owned.mailbox@example.test';

    await expect(
      controller.decidePlan(run.id, run.approval.id, {
        decision: 'allow',
        bindingHash: run.approval.bindingHash,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
  });

  it('binds a policy to the doctor receipt without a legacy description request', async () => {
    const { controller, project } = setup();
    const describe = vi.spyOn(controller.target, 'describe');
    const inspect = vi.spyOn(controller.adapterDoctor, 'inspect');
    describe.mockClear();
    inspect.mockClear();

    const policy = await controller.proposePolicy(project.id, {
      schemaVersion: 2,
      priceId: 'price_synthetic',
      featureId: 'pro_export',
      featureConfigHash: hashValue(feature),
      cancellation: 'allow_until_period_end',
      requireInitialPaymentConfirmed: true,
      syncWindowSeconds: 5,
      predicateVersion: 'reference-export-v1',
    });

    expect(policy.featureConfigHash).toBe(hashValue(feature));
    expect(inspect).toHaveBeenCalledOnce();
    expect(describe).not.toHaveBeenCalled();
  });

  it('rejects a saved policy when the configured billing price changes before run creation', async () => {
    const { controller, project } = setup();
    const policy = await controller.proposePolicy(project.id, {
      schemaVersion: 2,
      priceId: 'price_synthetic',
      featureId: 'pro_export',
      featureConfigHash: hashValue(feature),
      cancellation: 'allow_until_period_end',
      requireInitialPaymentConfirmed: true,
      syncWindowSeconds: 5,
      predicateVersion: 'reference-export-v1',
    });
    controller.config.priceId = 'price_changed_before_run';

    await expect(
      controller.createRun({
        projectId: project.id,
        policyHash: policy.hash,
        mode: 'local_replay',
      }),
    ).rejects.toMatchObject({ code: 'POLICY_TARGET_MISMATCH' });
    expect(controller.list('run-index')).toEqual([]);
  });

  it('persists the Doctor-validated feature descriptor and probe rules in the immutable run binding', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );

    const run = await start();

    expect(run.targetFeature).toEqual(feature);
    expect(run.featureProbeHash).toBe(bindTargetFeatureProbe(feature).hash);
    expect(controller.runs.getRun(run.id).targetFeature).toEqual(feature);
    expect(controller.runs.getRun(run.id).featureProbeHash).toBe(
      bindTargetFeatureProbe(feature).hash,
    );
  });

  it('keeps a schema-v1 Doctor receipt historical and blocks new policy or run work', async () => {
    const { controller, project } = setup();
    const current = compatibleDoctorReport();
    if (current.verdict !== 'compatible') throw new Error('Expected compatible Doctor fixture');
    vi.mocked(controller.adapterDoctor.inspect).mockResolvedValue(
      adapterDoctorReportSchema.parse({
        ...current,
        schemaVersion: 1,
        receipt: {
          description: current.receipt.description,
          featureConfigHash: current.receipt.featureConfigHash,
        },
      }),
    );

    await expect(controller.preflight(project.id, 'local_replay')).resolves.toMatchObject({
      ready: false,
      adapter: { schemaVersion: 1, verdict: 'compatible' },
    });
    await expect(
      controller.proposePolicy(project.id, {
        schemaVersion: 2,
        priceId: 'price_synthetic',
        featureId: feature.id,
        featureConfigHash: hashValue(feature),
        cancellation: 'allow_until_period_end',
        requireInitialPaymentConfirmed: true,
        syncWindowSeconds: 5,
        predicateVersion: 'reference-export-v1',
      }),
    ).rejects.toMatchObject({ code: 'PREFLIGHT_BLOCKED' });
    expect(controller.list('run-index')).toEqual([]);
  });

  it('rejects stale code-owned probe rules before the browser or API probe', async () => {
    const { controller } = setup();
    const policy = createPolicy({
      schemaVersion: 2,
      priceId: 'price_synthetic',
      featureId: feature.id,
      featureConfigHash: hashValue(feature),
      cancellation: 'allow_until_period_end',
      requireInitialPaymentConfirmed: true,
      syncWindowSeconds: 5,
      predicateVersion: 'reference-export-v1',
    });
    const denial = {
      status: 403,
      body: { error: 'ACCESS_DENIED' },
      transportError: false,
      denialStatuses: [403] satisfies 403[],
    };
    const session = vi.spyOn(controller.target, 'session').mockResolvedValue({
      cookie: 'pp_session=synthetic',
      expiresAt: new Date(Date.now() + 100_000).toISOString(),
    });
    const browser = vi.spyOn(controller.browser, 'probe').mockResolvedValue({
      probe: denial,
      artifact: {
        id: 'stale-binding.png',
        sha256: 'a'.repeat(64),
        contentType: 'image/png',
        source: 'browser',
        collectedAt: new Date().toISOString(),
      },
    });
    const snapshot = vi.spyOn(controller.target, 'snapshot').mockResolvedValue({
      principalId: 'synthetic-free',
      runId: 'synthetic-probe-run',
      customerId: null,
      status: 'none',
      buildId: 'a'.repeat(40),
    });
    const api = vi.spyOn(controller.target, 'probe').mockResolvedValue(denial);

    await expect(
      observeFeature({
        store: controller.evidence,
        target: controller.target,
        browser: controller.browser,
        runId: 'synthetic-probe-run',
        scenarioId: 'SC01',
        subjectId: 'synthetic-free',
        fixtureMarker: 'synthetic-private-marker',
        policy,
        targetBuild: 'a'.repeat(40),
        featureProbeHash: 'f'.repeat(64),
        mode: 'local_replay',
        notBefore: Date.now(),
        billing: async () => ({
          livemode: false,
          identityResolved: true,
          noSubscriptionConfirmed: true,
          customerId: null,
          subscription: null,
        }),
      }),
    ).rejects.toThrow('FEATURE_PROBE_BINDING_MISMATCH');
    expect(session).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    expect(controller.evidence.list('synthetic-probe-run')).toEqual([]);
  });

  it('rejects a saved project after the configured target identity changes', async () => {
    const { controller, project } = setup();
    controller.config.targetId = 'secondary-contract-target';

    await expect(controller.inspectAdapter(project.id)).rejects.toMatchObject({
      code: 'PROJECT_CONFIG_CHANGED',
    });
    await expect(controller.preflight(project.id, 'local_replay')).rejects.toMatchObject({
      code: 'PROJECT_CONFIG_CHANGED',
    });
  });

  it('binds ownership consent to the exact target origin and rejects an origin change', async () => {
    const { controller, project } = setup();

    expect(project).toMatchObject({ targetOrigin: 'http://127.0.0.1:39981' });
    controller.config.targetOrigin = 'http://127.0.0.1:49981';

    await expect(controller.inspectAdapter(project.id)).rejects.toMatchObject({
      code: 'PROJECT_CONFIG_CHANGED',
    });
    await expect(controller.preflight(project.id, 'local_replay')).rejects.toMatchObject({
      code: 'PROJECT_CONFIG_CHANGED',
    });
  });

  it('binds processing consent to the exact configured model', async () => {
    const { controller, project } = setup();

    expect(project).toMatchObject({ modelConsentModel: 'synthetic' });
    controller.config.model = 'different-processor';

    await expect(controller.inspectAdapter(project.id)).rejects.toMatchObject({
      code: 'PROJECT_CONFIG_CHANGED',
    });
    await expect(controller.preflight(project.id, 'local_replay')).rejects.toMatchObject({
      code: 'PROJECT_CONFIG_CHANGED',
    });
  });

  it('blocks new repair and evidence-review model work after consented model drift', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-turn',
      lastSequenceNumber: 1,
      status: 'done',
    });
    controller.runs.finishRun({ runId: run.id, verdicts: ['pass'] });
    controller.config.model = 'different-processor';

    await expect(controller.startRepair(run.id, {})).rejects.toMatchObject({
      code: 'MODEL_CONSENT_CHANGED',
    });
    await expect(controller.startEvidenceReview(run.id, {})).rejects.toMatchObject({
      code: 'MODEL_CONSENT_CHANGED',
    });
    expect(controller.repairs.jobs(run.id)).toEqual([]);
    expect(controller.reviews.view(run.id)).toBeNull();
  });

  it('reads a legacy project without an origin but requires a fresh connection before use', async () => {
    const { controller } = setup();
    controller.put('project', 'legacy-project', {
      id: 'legacy-project',
      name: 'Legacy project',
      repository: 'synthetic/repository',
      ref: 'a'.repeat(40),
      targetId: 'reference',
      ownershipConfirmed: true,
      modelConsent: true,
    });

    expect(controller.project('legacy-project')).toMatchObject({
      targetOrigin: null,
      modelConsentModel: null,
    });
    expect(controller.projects()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'legacy-project',
          targetOrigin: null,
          modelConsentModel: null,
        }),
      ]),
    );
    await expect(controller.inspectAdapter('legacy-project')).rejects.toMatchObject({
      code: 'PROJECT_CONFIG_CHANGED',
    });
  });

  it('does not re-arm a runtime after restart when the consented target origin changed', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-turn',
      lastSequenceNumber: 0,
      status: 'running',
    });
    controller.config.targetOrigin = 'http://127.0.0.1:49981';
    const resume = vi.spyOn(controller.runtime, 'resumeStream');

    await controller.recover();

    expect(resume).not.toHaveBeenCalled();
    expect(controller.viewRun(run.id)).toMatchObject({
      runtime: { status: 'error', error: 'PROJECT_CONFIG_CHANGED' },
      runtimeError: {
        code: 'RUNTIME_RECOVERY_BINDING_BLOCKED',
        message: 'PROJECT_CONFIG_CHANGED',
      },
    });
    expect(controller.list('mcp-token')).toEqual([]);
    const cleanupRequest = {
      runId: run.id,
      operationId: 'cleanup_after_binding_restore',
    };
    await expect(controller.tool(run.id, 'cleanup_run', cleanupRequest)).rejects.toMatchObject({
      code: 'CLEANUP_BINDING_CHANGED',
    });
    controller.config.targetOrigin = 'http://127.0.0.1:39981';
    await expect(controller.tool(run.id, 'cleanup_run', cleanupRequest)).resolves.toMatchObject({
      operation: 'cleanup',
    });
  });

  it('keeps a legacy run readable and cleanable without resuming its runtime', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    const { featureProbeHash: _probeHash, ...legacyRun } = controller.runs.getRun(run.id);
    void _probeHash;
    controller.database
      .prepare('UPDATE runs SET record=? WHERE id=?')
      .run(JSON.stringify(legacyRun), run.id);
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-turn',
      lastSequenceNumber: 0,
      status: 'running',
    });
    const resume = vi.spyOn(controller.runtime, 'resumeStream');

    await controller.recover();

    expect(controller.runs.getRun(run.id).featureProbeHash).toBeUndefined();
    expect(resume).not.toHaveBeenCalled();
    expect(controller.viewRun(run.id)).toMatchObject({
      runtime: { status: 'error', error: 'FEATURE_PROBE_BINDING_REQUIRED' },
      runtimeError: {
        code: 'RUNTIME_RECOVERY_BINDING_BLOCKED',
        message: 'FEATURE_PROBE_BINDING_REQUIRED',
      },
    });
    expect(controller.list('mcp-token')).toEqual([]);
    await expect(controller.cleanup(run.id)).resolves.toMatchObject({ operation: 'cleanup' });
  });

  it('blocks check_connections when the current Doctor receipt drifts from the run binding', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    const baseline = compatibleDoctorReport();
    if (baseline.verdict !== 'compatible' || baseline.schemaVersion !== 2)
      throw new Error('Expected compatible bound fixture');
    const changedFeature = { ...feature, browserPath: '/admin' };
    const changedProbe = bindTargetFeatureProbe(changedFeature);
    vi.spyOn(controller.adapterDoctor, 'inspect').mockResolvedValue(
      adapterDoctorReportSchema.parse({
        ...baseline,
        receipt: {
          description: { ...baseline.receipt.description, feature: changedFeature },
          featureConfigHash: hashValue(changedFeature),
          featureProbe: changedProbe.contract,
          featureProbeHash: changedProbe.hash,
        },
      }),
    );

    const result = await controller.tool(run.id, 'check_connections', {
      runId: run.id,
      operationId: 'drifted_preflight',
    });

    expect(result).toMatchObject({
      ready: false,
      connections: expect.arrayContaining([
        expect.objectContaining({ name: 'Run binding', status: 'blocked' }),
      ]),
    });
    expect(controller.context(run.id).fixturesReady).toBe(false);
  });

  it('revalidates the target binding before the first mutation after worker startup', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    const baseline = compatibleDoctorReport();
    if (baseline.verdict !== 'compatible' || baseline.schemaVersion !== 2)
      throw new Error('Expected compatible bound fixture');
    const changedFeature = { ...feature, browserPath: '/admin' };
    const changedProbe = bindTargetFeatureProbe(changedFeature);
    vi.mocked(controller.adapterDoctor.inspect).mockResolvedValue(
      adapterDoctorReportSchema.parse({
        ...baseline,
        receipt: {
          description: { ...baseline.receipt.description, feature: changedFeature },
          featureConfigHash: hashValue(changedFeature),
          featureProbe: changedProbe.contract,
          featureProbeHash: changedProbe.hash,
        },
      }),
    );
    const create = vi.spyOn(controller.target, 'createUser').mockImplementation(async (input) => ({
      principalId: `principal-${input.fixtureMarker}`,
      runId: input.runId,
      fixtureMarker: input.fixtureMarker,
    }));

    await expect(
      controller.tool(run.id, 'prepare_fixture', {
        runId: run.id,
        operationId: 'first_mutation_after_restart',
      }),
    ).rejects.toMatchObject({ code: 'RUN_BINDING_CHANGED' });
    expect(create).not.toHaveBeenCalled();
    expect(controller.context(run.id).free).toBeNull();
  });

  it('blocks check_connections when the server configuration drifts from the approved run', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.config.priceId = 'price_changed_after_approval';

    const result = await controller.tool(run.id, 'check_connections', {
      runId: run.id,
      operationId: 'configuration_drift_preflight',
    });

    expect(result).toMatchObject({
      ready: false,
      connections: expect.arrayContaining([
        expect.objectContaining({ name: 'Run binding', status: 'blocked' }),
      ]),
    });
    expect(controller.context(run.id).fixturesReady).toBe(false);
  });

  it('does not persist or follow up on a hostile fixture identity receipt', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    const create = vi.spyOn(controller.target, 'createUser').mockImplementation(async (input) => ({
      principalId: 'victim',
      runId: 'another-run',
      fixtureMarker: input.fixtureMarker,
    }));
    const link = vi.spyOn(controller.target, 'linkCustomer');

    await expect(
      controller.tool(run.id, 'prepare_fixture', {
        runId: run.id,
        operationId: 'hostile_fixture',
      }),
    ).rejects.toMatchObject({ code: 'FIXTURE_IDENTITY_MISMATCH' });

    expect(create).toHaveBeenCalledTimes(1);
    expect(link).not.toHaveBeenCalled();
    expect(controller.context(run.id).free).toBeNull();
  });
});
function setup(http = false, overrides: Partial<ControllerConfig> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-startup-'));
  const config = {
    databasePath: join(directory, 'control.sqlite'),
    artifactDirectory: join(directory, 'artifacts'),
    targetId: 'reference',
    targetOrigin: 'http://127.0.0.1:39981',
    workerOrigin: 'http://127.0.0.1:39982',
    webOrigin: 'http://127.0.0.1:39983',
    adapterToken: 'synthetic-adapter',
    operatorToken: 'synthetic-operator',
    replaySecret: 'synthetic-replay',
    repository: 'synthetic/repository',
    defaultRef: 'a'.repeat(40),
    reviewSkillRepository: 'VasuBansal7576/PaywallProof',
    reviewSkillRef: 'b'.repeat(40),
    priceId: 'price_synthetic',
    runtimeUrl: 'http://127.0.0.1:39984',
    model: 'synthetic',
    repairProfile: 'reference_v1' as const,
  };
  const configured: ControllerConfig = { ...config, ...overrides };
  const service = http ? createControlApp(configured) : null;
  const controller = service?.controller ?? new Controller(configured);
  opened.push({ controller, directory });
  vi.spyOn(controller.target, 'describe').mockResolvedValue({
    adapterVersion: '1',
    environment: 'test',
    buildId: 'a'.repeat(40),
    billingTimeModel: 'provider_status',
    feature: { ...feature, denialStatuses: [403] },
  });
  vi.spyOn(controller.adapterDoctor, 'inspect').mockResolvedValue(compatibleDoctorReport());
  vi.spyOn(controller.runtime, 'checkConnection').mockResolvedValue({
    model: 'synthetic',
    local: true,
  });
  const cancel = vi.spyOn(controller.runtime, 'cancel').mockResolvedValue({});
  const project = controller.createProject({
    name: 'Startup failure checks',
    repository: 'synthetic/repository',
    ref: 'a'.repeat(40),
    targetId: 'reference',
    targetOrigin: 'http://127.0.0.1:39981',
    modelConsentModel: 'synthetic',
    ownershipConfirmed: true,
    modelConsent: true,
  });
  async function start(mode: 'local_replay' | 'polar_sandbox' = 'local_replay') {
    const policy = await controller.proposePolicy(project.id, {
      schemaVersion: 2,
      priceId: configured.priceId,
      featureId: 'pro_export',
      featureConfigHash: hashValue(feature),
      cancellation: 'allow_until_period_end',
      requireInitialPaymentConfirmed: true,
      syncWindowSeconds: 5,
      predicateVersion: 'reference-export-v1',
    });
    return controller.createRun({
      projectId: project.id,
      policyHash: policy.hash,
      mode,
    });
  }
  return { controller, start, cancel, app: service?.app, directory, project };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const { controller, directory } of opened.splice(0)) {
    controller.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
describe('durable plan-decision recovery', () => {
  it('keeps advanced and terminal runtime cursors unchanged on semantic decision retries', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime-continuation', run.id, {
      status: 'confirmed',
      sessionId: 'synthetic-session',
      previousTurnId: 'synthetic-plan-turn',
      turnId: 'synthetic-plan-confirmed-turn',
      decision: 'allow',
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-later-turn',
      lastSequenceNumber: 11,
      status: 'running',
    });
    const resume = vi
      .spyOn(controller.runtime, 'resumeStream')
      .mockImplementation(() => new Promise(() => {}));
    const continueApproval = vi.spyOn(controller.runtime, 'continueApproval');
    const findContinuation = vi.spyOn(controller.runtime, 'findContinuation');
    const retry = {
      decision: 'allow' as const,
      bindingHash: run.approval.bindingHash,
    };
    const advancedRuntime = controller.get('runtime', run.id);

    await expect(controller.decidePlan(run.id, run.approval.id, retry)).resolves.toMatchObject({
      status: 'running',
    });
    expect(controller.get('runtime', run.id)).toEqual(advancedRuntime);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());

    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-terminal-turn',
      lastSequenceNumber: 29,
      status: 'done',
    });
    controller.runs.finishRun({ runId: run.id, verdicts: ['pass'] });
    const terminalRuntime = controller.get('runtime', run.id);

    await expect(controller.decidePlan(run.id, run.approval.id, retry)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(controller.get('runtime', run.id)).toEqual(terminalRuntime);
    expect(continueApproval).not.toHaveBeenCalled();
    expect(findContinuation).not.toHaveBeenCalled();
  });

  it('reconciles an in-flight approval continuation without resuming it after cancellation', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-plan',
      lastSequenceNumber: 0,
      status: 'approval',
    });
    vi.spyOn(controller.runtime, 'inspectApprovals').mockResolvedValue([planApproval(run.id)]);
    let finishContinuation: ((turn: RuntimeTurn) => void) | undefined;
    const dispatch = vi.spyOn(controller.runtime, 'continueApproval').mockImplementation(
      () =>
        new Promise<RuntimeTurn>((resolve) => {
          finishContinuation = resolve;
        }),
    );
    const resume = vi
      .spyOn(controller.runtime, 'resumeStream')
      .mockImplementation(() => new Promise(() => {}));

    const decision = controller.decidePlan(run.id, run.approval.id, {
      decision: 'allow',
      bindingHash: run.approval.bindingHash,
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());

    await controller.cancel(run.id);
    expect(controller.runs.getRun(run.id).status).toBe('stopping');
    finishContinuation?.(syntheticTurn('synthetic-plan-decision', 'synthetic-plan'));
    await decision;

    await expect.poll(() => controller.runs.getRun(run.id).status).toBe('canceled');
    expect(controller.get('runtime-continuation', run.id)).toMatchObject({
      status: 'confirmed',
      decision: 'allow',
      turnId: 'synthetic-plan-decision',
    });
    expect(controller.get('runtime', run.id)).toMatchObject({
      turnId: 'synthetic-plan-decision',
      status: 'error',
      error: 'RUN_STOPPED_AFTER_CONTINUATION',
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it.each(['allow', 'deny'] as const)(
    'recovers an owner %s decision after the run transition commits but before dispatch',
    async (decision) => {
      const { controller, start } = setup();
      vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
        () => new Promise(() => {}),
      );
      const run = await start();
      controller.put('runtime', run.id, {
        sessionId: 'synthetic-session',
        turnId: 'synthetic-plan',
        lastSequenceNumber: 0,
        status: 'approval',
      });
      vi.spyOn(controller.runtime, 'inspectApprovals').mockResolvedValue([planApproval(run.id)]);
      const dispatch = vi
        .spyOn(controller.runtime, 'continueApproval')
        .mockResolvedValue(syntheticTurn('synthetic-plan-decision', 'synthetic-plan'));
      vi.spyOn(controller.runtime, 'resumeStream').mockImplementation(() => new Promise(() => {}));
      const decide = controller.runs.decidePlan.bind(controller.runs);
      const interrupted = vi
        .spyOn(controller.runs, 'decidePlan')
        .mockImplementationOnce((input) => {
          decide(input);
          throw new Error('synthetic crash after durable run transition');
        });
      const request = { decision, bindingHash: run.approval.bindingHash };

      await expect(controller.decidePlan(run.id, run.approval.id, request)).rejects.toThrow(
        'synthetic crash',
      );
      expect(controller.get('runtime-continuation', run.id)).toMatchObject({
        status: 'prepared',
        decision,
        approvalId: run.approval.id,
        bindingHash: run.approval.bindingHash,
      });
      expect(dispatch).not.toHaveBeenCalled();
      interrupted.mockRestore();

      await controller.recover();

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(controller.get('runtime-continuation', run.id)).toMatchObject({
        status: 'confirmed',
        decision,
        turnId: 'synthetic-plan-decision',
      });
      expect(controller.runs.getRun(run.id).approval.decision).toBe(decision);
      if (decision === 'deny') expect(controller.list('mcp-token')).toEqual([]);
    },
  );
});
describe('operator cleanup recovery', () => {
  it('keeps a pre-cleanup-hash run cleanable under its original configuration binding', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.runs.finishRun({ runId: run.id, verdicts: ['inconclusive'] });
    const { cleanupConfigHash: _cleanupConfigHash, ...legacyRun } = controller.runs.getRun(run.id);
    void _cleanupConfigHash;
    controller.database.prepare('UPDATE runs SET record=? WHERE id=?').run(
      JSON.stringify({
        ...legacyRun,
        projectConfigHash: hashValue({
          targetOrigin: 'http://127.0.0.1:39981',
          repository: 'synthetic/repository',
          ref: 'a'.repeat(40),
          priceId: 'price_synthetic',
          polarOrganizationId: null,
          polarProductId: null,
          model: 'synthetic',
          runtimeUrl: 'http://127.0.0.1:39984',
        }),
      }),
      run.id,
    );

    await expect(controller.cleanup(run.id)).resolves.toMatchObject({
      operation: 'cleanup',
      resources: [],
    });
  });

  it('does not redispatch an uncertain target deletion from the terminal retry route', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T18:00:00.000Z'));
    const { controller, start, app } = setup(true);
    if (!app) throw new Error('HTTP fixture missing');
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('context', run.id, {
      ...controller.context(run.id),
      free: {
        principalId: 'synthetic-free',
        runId: run.id,
        fixtureMarker: 'synthetic-marker',
      },
    });
    const cleanup = vi.spyOn(controller.target, 'cleanup').mockImplementationOnce(async (input) => {
      input.beforeDispatch?.();
      throw new Error('synthetic response lost after dispatch');
    });

    await controller.cleanup(run.id);
    expect(controller.context(run.id).cleanup).toEqual([
      {
        resourceId: 'synthetic-free',
        status: 'leftover',
        code: 'CLEANUP_OUTCOME_UNKNOWN',
      },
    ]);
    controller.runs.finishRun({ runId: run.id, verdicts: ['pass'] });
    vi.advanceTimersByTime(130_000);
    const response = await app.request(`http://127.0.0.1:39982/api/runs/${run.id}/cleanup`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer synthetic-operator',
        'Content-Type': 'application/json',
        'X-Request-Id': 'terminal-cleanup-retry',
      },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(controller.get('cleanup-start', run.id)).toEqual({ at: Date.now() });
    expect(controller.context(run.id).cleanup).toEqual([
      {
        resourceId: 'synthetic-free',
        status: 'leftover',
        code: 'CLEANUP_OUTCOME_UNKNOWN',
      },
    ]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('retries a target deletion that failed before the transport dispatch hook', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('context', run.id, {
      ...controller.context(run.id),
      free: {
        principalId: 'synthetic-free',
        runId: run.id,
        fixtureMarker: 'synthetic-marker',
      },
    });
    const cleanup = vi
      .spyOn(controller.target, 'cleanup')
      .mockRejectedValueOnce(new Error('synthetic DNS failure'))
      .mockImplementationOnce(async (input) => {
        input.beforeDispatch?.();
        return { removed: true, principalId: input.principalId, runId: input.runId };
      });

    await controller.cleanup(run.id);
    expect(controller.context(run.id).cleanup).toEqual([
      {
        resourceId: 'synthetic-free',
        status: 'leftover',
        code: 'CLEANUP_PRE_DISPATCH_FAILED',
      },
    ]);
    expect(
      controller.get('cleanup-intent', hashValue({ runId: run.id, resourceId: 'synthetic-free' })),
    ).toMatchObject({
      state: 'prepared',
    });

    await controller.cleanup(run.id);

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(controller.context(run.id).cleanup).toEqual([
      { resourceId: 'synthetic-free', status: 'deleted' },
    ]);
  });

  it('replaces a Polar leftover with the provider retention receipt', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000011';
    const productId = '00000000-0000-4000-8000-000000000012';
    const priceId = '00000000-0000-4000-8000-000000000013';
    const { controller, start } = setup(false, {
      polarToken: 'polar_oat_synthetic',
      polarOrganizationId: organizationId,
      polarProductId: productId,
      priceId,
      testCustomerEmail: 'owned-sandbox@example.test',
    });
    if (!controller.polar) throw new Error('Missing Polar fixture');
    const preflight = {
      provider: 'polar',
      mode: 'polar_sandbox',
      organizationId,
      productId,
      priceId,
      amount: 100,
      currency: 'usd',
      apiVersion: '2026-04',
      scope: 'read_only_preflight',
      lifecycleVerified: false,
    } as const;
    vi.spyOn(controller.polar, 'preflight').mockResolvedValue(preflight);
    vi.spyOn(controller.polar, 'ensurePreflight').mockResolvedValue(preflight);
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start('polar_sandbox');
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    const resourceId = '00000000-0000-4000-8000-000000000014';
    controller.put('context', run.id, {
      ...controller.context(run.id),
      cleanup: [{ resourceId, status: 'leftover', code: 'POLAR_CHECKOUT_STILL_OPEN' }],
    });
    controller.runs.finishRun({ runId: run.id, verdicts: ['pass'] });
    vi.spyOn(controller.polar, 'listOwned').mockReturnValue([
      { id: resourceId, kind: 'checkout', runId: run.id },
    ]);
    vi.spyOn(controller.polar, 'cleanup').mockResolvedValue([
      { resourceId, status: 'retained', code: 'POLAR_UNPAID_AUDIT_RETAINED' },
    ]);

    await controller.retryCleanup(run.id);

    expect(controller.context(run.id).cleanup).toEqual([
      { resourceId, status: 'retained', code: 'POLAR_UNPAID_AUDIT_RETAINED' },
    ]);
  });
});
describe('repair capability boundary', () => {
  it('reports repair as unsupported when the target environment is not trusted', async () => {
    const repairProfile = repairProfileFromEnvironment({
      TARGET_ID: 'another-target',
      REPAIR_PROFILE: 'reference_v1',
    });
    const { controller, start } = setup(false, { repairProfile });
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );

    const run = await start();

    expect(controller.viewRun(run.id).repairSupported).toBe(false);
  });

  it('keeps an external-target run repair-disabled after restart under the reference profile', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pp-repair-restart-'));
    const common = {
      databasePath: join(directory, 'control.sqlite'),
      artifactDirectory: join(directory, 'artifacts'),
      workerOrigin: 'http://127.0.0.1:39982',
      webOrigin: 'http://127.0.0.1:39983',
      adapterToken: 'synthetic-adapter',
      operatorToken: 'synthetic-operator',
      replaySecret: 'synthetic-replay',
      repository: 'synthetic/repository',
      defaultRef: 'a'.repeat(40),
      reviewSkillRepository: 'VasuBansal7576/PaywallProof',
      reviewSkillRef: 'b'.repeat(40),
      priceId: 'price_synthetic',
      runtimeUrl: 'http://127.0.0.1:39984',
      model: 'synthetic',
    } as const;
    const external = new Controller({
      ...common,
      targetId: 'owned-secondary-stage',
      targetOrigin: 'http://127.0.0.1:40981',
      repairProfile: 'disabled',
    });
    const project = external.createProject({
      name: 'Owned secondary stage',
      repository: common.repository,
      ref: common.defaultRef,
      targetId: 'owned-secondary-stage',
      targetOrigin: 'http://127.0.0.1:40981',
      modelConsentModel: common.model,
      ownershipConfirmed: true,
      modelConsent: true,
    });
    const policy = createPolicy({
      schemaVersion: 2,
      priceId: common.priceId,
      featureId: feature.id,
      featureConfigHash: hashValue(feature),
      cancellation: 'allow_until_period_end',
      requireInitialPaymentConfirmed: true,
      syncWindowSeconds: 5,
      predicateVersion: 'reference-export-v1',
    });
    const run = external.runs.createRun({
      projectId: project.id,
      policy,
      targetBuild: common.defaultRef,
      featureConfigHash: hashValue(feature),
      featureProbeHash: bindTargetFeatureProbe(feature).hash,
      targetFeature: feature,
      mode: 'local_replay',
    });
    external.put('run-index', run.id, { id: run.id });
    external.put('context', run.id, {
      free: null,
      paid: null,
      customerId: null,
      fixturesReady: false,
      checkoutStarted: false,
      subscriptionCreated: false,
      scheduled: false,
      advanced: false,
      completedScenarios: [],
      cleanup: [],
    });
    external.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-turn',
      lastSequenceNumber: 0,
      status: 'done',
    });
    external.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    external.runs.finishRun({ runId: run.id, verdicts: ['fail'] });
    external.close();

    const controller = new Controller({
      ...common,
      targetId: 'reference',
      targetOrigin: 'http://127.0.0.1:39981',
      repairProfile: 'reference_v1',
    });
    opened.push({ controller, directory });
    const fixture = verifiedRepairFixture(controller, run.id);
    controller.put('mcp-token', 'synthetic-external-run-token', { runId: run.id });
    controller.put('repair-publication-intent', fixture.jobId, {
      previousTurnId: 'synthetic-before',
      approvalId: 'synthetic-publication-approval',
      at: Date.now(),
    });
    const continueTurn = vi.spyOn(TrueForgeAdapter.prototype, 'continueTurn');
    const continuation = vi.spyOn(TrueForgeAdapter.prototype, 'findContinuation');
    vi.spyOn(TrueForgeAdapter.prototype, 'cancel').mockResolvedValue({});

    await expect(controller.startRepair(run.id, {})).rejects.toMatchObject({
      code: 'REPAIR_TARGET_UNSUPPORTED',
    });
    await expect(
      controller.repairs.requestPublication(run.id, fixture.jobId),
    ).rejects.toMatchObject({ code: 'REPAIR_TARGET_UNSUPPORTED' });
    await expect(
      controller.repairs.publishFromTool(run.id, fixture.proposalId),
    ).rejects.toMatchObject({ code: 'REPAIR_TARGET_UNSUPPORTED' });
    await controller.repairs.recover();

    expect(controller.viewRun(run.id)).toMatchObject({
      repairSupported: false,
      coverageLimitCodes: expect.arrayContaining(['AUTOMATED_REPAIR_REFERENCE_TARGET_ONLY']),
    });
    expect(controller.get('repair-publication-runtime', fixture.jobId)).toMatchObject({
      status: 'error',
      error: 'REPAIR_PUBLICATION_CONSENT_CHANGED',
    });
    expect(controller.list('mcp-token')).toHaveLength(1);
    await controller.recover();
    expect(controller.list('mcp-token')).toEqual([]);
    expect(continueTurn).not.toHaveBeenCalled();
    expect(continuation).not.toHaveBeenCalled();
  });
});
describe('runtime startup failure recovery', () => {
  it('rejects repair work for an unsupported target before reading source or capacity', async () => {
    const { directory } = setup();
    const source = vi.fn();
    capacityMocks.statfs.mockClear();
    const coordinator = new RepairCoordinator({
      repositoryRoot: directory,
      repository: 'synthetic/repository',
      databasePath: join(directory, 'unsupported-repair.sqlite'),
      artifactDirectory: directory,
      runtimeUrl: 'http://127.0.0.1:39984',
      model: 'synthetic',
      webOrigin: 'http://127.0.0.1:39983',
      documents: { put: vi.fn(), get: () => null, list: () => [] },
      source,
      repairSupported: false,
    });
    try {
      await expect(coordinator.start(randomUUID(), {})).rejects.toMatchObject({
        code: 'REPAIR_TARGET_UNSUPPORTED',
      });
      expect(source).not.toHaveBeenCalled();
      expect(capacityMocks.statfs).not.toHaveBeenCalled();
      await expect(
        coordinator.requestPublication(randomUUID(), randomUUID()),
      ).rejects.toMatchObject({ code: 'REPAIR_TARGET_UNSUPPORTED' });
      await expect(
        coordinator.decidePublication(randomUUID(), randomUUID(), randomUUID(), {
          decision: 'allow',
          bindingHash: 'a'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'REPAIR_TARGET_UNSUPPORTED' });
      await expect(coordinator.publishFromTool(randomUUID(), randomUUID())).rejects.toMatchObject({
        code: 'REPAIR_TARGET_UNSUPPORTED',
      });
    } finally {
      coordinator.close();
    }
  });

  it('rejects insufficient repair capacity without consuming an attempt or invoking a model', async () => {
    const { directory } = setup();
    const put = vi.fn(),
      inspect = vi.spyOn(TrueForgeAdapter.prototype, 'inspectTurn');
    const disk = capacityMocks.statfs.mockRejectedValue(new Error('synthetic unavailable volume'));
    const policy = createPolicy({
      schemaVersion: 2,
      priceId: 'price_synthetic',
      featureId: 'pro_export',
      featureConfigHash: hashValue(feature),
      cancellation: 'allow_until_period_end',
      requireInitialPaymentConfirmed: true,
      syncWindowSeconds: 5,
      predicateVersion: 'reference-export-v1',
    });
    const source: RepairSource = {
      runId: randomUUID(),
      baseCommit: 'a'.repeat(40),
      policy,
      oracleHash: 'b'.repeat(64),
      observations: [],
      runtime: { sessionId: 'synthetic-session', turnId: 'synthetic-turn' },
      scenarios: [
        {
          id: 'SC04',
          observationIds: [],
          api: { verdict: 'fail', code: 'SYNTHETIC_FAILURE' },
          browser: { verdict: 'pass', code: 'SYNTHETIC' },
          state: { verdict: 'pass', code: 'SYNTHETIC' },
        },
      ],
    };
    const coordinator = new RepairCoordinator({
      repositoryRoot: directory,
      repository: 'synthetic/repository',
      databasePath: join(directory, 'capacity.sqlite'),
      artifactDirectory: directory,
      runtimeUrl: 'http://127.0.0.1:39984',
      model: 'synthetic',
      webOrigin: 'http://127.0.0.1:39983',
      documents: { put, get: () => null, list: () => [] },
      source: async () => source,
      repairSupported: true,
    });
    try {
      await expect(coordinator.start(source.runId, {})).rejects.toMatchObject({
        code: 'REPAIR_DISK_CAPACITY_UNKNOWN',
      });
      disk.mockResolvedValue({
        type: 1n,
        bsize: 4096n,
        blocks: 1n,
        bfree: 1n,
        bavail: 0n,
        files: 1n,
        ffree: 1n,
      });
      for (let attempt = 0; attempt < 3; attempt++)
        await expect(coordinator.start(source.runId, {})).rejects.toMatchObject({
          code: 'REPAIR_DISK_CAPACITY_INSUFFICIENT',
        });
      expect(put).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
      expect(coordinator.jobs(source.runId)).toEqual([]);
    } finally {
      coordinator.close();
    }
  });
  it('measures a missing artifact destination before reaching the next repair gate', async () => {
    const { directory } = setup(),
      ancestor = realpathSync(directory),
      put = vi.fn();
    const inspect = vi.spyOn(TrueForgeAdapter.prototype, 'inspectTurn');
    capacityMocks.statfs.mockReset().mockResolvedValue({ bavail: 16n * 1024n ** 3n, bsize: 1n });
    const policy = createPolicy({
      schemaVersion: 2,
      priceId: 'price_synthetic',
      featureId: 'pro_export',
      featureConfigHash: hashValue(feature),
      cancellation: 'allow_until_period_end',
      requireInitialPaymentConfirmed: true,
      syncWindowSeconds: 5,
      predicateVersion: 'reference-export-v1',
    });
    const source: RepairSource = {
      runId: randomUUID(),
      baseCommit: 'a'.repeat(40),
      policy,
      oracleHash: 'b'.repeat(64),
      observations: [],
      runtime: { sessionId: 'synthetic-session', turnId: 'synthetic-turn' },
      scenarios: [
        {
          id: 'SC04',
          observationIds: [],
          api: { verdict: 'fail', code: 'SYNTHETIC_FAILURE' },
          browser: { verdict: 'pass', code: 'SYNTHETIC' },
          state: { verdict: 'pass', code: 'SYNTHETIC' },
        },
      ],
    };
    const coordinator = new RepairCoordinator({
      repositoryRoot: process.cwd(),
      repository: 'synthetic/repository',
      databasePath: join(directory, 'capacity.sqlite'),
      artifactDirectory: join(ancestor, 'missing', 'artifacts'),
      runtimeUrl: 'http://127.0.0.1:39984',
      model: 'synthetic',
      webOrigin: 'http://127.0.0.1:39983',
      documents: { put, get: () => null, list: () => [] },
      source: async () => source,
      repairSupported: true,
    });
    try {
      await expect(coordinator.start(source.runId, {})).rejects.toMatchObject({
        code: 'REPAIR_ORACLE_CHANGED',
      });
      expect(capacityMocks.statfs).toHaveBeenNthCalledWith(2, ancestor, { bigint: true });
      expect(put).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
    } finally {
      coordinator.close();
    }
  });
  it.each([undefined, '7', '30', '60'])('parses an operator retention setting: %s', (value) => {
    expect(artifactRetentionFromDays(value)).toBe(Number(value ?? 7) * 86400000);
  });
  it.each([
    '',
    '0',
    '-1',
    '0.5',
    '60.1',
    ' 60',
    '60 ',
    '60days',
    'Infinity',
    '9007199254740991',
    null,
    [],
    60,
  ])('rejects an invalid retention setting: %s', (value) => {
    expect(() => artifactRetentionFromDays(value)).toThrow(
      'The artifact service configuration is invalid.',
    );
  });
  it.each([
    { readDelay: 1000, verdict: 'pass' },
    { readDelay: 15000, verdict: 'inconclusive' },
  ])(
    'keeps truthful completion timestamps after cold browser startup: $verdict',
    async ({ readDelay, verdict }) => {
      const { controller } = setup();
      const started = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(started);
      const policy = createPolicy({
        schemaVersion: 2,
        priceId: 'price_synthetic',
        featureId: 'pro_export',
        featureConfigHash: hashValue(feature),
        cancellation: 'allow_until_period_end',
        requireInitialPaymentConfirmed: true,
        syncWindowSeconds: 5,
        predicateVersion: 'reference-export-v1',
      });
      const denial = {
        status: 403,
        body: { error: 'ACCESS_DENIED' },
        transportError: false,
        denialStatuses: [403] satisfies 403[],
      };
      vi.spyOn(controller.target, 'session').mockResolvedValue({
        cookie: 'pp_session=synthetic',
        expiresAt: new Date(started + 100000).toISOString(),
      });
      vi.spyOn(controller.browser, 'probe').mockImplementation(async () => {
        vi.setSystemTime(started + 12000);
        return {
          probe: denial,
          artifact: {
            id: 'synthetic-timing-fixture.png',
            sha256: 'a'.repeat(64),
            contentType: 'image/png',
            source: 'browser',
            collectedAt: new Date().toISOString(),
          },
        };
      });
      vi.spyOn(controller.target, 'snapshot').mockResolvedValue({
        principalId: 'synthetic-free',
        runId: 'synthetic-probe-run',
        customerId: null,
        status: 'none',
        buildId: 'a'.repeat(40),
      });
      vi.spyOn(controller.target, 'probe').mockResolvedValue(denial);
      const result = await observeFeature({
        store: controller.evidence,
        target: controller.target,
        browser: controller.browser,
        runId: 'synthetic-probe-run',
        scenarioId: 'SC01',
        subjectId: 'synthetic-free',
        fixtureMarker: 'synthetic-private-marker',
        policy,
        targetBuild: 'a'.repeat(40),
        featureProbeHash: bindTargetFeatureProbe(feature).hash,
        mode: 'local_replay',
        notBefore: started,
        billing: async () => {
          vi.setSystemTime(started + 12000 + readDelay);
          return {
            livemode: false,
            identityResolved: true,
            noSubscriptionConfirmed: true,
            customerId: null,
            subscription: null,
          };
        },
      });
      expect(result.api.verdict).toBe(verdict);
      const records = controller.evidence.list('synthetic-probe-run');
      expect(records.find((item) => item.source === 'browser')?.observedAt).toBe(started + 12000);
      expect(records.find((item) => item.source === 'billing_provider')?.observedAt).toBe(
        started + 12000 + readDelay,
      );
      if (readDelay > 10000) expect(result.api.code).toBe('EVIDENCE_STALE');
    },
  );
  it('revokes the MCP capability if cancellation wins during registration', async () => {
    const { controller, start } = setup();
    let release: () => void = () => {};
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        data: {
          name: 'synthetic',
          authStatus: { status: 'not_required' },
          manifest: {
            type: 'remote',
            name: 'synthetic',
            url: 'http://127.0.0.1:39984/mcp',
            description: 'Synthetic',
          },
        },
      };
    });
    const create = vi.spyOn(controller.runtime, 'createSession');
    const run = await start();
    await controller.cancel(run.id);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controller.runs.getRun(run.id).status).toBe('canceled');
    expect(controller.list('mcp-token')).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
  it('revokes locally and completes owned cleanup when TrueForge cancellation is unavailable', async () => {
    const { controller, start, cancel } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime', run.id, {
      sessionId: 'offline-runtime-session',
      turnId: 'offline-runtime-turn',
      lastSequenceNumber: 0,
      status: 'running',
    });
    cancel.mockRejectedValueOnce(new Error('synthetic runtime unavailable'));

    await controller.cancel(run.id);

    await expect.poll(() => controller.runs.getRun(run.id).status).toBe('canceled');
    expect(controller.list('mcp-token')).toEqual([]);
    await expect
      .poll(() => controller.viewRun(run.id).runtimeCancelError)
      .toMatchObject({
        message: 'synthetic runtime unavailable',
      });
    expect(controller.context(run.id).cleanup).toEqual([]);
  });
  it('keeps startup closed until a persisted stopping run finishes cleanup', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.runs.requestStop(run.id);
    let releaseCleanup: (() => void) | undefined;
    const cleanup = vi.spyOn(controller, 'cleanup').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCleanup = () =>
            resolve({ operation: 'cleanup', resources: controller.context(run.id).cleanup });
        }),
    );
    let recovered = false;

    const recovery = controller.recover().then(() => {
      recovered = true;
    });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());

    expect(recovered).toBe(false);
    expect(controller.list('mcp-token')).toEqual([]);
    expect(controller.runs.getRun(run.id).status).toBe('stopping');
    releaseCleanup?.();
    await recovery;
    expect(controller.runs.getRun(run.id).status).toBe('canceled');
  });
  it.each(['original', 'before', 'after'])(
    'serves only authenticated, run-scoped and hash-verified %s screenshot bytes',
    async (phase) => {
      const { controller, start, app, directory } = setup(true);
      if (!app) throw new Error('HTTP fixture missing');
      vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
        () => new Promise(() => {}),
      );
      const run = await start(),
        id = `${randomUUID()}.png`;
      // A synthetic PNG-signature fixture tests transport integrity, not browser evidence.
      const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
      const metadata = {
        id,
        runId: run.id,
        observationId: 'synthetic-observation',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentType: 'image/png',
        source: 'browser',
        collectedAt: new Date().toISOString(),
        ...(phase === 'original'
          ? {}
          : { repairRunId: randomUUID(), repairJobId: randomUUID(), phase }),
      };
      const path = join(directory, 'artifacts', id);
      writeFileSync(path, bytes);
      controller.put('artifact', id, metadata);
      const url = `http://127.0.0.1:39982/api/runs/${run.id}/artifacts/${id}`;
      const request = () =>
        app.request(url, { headers: { Authorization: 'Bearer synthetic-operator' } });
      expect((await app.request(url)).status).toBe(401);
      const response = await request();
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('content-length')).toBe(String(bytes.length));
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${id}"`);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(controller.viewRun(run.id).artifacts).toEqual([metadata]);
      for (const invalid of [
        { ...metadata, unknownField: 'rejected' },
        { ...metadata, repairRunId: randomUUID(), repairJobId: randomUUID(), phase: 'unverified' },
        { ...metadata, repairRunId: randomUUID(), repairJobId: null, phase: 'before' },
        { ...metadata, repairRunId: run.id, repairJobId: randomUUID(), phase: 'before' },
      ]) {
        controller.put('artifact', id, invalid);
        expect(await (await request()).json()).toMatchObject({
          error: { code: 'ARTIFACT_METADATA_INVALID' },
        });
      }
      controller.put('artifact', id, { ...metadata, runId: 'another-run' });
      expect((await request()).status).toBe(403);
      controller.put('artifact', id, metadata);
      writeFileSync(path, Buffer.from([...bytes, 4]));
      const corrupted = await request();
      expect(corrupted.status).toBe(422);
      expect(await corrupted.json()).toMatchObject({ error: { code: 'ARTIFACT_CORRUPT' } });
    },
  );
  it.each([
    { ageDays: 8, retentionDays: 60, explicitDays: undefined, status: 200 },
    { ageDays: 59, retentionDays: 60, explicitDays: undefined, status: 200 },
    { ageDays: 60, retentionDays: 60, explicitDays: undefined, status: 410 },
    { ageDays: 8, retentionDays: 60, explicitDays: 7, status: 410 },
    { ageDays: 8, retentionDays: undefined, explicitDays: undefined, status: 410 },
  ])(
    'enforces operator retention without overriding an earlier explicit expiry: $ageDays/$retentionDays/$explicitDays',
    async ({ ageDays, retentionDays, explicitDays, status }) => {
      const day = 86400000,
        now = Date.now();
      const { controller, start, app, directory } = setup(true, {
        artifactRetentionMs: retentionDays === undefined ? undefined : retentionDays * day,
      });
      if (!app) throw new Error('HTTP fixture missing');
      vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
        () => new Promise(() => {}),
      );
      const run = await start(),
        id = `${randomUUID()}.png`,
        collected = now - ageDays * day;
      const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
      writeFileSync(join(directory, 'artifacts', id), bytes);
      controller.put('artifact', id, {
        id,
        runId: run.id,
        observationId: 'synthetic-retention-observation',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentType: 'image/png',
        source: 'browser',
        collectedAt: new Date(collected).toISOString(),
        ...(explicitDays === undefined
          ? {}
          : { expiresAt: new Date(collected + explicitDays * day).toISOString() }),
      });
      const response = await app.request(
        `http://127.0.0.1:39982/api/runs/${run.id}/artifacts/${id}`,
        { headers: { Authorization: 'Bearer synthetic-operator' } },
      );
      expect(response.status).toBe(status);
      if (status === 200) expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      else expect(await response.json()).toMatchObject({ error: { code: 'ARTIFACT_EXPIRED' } });
    },
  );
  it('scopes model operation labels to their authorized run', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    for (let index = 0; index < 2; index++) {
      const run = await start();
      // This unit test supplies approval through the real public control store.
      controller.runs.decidePlan({
        runId: run.id,
        approvalId: run.approval.id,
        bindingHash: run.approval.bindingHash,
        decision: 'allow',
      });
      const cleanupRequest = { runId: run.id, operationId: 'op_1' };
      controller.config.model = 'new-model-without-new-cleanup-destination';
      controller.config.priceId = 'unused-by-local-cleanup';
      const receipt = await controller.tool(run.id, 'cleanup_run', cleanupRequest);
      expect(receipt).toMatchObject({ operation: 'cleanup' });
      expect(controller.viewRun(run.id).run.status).toBe('completed');
      await expect(controller.tool(run.id, 'cleanup_run', cleanupRequest)).resolves.toEqual(
        receipt,
      );
      await expect(
        controller.tool(run.id, 'probe_feature', {
          runId: run.id,
          operationId: 'op_1',
          scenarioId: 'SC01',
        }),
      ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
      controller.config.model = 'synthetic';
      controller.config.priceId = 'price_synthetic';
    }
  });
  it('terminates an unapprovable run and releases its project lock when registration fails', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockRejectedValue(
      new Error('synthetic registration failure'),
    );
    const first = await start();
    await expect
      .poll(() => controller.viewRun(first.id).run.status, { timeout: 500 })
      .toBe('canceled');
    expect(controller.viewRun(first.id).runtimeError).toMatchObject({
      code: 'RUNTIME_INITIALIZATION_FAILED',
    });
    expect((await start()).id).not.toBe(first.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  it('cancels a known session when beginning its first turn fails', async () => {
    const { controller, start, cancel } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockResolvedValue({
      data: {
        name: 'synthetic',
        authStatus: { status: 'not_required' },
        manifest: {
          type: 'remote',
          name: 'synthetic',
          url: 'http://127.0.0.1:39984/mcp',
          description: 'Synthetic test registration',
        },
      },
    });
    vi.spyOn(controller.runtime, 'createSession').mockResolvedValue({
      id: 'synthetic-session',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: 'synthetic',
      title: null,
      agent: { type: 'reference', id: 'synthetic-agent', name: null },
    });
    vi.spyOn(controller.runtime, 'beginTurn').mockRejectedValue(
      new Error('synthetic lost first-turn response'),
    );
    const run = await start();
    await expect
      .poll(() => controller.viewRun(run.id).run.status, { timeout: 500 })
      .toBe('canceled');
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'synthetic-session' });
  });
});

function verifiedRepairFixture(controller: Controller, existingRunId?: string) {
  const project = controller.projects()[0];
  if (!project) throw new Error('Missing project fixture');
  const featureConfigHash = hashValue(feature);
  const policy = createPolicy({
    schemaVersion: 2,
    priceId: 'price_synthetic',
    featureId: feature.id,
    featureConfigHash,
    cancellation: 'allow_until_period_end',
    requireInitialPaymentConfirmed: true,
    syncWindowSeconds: 5,
    predicateVersion: 'reference-export-v1',
  });
  const runId =
      existingRunId ??
      controller.runs.createRun({
        projectId: project.id,
        policy,
        targetBuild: 'a'.repeat(40),
        featureConfigHash,
        featureProbeHash: bindTargetFeatureProbe(feature).hash,
        targetFeature: feature,
        mode: 'local_replay',
      }).id,
    jobId = randomUUID(),
    findingId = 'SC04:api';
  const changes = [
    {
      path: 'src/reference/index.ts',
      content: '// Synthetic approval test input. Never executed.\n',
    },
  ];
  const proposal = controller.repairs.store.propose({
    runId,
    findingId,
    attempt: 1,
    baseCommit: 'a'.repeat(40),
    baseBranch: 'main',
    repository: 'synthetic/repository',
    branch: repairBranch(runId, findingId, 1),
    policyHash: 'b'.repeat(64),
    oracleHash: 'c'.repeat(64),
    allowedPaths: changes.map((change) => change.path),
    changes,
    diffHash: patchHash(changes),
    verificationMode: 'local_replay',
    failureCode: 'SYNTHETIC_FAILURE',
    summary: 'Synthetic approval fixture',
    reportUrl: 'http://127.0.0.1:39983/synthetic',
  });
  const receipt = (checkId: string, failed = false) => ({
    id: randomUUID(),
    executionId: 'synthetic-no-execution',
    checkId,
    oracleHash: 'c'.repeat(64),
    policyHash: 'b'.repeat(64),
    baseCommit: 'a'.repeat(40),
    diffHash: failed ? null : patchHash(changes),
    artifactHash: 'd'.repeat(64),
    observedAt: Date.now(),
    exitCode: failed ? 1 : 0,
    outcome: failed ? 'fail' : 'pass',
    failureCode: failed ? 'SYNTHETIC_FAILURE' : null,
  });
  controller.repairs.store.recordVerification({
    proposalId: proposal.id,
    before: receipt(findingId, true),
    after: receipt(findingId),
    regressions: ['SC01', 'SC02', 'SC03', 'SC04', ...SECURITY_CONTROLS].map((id) => receipt(id)),
  });
  const createdAt = Date.now();
  const job: RepairJob = {
    id: jobId,
    runId,
    findingId,
    attempt: 1,
    createdAt,
    deadline: createdAt + 900000,
    state: 'verified_local',
    sessionId: 'synthetic-session',
    turnId: 'synthetic-before',
    proposalId: proposal.id,
    error: null,
    runtimeOperations: [],
    checks: [],
  };
  controller.put(`repair-job:${runId}`, jobId, job);
  controller.put('repair-job-index', jobId, { runId, id: jobId });
  return { runId, jobId, proposalId: proposal.id };
}
function planApproval(runId: string): RuntimeApproval {
  return {
    threadId: 'synthetic-thread',
    toolCallId: 'synthetic-plan-call',
    sourceEventId: 'synthetic-plan-source',
    tool: {
      id: 'synthetic-plan-call',
      type: 'function',
      function: {
        name: 'prepare_fixture',
        arguments: JSON.stringify({ runId, operationId: 'step_prepare' }),
      },
      toolInfo: {
        type: 'mcp',
        name: 'prepare_fixture',
        serverId: `paywallproof_${runId.replaceAll('-', '')}`,
        serverName: 'synthetic',
      },
    },
  };
}
function syntheticTurn(
  id: string,
  previousTurnId: string | null = 'synthetic-before',
  approval = false,
): RuntimeTurn {
  return {
    id,
    previousTurnId,
    sessionId: 'synthetic-session',
    createdAt: new Date().toISOString(),
    state: {
      status: 'done',
      completedAt: new Date().toISOString(),
      output: null,
      requiredActions: approval
        ? [
            {
              type: 'tool.approval_required',
              id: 'synthetic-event',
              createdAt: new Date().toISOString(),
              threadId: 'synthetic-thread',
              toolCalls: [{ id: 'synthetic-call', sourceEventId: 'synthetic-source' }],
            },
          ]
        : [],
    },
  };
}
describe('repair publication recovery with synthetic runtime responses', () => {
  it('abandons an interrupted job but does not resume publication when repair is disabled', async () => {
    const { controller } = setup(false, { repairProfile: 'disabled' });
    const fixture = verifiedRepairFixture(controller);
    const [job] = controller.repairs.jobs(fixture.runId);
    if (!job) throw new Error('Missing repair fixture');
    job.state = 'preparing';
    controller.put(`repair-job:${fixture.runId}`, job.id, job);
    const cancel = vi
      .spyOn(TrueForgeAdapter.prototype, 'cancel')
      .mockRejectedValue(new Error('synthetic runtime unavailable'));
    const continuation = vi.spyOn(TrueForgeAdapter.prototype, 'findContinuation');

    await expect(controller.repairs.recover()).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledWith({ sessionId: job.sessionId });
    expect(controller.repairs.jobs(fixture.runId)[0]).toMatchObject({
      state: 'abandoned',
      error: 'REPAIR_INTERRUPTED_NO_REDISPATCH',
    });
    expect(continuation).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not dispatch again after an uncertain request; continuation exists: %s',
    async (exists) => {
      const { controller } = setup(),
        fixture = verifiedRepairFixture(controller);
      const dispatch = vi
        .spyOn(TrueForgeAdapter.prototype, 'continueTurn')
        .mockRejectedValue(new Error('synthetic response lost'));
      const lookup = vi
        .spyOn(TrueForgeAdapter.prototype, 'findContinuation')
        .mockResolvedValue(exists ? syntheticTurn('synthetic-gate', undefined, true) : undefined);
      vi.spyOn(TrueForgeAdapter.prototype, 'inspectTurn').mockResolvedValue(
        syntheticTurn('synthetic-gate', undefined, true),
      );
      await expect(
        controller.repairs.requestPublication(fixture.runId, fixture.jobId),
      ).rejects.toThrow('synthetic response lost');
      await controller.repairs.requestPublication(fixture.runId, fixture.jobId);
      await controller.repairs.recover();
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalled();
      await expect
        .poll(() => controller.get('repair-publication-runtime', fixture.jobId))
        .toMatchObject(
          exists
            ? { turnId: 'synthetic-gate', status: 'approval' }
            : { status: 'error', error: 'PUBLICATION_OUTCOME_UNKNOWN_NO_REDISPATCH' },
        );
      expect(controller.repairs.store.get(fixture.proposalId).approval?.decision).toBe('pending');
    },
  );
  it.each(['allow', 'deny'] as const)(
    'recovers a lost %s continuation without repeating that decision',
    async (decision) => {
      const { controller } = setup(),
        fixture = verifiedRepairFixture(controller);
      vi.spyOn(TrueForgeAdapter.prototype, 'continueTurn').mockResolvedValue(
        syntheticTurn('synthetic-gate', undefined, true),
      );
      vi.spyOn(TrueForgeAdapter.prototype, 'inspectTurn').mockImplementation(async ({ turnId }) =>
        syntheticTurn(turnId, undefined, turnId === 'synthetic-gate'),
      );
      await controller.repairs.requestPublication(fixture.runId, fixture.jobId);
      await expect
        .poll(() => controller.get('repair-publication-runtime', fixture.jobId))
        .toMatchObject({ status: 'approval' });
      const gate: RuntimeApproval = {
        threadId: 'synthetic-thread',
        toolCallId: 'synthetic-call',
        sourceEventId: 'synthetic-source',
        tool: {
          id: 'synthetic-call',
          type: 'function',
          function: {
            name: 'publish_repair_pr',
            arguments: JSON.stringify({ runId: fixture.runId, operationId: fixture.proposalId }),
          },
          toolInfo: {
            type: 'mcp',
            name: 'publish_repair_pr',
            serverId: `paywallproof_${fixture.runId.replaceAll('-', '')}`,
            serverName: 'synthetic',
          },
        },
      };
      vi.spyOn(TrueForgeAdapter.prototype, 'inspectApprovals').mockResolvedValue([gate]);
      const dispatch = vi
        .spyOn(TrueForgeAdapter.prototype, 'continueApproval')
        .mockRejectedValue(new Error('synthetic decision response lost'));
      vi.spyOn(TrueForgeAdapter.prototype, 'findContinuation').mockResolvedValue(
        syntheticTurn('synthetic-decision', 'synthetic-gate'),
      );
      const approval = controller.repairs.store.get(fixture.proposalId).approval;
      if (!approval) throw new Error('Missing synthetic approval');
      const request = { decision, bindingHash: approval.bindingHash };
      await expect(
        controller.repairs.decidePublication(fixture.runId, fixture.jobId, approval.id, request),
      ).rejects.toThrow('synthetic decision response lost');
      await controller.repairs.decidePublication(
        fixture.runId,
        fixture.jobId,
        approval.id,
        request,
      );
      await controller.repairs.recover();
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]?.[0].decisions[0]?.approval.status).toBe(decision);
      expect(controller.repairs.store.get(fixture.proposalId).approval?.decision).toBe(decision);
      await expect(
        controller.repairs.decidePublication(fixture.runId, fixture.jobId, approval.id, {
          ...request,
          decision: decision === 'allow' ? 'deny' : 'allow',
        }),
      ).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
      expect(controller.repairs.store.get(fixture.proposalId).progress).toBeNull();
    },
  );
  it.each(['wrong-run', 'malformed-json', 'wrong-server'])(
    'rejects a %s runtime approval before owner authorization',
    async (mismatch) => {
      const { controller } = setup(),
        fixture = verifiedRepairFixture(controller);
      vi.spyOn(TrueForgeAdapter.prototype, 'continueTurn').mockResolvedValue(
        syntheticTurn('synthetic-gate', undefined, true),
      );
      vi.spyOn(TrueForgeAdapter.prototype, 'inspectTurn').mockResolvedValue(
        syntheticTurn('synthetic-gate', undefined, true),
      );
      const dispatch = vi.spyOn(TrueForgeAdapter.prototype, 'continueApproval');
      await controller.repairs.requestPublication(fixture.runId, fixture.jobId);
      await expect
        .poll(() => controller.get('repair-publication-runtime', fixture.jobId))
        .toMatchObject({ status: 'approval' });
      vi.spyOn(TrueForgeAdapter.prototype, 'inspectApprovals').mockResolvedValue([
        {
          threadId: 'synthetic-thread',
          toolCallId: 'synthetic-call',
          sourceEventId: 'synthetic-source',
          tool: {
            id: 'synthetic-call',
            type: 'function',
            function: {
              name: 'publish_repair_pr',
              arguments:
                mismatch === 'malformed-json'
                  ? '{'
                  : JSON.stringify({
                      runId: mismatch === 'wrong-run' ? 'different-run' : fixture.runId,
                      operationId: fixture.proposalId,
                    }),
            },
            toolInfo: {
              type: 'mcp',
              name: 'publish_repair_pr',
              serverId:
                mismatch === 'wrong-server'
                  ? 'different-server'
                  : `paywallproof_${fixture.runId.replaceAll('-', '')}`,
              serverName: 'synthetic',
            },
          },
        },
      ]);
      const approval = controller.repairs.store.get(fixture.proposalId).approval;
      if (!approval) throw new Error('Missing synthetic approval');
      await expect(
        controller.repairs.decidePublication(fixture.runId, fixture.jobId, approval.id, {
          decision: 'allow',
          bindingHash: approval.bindingHash,
        }),
      ).rejects.toMatchObject({ code: 'RUNTIME_APPROVAL_MISMATCH' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(controller.repairs.store.get(fixture.proposalId).approval?.decision).toBe('pending');
    },
  );
});

describe('HTTP idempotency after handled preflight failures', () => {
  it.each(['invalid-json', 'invalid-mode', 'missing-project', 'failed-read'] as const)(
    'persists and replays a redacted %s response without stranding the request ID',
    async (kind) => {
      const { controller, app } = setup(true);
      if (!app) throw new Error('HTTP fixture missing');
      const preflight = vi.spyOn(controller, 'preflight');
      if (kind === 'failed-read')
        preflight.mockRejectedValue(new Error('private-token-must-not-leak'));
      const body =
        kind === 'invalid-json'
          ? '{'
          : JSON.stringify({ mode: kind === 'invalid-mode' ? 'live' : 'local_replay' });
      const id = `preflight-${kind}`;
      const send = () =>
        app.request('http://127.0.0.1:39982/api/projects/missing-project/preflight', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer synthetic-operator',
            'X-Request-ID': id,
            'Content-Type': 'application/json',
          },
          body,
        });
      const first = await send(),
        firstBody = await first.text();
      expect(first.status).toBe(
        kind === 'failed-read' ? 422 : kind === 'missing-project' ? 404 : 400,
      );
      const second = await send();
      expect(second.status).toBe(first.status);
      expect(await second.text()).toBe(firstBody);
      expect(firstBody).not.toContain('private-token-must-not-leak');
      expect(firstBody).not.toContain('OPERATION_OUTCOME_UNKNOWN');
      expect(preflight).toHaveBeenCalledTimes(
        kind === 'missing-project' || kind === 'failed-read' ? 1 : 0,
      );
      const saved = controller.database
        .prepare('SELECT response FROM http_requests WHERE id=?')
        .get(id);
      expect(saved).toMatchObject({
        response: JSON.stringify({ status: first.status, body: firstBody }),
      });
    },
  );
});

describe('restart lifecycle deadline and effect recovery', () => {
  it.each([
    ['at', 15 * 60 * 1000],
    ['past', 15 * 60 * 1000 + 1],
  ] as const)(
    'does not dispatch a prepared allow decision %s its execution deadline',
    async (_boundary, elapsed) => {
      vi.useFakeTimers();
      const startedAt = Date.parse('2026-08-30T12:00:00.000Z');
      vi.setSystemTime(startedAt);
      const { controller, start } = setup();
      vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
        () => new Promise(() => {}),
      );
      const run = await start();
      controller.put('runtime', run.id, {
        sessionId: 'synthetic-session',
        turnId: 'synthetic-plan',
        lastSequenceNumber: 0,
        status: 'approval',
      });
      controller.put('runtime-continuation', run.id, {
        status: 'prepared',
        sessionId: 'synthetic-session',
        previousTurnId: 'synthetic-plan',
        decision: 'allow',
        approvalId: run.approval.id,
        bindingHash: run.approval.bindingHash,
      });
      controller.runs.decidePlan({
        runId: run.id,
        approvalId: run.approval.id,
        bindingHash: run.approval.bindingHash,
        decision: 'allow',
      });
      vi.spyOn(controller.runtime, 'inspectApprovals').mockResolvedValue([planApproval(run.id)]);
      const dispatch = vi.spyOn(controller.runtime, 'continueApproval');
      const resume = vi.spyOn(controller.runtime, 'resumeStream');
      vi.setSystemTime(startedAt + elapsed);

      await controller.recover();
      await controller.recover();

      expect(dispatch).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(controller.runs.getRun(run.id).status).toBe('canceled');
      expect(controller.get('limit-hit', run.id)).toEqual({
        code: 'EXECUTION_DEADLINE',
        at: startedAt + 15 * 60 * 1000,
      });
      expect(controller.get('runtime-continuation', run.id)).toMatchObject({
        status: 'prepared',
        decision: 'allow',
      });
    },
  );

  it('does not resume a plain running turn at the execution deadline', async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse('2026-08-30T13:00:00.000Z');
    vi.setSystemTime(startedAt);
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-running-turn',
      lastSequenceNumber: 0,
      status: 'running',
    });
    const resume = vi.spyOn(controller.runtime, 'resumeStream');
    vi.setSystemTime(startedAt + 15 * 60 * 1000);

    await controller.recover();

    expect(resume).not.toHaveBeenCalled();
    expect(controller.runs.getRun(run.id).status).toBe('canceled');
    expect(controller.get('limit-hit', run.id)).toEqual({
      code: 'EXECUTION_DEADLINE',
      at: startedAt + 15 * 60 * 1000,
    });
  });

  it('expires a credited external wait instead of restoring its runtime', async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse('2026-08-30T14:00:00.000Z');
    vi.setSystemTime(startedAt);
    const organizationId = '00000000-0000-4000-8000-000000000021';
    const productId = '00000000-0000-4000-8000-000000000022';
    const priceId = '00000000-0000-4000-8000-000000000023';
    const { controller, start } = setup(false, {
      polarToken: 'polar_oat_synthetic',
      polarOrganizationId: organizationId,
      polarProductId: productId,
      priceId,
      testCustomerEmail: 'owned-sandbox@example.test',
    });
    if (!controller.polar) throw new Error('Missing Polar fixture');
    const preflight = {
      provider: 'polar',
      mode: 'polar_sandbox',
      organizationId,
      productId,
      priceId,
      amount: 100,
      currency: 'usd',
      apiVersion: '2026-04',
      scope: 'read_only_preflight',
      lifecycleVerified: false,
    } as const;
    vi.spyOn(controller.polar, 'preflight').mockResolvedValue(preflight);
    vi.spyOn(controller.polar, 'ensurePreflight').mockResolvedValue(preflight);
    vi.spyOn(controller.polar, 'cleanup').mockResolvedValue([]);
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start('polar_sandbox');
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-checkout-turn',
      lastSequenceNumber: 0,
      status: 'waiting_external',
    });
    controller.put('context', run.id, {
      ...controller.context(run.id),
      checkoutStarted: true,
    });
    const wait = {
      runId: run.id,
      waitId: 'polar_checkout',
      startedAt: startedAt + 100,
      endedAt: startedAt + 500,
    };
    vi.setSystemTime(wait.endedAt);
    controller.runs.creditExternalWait(wait);
    controller.put('external-wait', run.id, {
      waitId: wait.waitId,
      status: 'credited',
      startedAt: wait.startedAt,
      endedAt: wait.endedAt,
    });
    controller.put('checkout-continuation', run.id, {
      status: 'confirmed',
      sessionId: 'synthetic-session',
      previousTurnId: 'synthetic-checkout-turn',
      turnId: 'synthetic-resumed-turn',
    });
    const restore = vi.spyOn(controller.checkoutContinuations, 'restore');
    const resume = vi.spyOn(controller.runtime, 'resumeStream');
    const continueTurn = vi.spyOn(controller.runtime, 'continueTurn');
    const findContinuation = vi.spyOn(controller.runtime, 'findContinuation');
    const adjustedDeadline = startedAt + (wait.endedAt - wait.startedAt) + 15 * 60 * 1000;
    vi.setSystemTime(adjustedDeadline);

    await controller.recover();
    await controller.recover();

    expect(restore).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(continueTurn).not.toHaveBeenCalled();
    expect(findContinuation).not.toHaveBeenCalled();
    expect(controller.runs.getRun(run.id).status).toBe('canceled');
    expect(controller.get('limit-hit', run.id)).toEqual({
      code: 'EXECUTION_DEADLINE',
      at: adjustedDeadline,
    });
  });

  it('keeps an interrupted resource creation in manual review after restart', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-running-turn',
      lastSequenceNumber: 0,
      status: 'running',
    });
    controller.runs.claimOperation({
      runId: run.id,
      operationId: 'interrupted_fixture_creation',
      kind: 'prepare_fixture',
      args: { runId: run.id, operationId: 'interrupted_fixture_creation' },
      approvalId: run.approval.id,
      leaseMs: 30_000,
    });
    const cancelRun = vi.spyOn(controller.runs, 'cancelRun');

    await controller.recover();
    await controller.recover();

    expect(controller.runs.operations({ runId: run.id })).toEqual([
      expect.objectContaining({
        operationId: 'interrupted_fixture_creation',
        kind: 'prepare_fixture',
        state: 'unknown',
      }),
    ]);
    expect(controller.runs.getRun(run.id).status).toBe('stopping');
    expect(controller.get('operation-reconciliation', run.id)).toMatchObject({
      status: 'manual_review',
      operations: [
        expect.objectContaining({
          operationId: 'interrupted_fixture_creation',
          kind: 'prepare_fixture',
          state: 'unknown',
        }),
      ],
    });
    expect(controller.get('stop-error', run.id)).toMatchObject({
      code: 'IN_FLIGHT_EFFECT_UNRESOLVED',
    });
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it('recovers a confirmed cleanup intent without deleting the target twice', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('context', run.id, {
      ...controller.context(run.id),
      free: {
        principalId: 'synthetic-free',
        runId: run.id,
        fixtureMarker: 'synthetic-marker',
      },
    });
    const removeTarget = vi.spyOn(controller.target, 'cleanup').mockResolvedValue({
      removed: true,
      principalId: 'synthetic-free',
      runId: run.id,
    });
    const intentId = hashValue({ runId: run.id, resourceId: 'synthetic-free' });
    const write = controller.put.bind(controller);
    const crash = vi.spyOn(controller, 'put').mockImplementation((kind, id, value) => {
      if (
        kind === 'context' &&
        id === run.id &&
        (controller.get('cleanup-intent', intentId) as { state?: string } | null)?.state ===
          'confirmed'
      )
        throw new Error('synthetic crash before cleanup context save');
      write(kind, id, value);
    });

    await expect(controller.cleanup(run.id)).rejects.toThrow(
      'synthetic crash before cleanup context save',
    );
    crash.mockRestore();
    expect(controller.context(run.id).cleanup).toEqual([]);
    expect(controller.get('cleanup-intent', intentId)).toMatchObject({
      runId: run.id,
      resourceId: 'synthetic-free',
      state: 'confirmed',
    });

    await expect(controller.cleanup(run.id)).resolves.toMatchObject({
      resources: [{ resourceId: 'synthetic-free', status: 'deleted' }],
    });
    expect(removeTarget).toHaveBeenCalledTimes(1);
    expect(controller.context(run.id).cleanup).toEqual([
      { resourceId: 'synthetic-free', status: 'deleted' },
    ]);
  });
});

describe('runtime continuation restart reconciliation', () => {
  it('restores the confirmed plan cursor from the legacy split-write format', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime-continuation', run.id, {
      status: 'confirmed',
      sessionId: 'synthetic-session',
      previousTurnId: 'synthetic-plan-turn',
      turnId: 'synthetic-confirmed-turn',
      decision: 'allow',
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-plan-turn',
      lastSequenceNumber: 7,
      status: 'approval',
    });
    const resume = vi
      .spyOn(controller.runtime, 'resumeStream')
      .mockImplementation(() => new Promise(() => {}));

    await controller.recover();

    expect(controller.get('runtime', run.id)).toMatchObject({
      sessionId: 'synthetic-session',
      turnId: 'synthetic-confirmed-turn',
      lastSequenceNumber: 0,
      status: 'running',
    });
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
  });

  it('reconciles a dispatched plan continuation before finalizing a stopping run', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-plan-turn',
      lastSequenceNumber: 0,
      status: 'approval',
    });
    controller.put('runtime-continuation', run.id, {
      status: 'dispatched',
      sessionId: 'synthetic-session',
      previousTurnId: 'synthetic-plan-turn',
      decision: 'allow',
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
    });
    controller.runs.requestStop(run.id);
    vi.spyOn(controller.runtime, 'findContinuation').mockResolvedValue(
      syntheticTurn('synthetic-confirmed-turn', 'synthetic-plan-turn'),
    );

    await controller.recover();

    expect(controller.runs.getRun(run.id).status).toBe('canceled');
    expect(controller.get('runtime-continuation', run.id)).toMatchObject({
      status: 'confirmed',
      turnId: 'synthetic-confirmed-turn',
    });
    expect(controller.get('continuation-reconciliation', run.id)).toMatchObject({
      status: 'reconciled',
      continuations: [expect.objectContaining({ kind: 'plan', status: 'confirmed' })],
    });
    expect(controller.get('runtime', run.id)).toMatchObject({
      status: 'error',
      error: 'RUN_STOPPED_AFTER_CONTINUATION',
    });
  });

  it('records an unavailable checkout lookup as unknown but still revokes and cleans up', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000051';
    const productId = '00000000-0000-4000-8000-000000000052';
    const priceId = '00000000-0000-4000-8000-000000000053';
    const { controller, start } = setup(false, {
      polarToken: 'polar_oat_synthetic',
      polarOrganizationId: organizationId,
      polarProductId: productId,
      priceId,
      testCustomerEmail: 'owned-sandbox@example.test',
    });
    if (!controller.polar) throw new Error('Missing Polar fixture');
    const preflight = {
      provider: 'polar',
      mode: 'polar_sandbox',
      organizationId,
      productId,
      priceId,
      amount: 100,
      currency: 'usd',
      apiVersion: '2026-04',
      scope: 'read_only_preflight',
      lifecycleVerified: false,
    } as const;
    vi.spyOn(controller.polar, 'preflight').mockResolvedValue(preflight);
    vi.spyOn(controller.polar, 'ensurePreflight').mockResolvedValue(preflight);
    vi.spyOn(controller.polar, 'cleanup').mockResolvedValue([]);
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start('polar_sandbox');
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-checkout-turn',
      lastSequenceNumber: 0,
      status: 'waiting_external',
    });
    controller.put('checkout-continuation', run.id, {
      status: 'dispatched',
      sessionId: 'synthetic-session',
      previousTurnId: 'synthetic-checkout-turn',
    });
    controller.runs.requestStop(run.id);
    vi.spyOn(controller.runtime, 'findContinuation').mockRejectedValue(
      new Error('synthetic runtime unavailable'),
    );

    await controller.recover();

    expect(controller.runs.getRun(run.id).status).toBe('canceled');
    expect(controller.get('checkout-continuation', run.id)).toMatchObject({
      status: 'unknown',
    });
    expect(controller.get('continuation-reconciliation', run.id)).toMatchObject({
      status: 'unknown',
      continuations: [
        expect.objectContaining({
          kind: 'checkout',
          status: 'unknown',
          code: 'RUNTIME_LOOKUP_UNAVAILABLE',
        }),
      ],
    });
    expect(controller.list('mcp-token')).toEqual([]);
  });

  it('does not rewind advanced runtime state from historical confirmed continuations while stopping', async () => {
    const { controller, start } = setup();
    vi.spyOn(controller.runtime, 'registerMcpServer').mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await start();
    controller.runs.decidePlan({
      runId: run.id,
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
      decision: 'allow',
    });
    controller.put('runtime-continuation', run.id, {
      status: 'confirmed',
      sessionId: 'synthetic-session',
      previousTurnId: 'synthetic-plan-turn',
      turnId: 'synthetic-plan-confirmed-turn',
      decision: 'allow',
      approvalId: run.approval.id,
      bindingHash: run.approval.bindingHash,
    });
    controller.put('checkout-continuation', run.id, {
      status: 'confirmed',
      sessionId: 'synthetic-session',
      previousTurnId: 'synthetic-checkout-turn',
      turnId: 'synthetic-checkout-confirmed-turn',
    });
    controller.put('runtime', run.id, {
      sessionId: 'synthetic-session',
      turnId: 'synthetic-later-lifecycle-turn',
      lastSequenceNumber: 17,
      status: 'running',
    });
    controller.runs.requestStop(run.id);

    await controller.recover();

    expect(controller.runs.getRun(run.id).status).toBe('canceled');
    expect(controller.get('runtime', run.id)).toEqual({
      sessionId: 'synthetic-session',
      turnId: 'synthetic-later-lifecycle-turn',
      lastSequenceNumber: 17,
      status: 'error',
      error: 'RUN_STOPPED',
    });
    expect(controller.get('continuation-reconciliation', run.id)).toBeNull();
  });
});
