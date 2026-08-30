import { type Billing, type AccessPolicy, hashValue } from '#domain';
import { EvidenceStore, evaluateEvidence, type EvidenceEvaluation } from './index.ts';
import { type TargetContractV1Adapter } from '#integrations/target-contract';
import { type BrowserRunner } from '#integrations/browser';

export class ScenarioError extends Error {
  constructor(readonly code: 'PROVIDER_UNAVAILABLE' | 'SYNC_TIMEOUT') {
    super(code);
  }
}

export async function observeScenario(input: {
  scenarioId: 'SC01' | 'SC02' | 'SC03' | 'SC04';
  policy: AccessPolicy;
  billing: () => Promise<Billing>;
  collect: (notBefore: number) => Promise<EvidenceEvaluation>;
  assertActive?: () => void | Promise<void>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<EvidenceEvaluation> {
  const now = input.now ?? Date.now,
    wait =
      input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const active = input.assertActive ?? (() => {}),
    providerDeadline = now() + 90_000;
  for (;;) {
    await active();
    let established = false;
    try {
      const billing = await input.billing(),
        subscription = billing.subscription;
      established =
        input.scenarioId === 'SC01'
          ? billing.noSubscriptionConfirmed && !subscription
          : input.scenarioId === 'SC02'
            ? subscription?.status === 'active' &&
              subscription.initialPaymentConfirmed &&
              !subscription.cancelAtPeriodEnd
            : input.scenarioId === 'SC03'
              ? subscription?.status === 'active' &&
                subscription.initialPaymentConfirmed &&
                subscription.cancelAtPeriodEnd &&
                subscription.billingTime < subscription.periodEnd
              : subscription?.status === 'canceled' &&
                subscription.billingTime >= subscription.periodEnd;
    } catch {
      if (now() >= providerDeadline) throw new ScenarioError('PROVIDER_UNAVAILABLE');
    }
    if (now() > providerDeadline) throw new ScenarioError('SYNC_TIMEOUT');
    if (established) break;
    if (now() >= providerDeadline) throw new ScenarioError('SYNC_TIMEOUT');
    await wait(1000);
  }
  const confirmedAt = now(),
    deadline = confirmedAt + input.policy.syncWindowSeconds * 1000;
  const collect = async (notBefore: number) => {
    await active();
    const result = await input.collect(notBefore);
    await active();
    return result;
  };
  for (;;) {
    if (now() >= deadline) {
      const first = await collect(deadline),
        second = await collect(deadline);
      const stable = (channel: 'api' | 'browser' | 'state') =>
        second[channel].verdict === 'fail' &&
        (first[channel].verdict !== 'fail' || first[channel].code !== second[channel].code)
          ? { verdict: 'inconclusive' as const, code: 'UNSTABLE_CONTRADICTION' }
          : { ...second[channel] };
      return {
        api: stable('api'),
        browser: stable('browser'),
        state: stable('state'),
        observationIds: [...first.observationIds, ...second.observationIds],
      };
    }
    const result = await collect(confirmedAt);
    if ([result.api, result.browser, result.state].every((channel) => channel.verdict === 'pass'))
      return result;
    await wait(1000);
  }
}

/** Shared trusted observation collector for original and repaired target executions. */
export async function observeFeature(input: {
  store: EvidenceStore;
  target: TargetContractV1Adapter;
  browser: BrowserRunner;
  runId: string;
  scenarioId: string;
  subjectId: string;
  fixtureMarker: string;
  policy: AccessPolicy;
  targetBuild: string;
  mode: 'local_replay' | 'polar_sandbox';
  notBefore: number;
  billing: () => Promise<Billing>;
  onArtifact?: (
    artifact: NonNullable<Awaited<ReturnType<BrowserRunner['probe']>>['artifact']> & {
      runId: string;
      observationId: string;
    },
  ) => void;
}) {
  const target = await input.target.describe();
  if (
    target.buildId !== input.targetBuild ||
    hashValue(target.feature) !== input.policy.featureConfigHash
  )
    throw new Error('TARGET_CHANGED');
  const session = await input.target.session({ runId: input.runId, principalId: input.subjectId });
  // Cold browser startup may take longer than the evidence freshness window.
  // Observe it first, then obtain fresh independent reads. Never restamp old facts.
  const browser = await input.browser.probe(session.cookie, target.feature),
    browserObservedAt = Date.now();
  const timed = async <T>(read: () => Promise<T>) => ({
    payload: await read(),
    observedAt: Date.now(),
  });
  const [provider, application, api] = await Promise.all([
    timed(input.billing),
    timed(() => input.target.snapshot({ runId: input.runId, principalId: input.subjectId })),
    timed(() => input.target.probe(session.cookie, target.feature)),
  ]);
  const billing = provider.payload;
  const finalTarget = await input.target.describe();
  if (
    finalTarget.buildId !== input.targetBuild ||
    hashValue(finalTarget.feature) !== input.policy.featureConfigHash
  )
    throw new Error('TARGET_CHANGED');
  const common = {
    runId: input.runId,
    scenarioId: input.scenarioId,
    subjectId: input.subjectId,
    policyHash: input.policy.hash,
    targetBuild: input.targetBuild,
    mode: input.mode,
    billingTime: billing.subscription?.billingTime ?? null,
  };
  const providerObservation = input.store.record({
    ...common,
    observedAt: provider.observedAt,
    source: 'billing_provider',
    payload: billing,
  });
  const app = input.store.record({
    ...common,
    observedAt: application.observedAt,
    source: 'application',
    payload: application.payload,
  });
  const apiObservation = input.store.record({
    ...common,
    observedAt: api.observedAt,
    source: 'api_probe',
    payload: api.payload,
  });
  const browserObservation = input.store.record({
    ...common,
    observedAt: browserObservedAt,
    source: 'browser',
    payload: browser.probe,
  });
  if (browser.artifact)
    input.onArtifact?.({
      ...browser.artifact,
      runId: input.runId,
      observationId: browserObservation.id,
    });
  return evaluateEvidence(input.store, {
    runId: input.runId,
    scenarioId: input.scenarioId,
    subjectId: input.subjectId,
    policy: input.policy,
    targetBuild: input.targetBuild,
    mode: input.mode,
    fixtureMarker: input.fixtureMarker,
    providerId: providerObservation.id,
    applicationId: app.id,
    apiId: apiObservation.id,
    browserId: browserObservation.id,
    now: Date.now(),
    notBefore: input.notBefore,
  });
}
