import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { signReplay } from '#reference/replay-signature';
import { z } from 'zod';
import { billingSchema, hashValue, parsePolicy, type AccessPolicy, type Billing } from '#domain';
import { EvidenceStore, type Observation } from '#evidence';
import { observeFeature, observeScenario } from '#evidence/probe';
import { TargetTransport, ReferenceTargetAdapter } from '#integrations/network';
import { BrowserRunner } from '#integrations/browser';
import { RepairError } from './model.ts';
import type { SandboxTargetReady } from './sandbox.ts';
import { probeRepairSecurity, type SecurityControl } from './controls.ts';

export const CORE_SCENARIOS = ['SC01', 'SC02', 'SC03', 'SC04'] as const;
type ScenarioId = (typeof CORE_SCENARIOS)[number];
export const planSchema = z.strictObject({
  schemaVersion: z.literal(2),
  mode: z.literal('local_replay'),
  runId: z.string().uuid(),
  policyHash: z.string(),
  markers: z.strictObject({ free: z.string().uuid(), paid: z.string().uuid() }),
  states: z.strictObject({
    SC01: billingSchema,
    SC02: billingSchema,
    SC03: billingSchema,
    SC04: billingSchema,
  }),
});
export type RepairReplayPlan = z.infer<typeof planSchema>;

/** Bind the external evaluator, timing, browser and transport implementations together. */
export async function oracleFingerprint(repositoryRoot: string) {
  const paths = [
    'src/reference/replay-signature.ts',
    'src/integrations/polar.ts',
    'src/domain/index.ts',
    'src/evidence/index.ts',
    'src/evidence/probe.ts',
    'src/integrations/network.ts',
    'src/integrations/browser.ts',
    'src/repair/oracle.ts',
    'src/repair/controls.ts',
    'src/repair/oracle-process.ts',
    'scripts/repair-oracle.ts',
  ];
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      sha256: createHash('sha256')
        .update(await readFile(resolve(repositoryRoot, path)))
        .digest('hex'),
    })),
  );
  return { hash: hashValue(files), files };
}

/** Build a synthetic replay from recorded billing facts, replacing owned resource identities. */
export function createRepairReplayPlan(input: {
  runId: string;
  targetBuild: string;
  policy: AccessPolicy;
  observations: readonly Observation[];
}): RepairReplayPlan {
  const policy = parsePolicy(input.policy),
    runId = randomUUID(),
    customerId = `cus_replay_${runId.replaceAll('-', '')}`,
    subscriptionId = `sub_replay_${runId.replaceAll('-', '')}`;
  let originalIdentity:
    | {
        customerId: string;
        subscriptionId: string;
        periodEnd: number;
        mode: string;
        subjectId: string;
      }
    | undefined;
  let freeIdentity: { subjectId: string; mode: string } | undefined;
  const state = (scenarioId: ScenarioId): Billing => {
    const candidates = input.observations
      .filter(
        (item) =>
          item.source === 'billing_provider' &&
          item.scenarioId === scenarioId &&
          item.policyHash === policy.hash &&
          item.runId === input.runId &&
          item.targetBuild === input.targetBuild,
      )
      .sort((a, b) => b.observedAt - a.observedAt);
    const record = candidates[0];
    if (!record || hashValue(record.payload) !== record.sha256)
      throw new RepairError('REPAIR_BILLING_EVIDENCE_REQUIRED');
    if (
      candidates.some(
        (item) =>
          item.observedAt === record.observedAt &&
          (item.sha256 !== record.sha256 ||
            hashValue(item.payload) !== record.sha256 ||
            item.subjectId !== record.subjectId ||
            item.mode !== record.mode),
      )
    )
      throw new RepairError('REPAIR_BILLING_EVIDENCE_REQUIRED');
    const parsed = billingSchema.safeParse(record.payload);
    if (!parsed.success) throw new RepairError('REPAIR_BILLING_EVIDENCE_REQUIRED');
    const original = parsed.data;
    if (
      original.livemode ||
      !original.identityResolved ||
      (original.subscription && original.subscription.priceId !== policy.priceId)
    )
      throw new RepairError('REPAIR_BILLING_EVIDENCE_REQUIRED');
    if (scenarioId === 'SC01') {
      if (
        !original.noSubscriptionConfirmed ||
        original.customerId !== null ||
        original.subscription !== null
      )
        throw new RepairError('REPAIR_BILLING_EVIDENCE_REQUIRED');
      freeIdentity = { subjectId: record.subjectId, mode: record.mode };
      return original;
    }
    if (
      !original.subscription ||
      original.noSubscriptionConfirmed ||
      original.customerId !== original.subscription.customerId
    )
      throw new RepairError('REPAIR_BILLING_EVIDENCE_REQUIRED');
    const subscription = original.subscription;
    const established =
      scenarioId === 'SC02'
        ? subscription.status === 'active' &&
          subscription.initialPaymentConfirmed &&
          !subscription.cancelAtPeriodEnd
        : scenarioId === 'SC03'
          ? subscription.status === 'active' &&
            subscription.initialPaymentConfirmed &&
            subscription.cancelAtPeriodEnd &&
            subscription.billingTime < subscription.periodEnd
          : subscription.status === 'canceled' &&
            subscription.billingTime >= subscription.periodEnd;
    const identity = {
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      periodEnd: subscription.periodEnd,
      mode: record.mode,
      subjectId: record.subjectId,
    };
    if (
      !established ||
      !freeIdentity ||
      freeIdentity.subjectId === record.subjectId ||
      freeIdentity.mode !== record.mode ||
      (originalIdentity && hashValue(identity) !== hashValue(originalIdentity))
    )
      throw new RepairError('REPAIR_BILLING_EVIDENCE_REQUIRED');
    originalIdentity ??= identity;
    return {
      ...original,
      customerId,
      subscription: { ...original.subscription, id: subscriptionId, customerId },
    };
  };
  return planSchema.parse({
    schemaVersion: 2,
    mode: 'local_replay',
    runId,
    policyHash: policy.hash,
    markers: { free: randomUUID(), paid: randomUUID() },
    states: { SC01: state('SC01'), SC02: state('SC02'), SC03: state('SC03'), SC04: state('SC04') },
  });
}

export function replayPayload(
  planInput: RepairReplayPlan,
  scenarioId: Exclude<ScenarioId, 'SC01'>,
) {
  const plan = planSchema.parse(planInput),
    billing = plan.states[scenarioId],
    subscription = billing.subscription;
  if (!subscription) throw new RepairError('REPAIR_BILLING_EVIDENCE_REQUIRED');
  const type = {
    SC02: 'customer.subscription.created',
    SC03: 'customer.subscription.updated',
    SC04: 'customer.subscription.deleted',
  }[scenarioId];
  return JSON.stringify({
    id: `evt_repair_${plan.runId}_${scenarioId}`,
    object: 'event',
    type,
    livemode: false,
    created: subscription.billingTime,
    data: {
      object: {
        id: subscription.id,
        object: 'subscription',
        livemode: false,
        customer: subscription.customerId,
        metadata: { runId: plan.runId },
        status: subscription.status,
        cancel_at_period_end: subscription.cancelAtPeriodEnd,
        items: {
          data: [
            {
              price: { id: subscription.priceId, livemode: false },
              current_period_end: subscription.periodEnd,
            },
          ],
          has_more: false,
        },
        latest_invoice: {
          id: `in_repair_${plan.runId}`,
          object: 'invoice',
          livemode: false,
          status: subscription.initialPaymentConfirmed ? 'paid' : 'open',
          customer: subscription.customerId,
          billing_reason: 'subscription_create',
          parent: { subscription_details: { subscription: subscription.id } },
        },
      },
    },
  });
}

/** Runs outside the sandbox against its exact, disposable reverse-HTTP target. */
export async function runRepairOracle(input: {
  target: Omit<SandboxTargetReady, 'registerRoutes'> & {
    registerRoutes: (
      routes: Parameters<SandboxTargetReady['registerRoutes']>[0],
    ) => void | Promise<void>;
  };
  plan: RepairReplayPlan;
  policy: AccessPolicy;
  targetBuild: string;
  databasePath: string;
  artifactDirectory: string;
  signal: AbortSignal;
}) {
  const policy = parsePolicy(input.policy),
    plan = planSchema.parse(input.plan);
  if (plan.policyHash !== policy.hash) throw new RepairError('REPAIR_POLICY_MISMATCH');
  const transport = new TargetTransport({ origin: input.target.origin, allowLoopback: true });
  const target = new ReferenceTargetAdapter(transport, input.target.adapterToken, () =>
    input.signal.throwIfAborted(),
  );
  const browser = new BrowserRunner(transport, input.artifactDirectory);
  const evidence = new EvidenceStore(input.databasePath, [
    input.target.adapterToken,
    input.target.replaySecret,
    input.target.webhookSecret,
  ]);
  const principals: Awaited<ReturnType<ReferenceTargetAdapter['createUser']>>[] = [],
    cleanup: { resourceId: string; status: 'deleted' | 'leftover' }[] = [];
  const artifacts: unknown[] = [],
    scenarios = [];
  let controls: SecurityControl[] = [];
  try {
    const description = await target.describe();
    if (
      description.buildId !== input.targetBuild ||
      hashValue(description.feature) !== policy.featureConfigHash
    )
      throw new RepairError('TARGET_CHANGED');
    for (const kind of ['free', 'paid'] as const) {
      input.signal.throwIfAborted();
      const principal = await target.createUser({
        runId: plan.runId,
        operationId: `${plan.runId}_${kind}`,
        fixtureMarker: plan.markers[kind],
      });
      if (principal.runId !== plan.runId || principal.fixtureMarker !== plan.markers[kind])
        throw new RepairError('FIXTURE_IDENTITY_MISMATCH');
      principals.push(principal);
      const path = `/staging/users/${encodeURIComponent(principal.principalId)}`;
      await input.target.registerRoutes([
        { method: 'POST', path: `${path}/customer` },
        { method: 'POST', path: `${path}/session` },
        { method: 'GET', path: `${path}/billing?runId=${plan.runId}` },
        { method: 'DELETE', path: `${path}?runId=${plan.runId}` },
      ]);
    }
    const [free, paid] = principals,
      customerId = plan.states.SC02.customerId;
    if (!free || !paid || !customerId) throw new RepairError('FIXTURE_IDENTITY_MISMATCH');
    await target.linkCustomer({ runId: plan.runId, principalId: paid.principalId, customerId });
    controls = await probeRepairSecurity({
      transport,
      adapterToken: input.target.adapterToken,
      replaySecret: input.target.replaySecret,
      webhookSecret: input.target.webhookSecret,
      runId: plan.runId,
      principalId: paid.principalId,
      activationPayload: replayPayload(plan, 'SC02'),
      signal: input.signal,
    });
    for (const scenarioId of CORE_SCENARIOS) {
      input.signal.throwIfAborted();
      if (scenarioId !== 'SC01') {
        const payload = replayPayload(plan, scenarioId),
          signature = signReplay({ payload, secret: input.target.replaySecret });
        const response = await transport.request('/staging/replay', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${input.target.adapterToken}`,
            'Content-Type': 'application/json',
            'PaywallProof-Replay-Signature': signature,
          },
          body: payload,
          beforeDispatch: () => input.signal.throwIfAborted(),
        });
        if (response.status !== 200) throw new RepairError('REPAIR_REPLAY_REJECTED');
      }
      const principal = scenarioId === 'SC01' ? free : paid,
        billing = async () => billingSchema.parse(plan.states[scenarioId]);
      const result = await observeScenario({
        scenarioId,
        policy,
        billing,
        assertActive: () => input.signal.throwIfAborted(),
        collect: (notBefore) =>
          observeFeature({
            store: evidence,
            target,
            browser,
            runId: plan.runId,
            scenarioId,
            subjectId: principal.principalId,
            fixtureMarker: principal.fixtureMarker,
            policy,
            targetBuild: input.targetBuild,
            mode: 'local_replay',
            notBefore,
            billing,
            onArtifact: (artifact) => artifacts.push(artifact),
          }),
      });
      scenarios.push({ id: scenarioId, ...result });
    }
  } finally {
    // Disposable target owns these users even if its test was interrupted. No provider cleanup is attempted.
    const cleanupTarget = new ReferenceTargetAdapter(transport, input.target.adapterToken);
    for (const principal of principals)
      try {
        await cleanupTarget.cleanup({ runId: plan.runId, principalId: principal.principalId });
        cleanup.push({ resourceId: principal.principalId, status: 'deleted' });
      } catch {
        cleanup.push({ resourceId: principal.principalId, status: 'leftover' });
      }
    evidence.close();
  }
  const reader = new EvidenceStore(input.databasePath);
  try {
    return {
      mode: 'local_replay' as const,
      planHash: hashValue(plan),
      scenarios,
      controls,
      observations: reader.list(plan.runId),
      artifacts,
      cleanup,
      completedAt: Date.now(),
    };
  } finally {
    reader.close();
  }
}
