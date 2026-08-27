import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReferenceApp } from '../../packages/reference/src/index.ts';
import { createPolicy, aggregateVerdicts } from '../../packages/core/src/index.ts';
import { EvidenceStore, evaluateEvidence } from '../../packages/evidence/src/index.ts';

// Vertical acceptance: actual reference HTTP handlers + durable evidence.
// Billing is signed synthetic local_replay, never an observed Stripe receipt.
// Browser execution is deliberately unavailable, not replaced by a second API
// call. Consequently a good application cannot receive an overall passing run.

type Reference = ReturnType<typeof createReferenceApp>;
type Scenario = 'SC01' | 'SC02' | 'SC03' | 'SC04';
type FaultMode = 'none' | 'missing_guard' | 'missing_activation' | 'missing_cancellation';
type User = { principalId: string; fixtureMarker: string; cookie: string };
type Evaluation = Awaited<ReturnType<typeof evaluateEvidence>>;
const priceId = 'price_synthetic_pro';
const buildId = 'reference_vertical_synthetic_build';
const adapterToken = 'SYNTHETIC_VERTICAL_ADAPTER_CREDENTIAL';
const replaySecret = ['whsec', 'SYNTHETIC_VERTICAL_REPLAY_SECRET'].join('_');
const webhookSecret = ['whsec', 'SYNTHETIC_VERTICAL_WEBHOOK_SECRET'].join('_');
const startedBillingTime = 1_800_000_000;
const periodEnd = 1_802_678_400;
const feature = {
  id: 'pro_export', method: 'GET', path: '/api/export', denialStatuses: [403], browserPath: '/dashboard',
  actionTestId: 'export-button', resultTestId: 'export-result',
};
let directory: string;
let reference: Reference | undefined;
let evidence: EvidenceStore | undefined;

function textField(value: unknown, key: string): string {
  if (value !== null && typeof value === 'object') {
    const field: unknown = Reflect.get(value, key);
    if (typeof field === 'string') return field;
  }
  throw new Error(`Expected public response string ${key}`);
}

async function staging(app: Reference, path: string, method = 'GET', body?: unknown) {
  return app.app.request(path, {
    method,
    headers: { authorization: `Bearer ${adapterToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createUser(app: Reference, runId: string, role: string): Promise<User> {
  const fixtureMarker = `SYNTHETIC_PRIVATE_FIXTURE_${runId}_${role}`;
  const created = await staging(app, '/staging/users', 'POST', { runId, operationId: `${runId}_create_${role}`, fixtureMarker });
  expect(created.status).toBe(201);
  const receipt: unknown = await created.json();
  const principalId = textField(receipt, 'principalId');
  expect(receipt).toEqual({ principalId, runId, fixtureMarker });
  const session = await staging(app, `/staging/users/${principalId}/session`, 'POST', { runId });
  expect(session.status).toBe(200);
  const sessionReceipt: unknown = await session.json();
  const cookie = textField(sessionReceipt, 'cookie');
  expect(cookie).toMatch(/^pp_session=[^;\s]+$/);
  return { principalId, fixtureMarker, cookie };
}

function lifecycleEvent(
  scenario: Exclude<Scenario, 'SC01'>,
  identity: { runId: string; customerId: string; subscriptionId: string },
) {
  const canceled = scenario === 'SC04';
  return {
    id: `evt_${identity.runId}_${scenario}`,
    type: scenario === 'SC02' ? 'customer.subscription.created' : canceled ? 'customer.subscription.deleted' : 'customer.subscription.updated',
    livemode: false,
    created: scenario === 'SC02' ? startedBillingTime : canceled ? periodEnd + 1 : startedBillingTime + 100,
    data: { object: {
      id: identity.subscriptionId, object: 'subscription', livemode: false,
      customer: identity.customerId, metadata: { runId: identity.runId },
      status: canceled ? 'canceled' : 'active', cancel_at_period_end: scenario !== 'SC02',
      items: { data: [{ price: { id: priceId, livemode: false }, current_period_end: periodEnd }], has_more: false },
      latest_invoice: {
        id: `in_${identity.runId}_creation`, livemode: false, status: 'paid', billing_reason: 'subscription_create',
        customer: identity.customerId, parent: { subscription_details: { subscription: identity.subscriptionId } },
      },
    } },
  };
}

async function replay(app: Reference, payload: unknown, validSignature = true) {
  const raw = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1_000);
  const digest = createHmac('sha256', validSignature ? replaySecret : 'SYNTHETIC_WRONG_SIGNER')
    .update(`${timestamp}.${raw}`).digest('hex');
  return app.app.request('/staging/replay', {
    method: 'POST', body: raw,
    headers: {
      authorization: `Bearer ${adapterToken}`, 'content-type': 'application/json',
      'stripe-signature': `t=${timestamp},v1=${digest}`,
    },
  });
}

// This oracle snapshot is constructed from the independent synthetic lifecycle
// definition above. It never copies the application's stored status or plan.
function expectedBilling(scenario: Scenario, identity: { customerId: string; subscriptionId: string }) {
  if (scenario === 'SC01') {
    return { livemode: false, identityResolved: true, noSubscriptionConfirmed: true, customerId: null, subscription: null };
  }
  return {
    livemode: false, identityResolved: true, noSubscriptionConfirmed: false, customerId: identity.customerId,
    subscription: {
      id: identity.subscriptionId, customerId: identity.customerId, priceId,
      status: scenario === 'SC04' ? 'canceled' : 'active', initialInvoicePaid: true,
      cancelAtPeriodEnd: scenario !== 'SC02', periodEnd,
      billingTime: scenario === 'SC04' ? periodEnd + 1 : scenario === 'SC03' ? startedBillingTime + 100 : startedBillingTime,
    },
  };
}

async function collectScenario(
  app: Reference,
  store: EvidenceStore,
  policy: ReturnType<typeof createPolicy>,
  scenarioId: Scenario,
  user: User,
  identity: { runId: string; customerId: string; subscriptionId: string },
) {
  const notBefore = Date.now();
  const description = await staging(app, '/staging/describe');
  expect(description.status).toBe(200);
  expect(await description.json()).toMatchObject({ buildId, environment: 'test', feature });

  const applicationResponse = await staging(app, `/staging/users/${user.principalId}/billing?runId=${identity.runId}`);
  expect(applicationResponse.status).toBe(200);
  const applicationPayload: unknown = await applicationResponse.json();
  const applicationObservedAt = Date.now();

  // No adapter Authorization header participates in this protected-feature call.
  const apiResponse = await app.app.request('/api/export', { headers: { cookie: user.cookie } });
  const apiBody: unknown = await apiResponse.json();
  const apiObservedAt = Date.now();
  const metadata = {
    runId: identity.runId, scenarioId, subjectId: user.principalId, policyHash: policy.hash,
    targetBuild: buildId, mode: 'local_replay',
    billingTime: scenarioId === 'SC01' ? null : scenarioId === 'SC04' ? periodEnd + 1 : scenarioId === 'SC03' ? startedBillingTime + 100 : startedBillingTime,
  };

  const stripe = await store.record({ ...metadata, source: 'stripe', observedAt: Date.now(), payload: expectedBilling(scenarioId, identity) });
  const application = await store.record({ ...metadata, source: 'application', observedAt: applicationObservedAt, payload: applicationPayload });
  const api = await store.record({
    ...metadata, source: 'api_probe', observedAt: apiObservedAt,
    payload: { status: apiResponse.status, body: apiBody, transportError: false, denialStatuses: [403] },
  });
  // Explicit unavailable-browser sentinel authorized for this API-only slice.
  // It must keep the browser assertion inconclusive and cannot prove a run pass.
  const browser = await store.record({
    ...metadata, source: 'browser', observedAt: Date.now(),
    payload: { status: null, body: null, transportError: true, denialStatuses: [403] },
  });
  const result = await evaluateEvidence(store, {
    runId: identity.runId, scenarioId, subjectId: user.principalId, policy, targetBuild: buildId, mode: 'local_replay',
    fixtureMarker: user.fixtureMarker, stripeId: stripe.id, applicationId: application.id, apiId: api.id, browserId: browser.id,
    now: Date.now(), notBefore,
  });
  expect(result.browser.verdict).toBe('inconclusive');
  expect([...result.observationIds].sort()).toEqual([stripe.id, application.id, api.id, browser.id].sort());
  for (const observation of [stripe, application, api, browser]) {
    expect(observation).toMatchObject({ runId: identity.runId, scenarioId, subjectId: user.principalId, mode: 'local_replay' });
  }
  return { result, apiStatus: apiResponse.status, apiBody, apiObservationId: api.id };
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  directory = mkdtempSync(join(tmpdir(), 'paywallproof-independent-vertical-'));
});

afterEach(async () => {
  if (reference) await reference.close();
  if (evidence) await evidence.close();
  reference = undefined;
  evidence = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('vertical reference/evidence acceptance: actual HTTP plus synthetic billing', () => {
  it.each<FaultMode>(['none', 'missing_guard', 'missing_activation', 'missing_cancellation'])('runs fresh SC01–SC04 fixtures with fault mode %s', async (faultMode) => {
    const unique = randomUUID().replaceAll('-', '');
    const identity = { runId: `run_${unique}`, customerId: `cus_${unique}`, subscriptionId: `sub_${unique}` };
    reference = createReferenceApp({
      databasePath: join(directory, 'reference.sqlite'), stagingEnabled: true, adapterToken, replaySecret, webhookSecret,
      priceId, buildId, faultMode,
    });
    evidence = new EvidenceStore(join(directory, 'evidence.sqlite'));
    const policy = createPolicy({
      schemaVersion: 1, priceId, featureId: 'pro_export',
      featureConfigHash: createHash('sha256').update(JSON.stringify(feature)).digest('hex'),
      cancellation: 'allow_until_period_end', requireInitialInvoicePaid: true, syncWindowSeconds: 60,
      predicateVersion: 'reference-export-v1',
    });
    const free = await createUser(reference, identity.runId, 'free');
    const subscriber = await createUser(reference, identity.runId, 'subscriber');
    expect(free.principalId).not.toBe(subscriber.principalId);
    expect(free.fixtureMarker).not.toBe(subscriber.fixtureMarker);
    expect(free.cookie).not.toBe(subscriber.cookie);

    const unauthenticated = await reference.app.request('/api/export', { headers: { authorization: `Bearer ${adapterToken}` } });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({ error: 'AUTHENTICATION_REQUIRED' });

    const collected: { scenario: Scenario; result: Evaluation }[] = [];
    const freeResult = await collectScenario(reference, evidence, policy, 'SC01', free, identity);
    collected.push({ scenario: 'SC01', result: freeResult.result });
    expect(freeResult.result.state.verdict).toBe('pass');
    if (faultMode === 'missing_guard') {
      expect(freeResult.apiStatus).toBe(200);
      expect(freeResult.apiBody).toEqual({ fixtureMarker: free.fixtureMarker });
      expect(freeResult.result.api.verdict).toBe('fail');
    } else {
      expect(freeResult.apiStatus).toBe(403);
      expect(freeResult.apiBody).toEqual({ error: 'ACCESS_DENIED' });
      expect(freeResult.result.api.verdict).toBe('pass');
    }

    const linked = await staging(reference, `/staging/users/${subscriber.principalId}/customer`, 'POST', { runId: identity.runId, customerId: identity.customerId });
    expect(linked.status).toBe(200);
    const badSignature = await replay(reference, lifecycleEvent('SC02', identity), false);
    expect(badSignature.status).toBe(400);
    const afterRejectedSignature = await staging(reference, `/staging/users/${subscriber.principalId}/billing?runId=${identity.runId}`);
    expect(await afterRejectedSignature.json()).toMatchObject({ status: 'none', initialInvoicePaid: false });

    const apiObservationIds = [freeResult.apiObservationId];
    for (const scenario of ['SC02', 'SC03', 'SC04'] as const) {
      const response = await replay(reference, lifecycleEvent(scenario, identity));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ mode: 'local_replay' });
      const observed = await collectScenario(reference, evidence, policy, scenario, subscriber, identity);
      collected.push({ scenario, result: observed.result });
      apiObservationIds.push(observed.apiObservationId);

      if (faultMode === 'none') {
        expect(observed.result.api.verdict).toBe('pass');
        expect(observed.result.state.verdict).toBe('pass');
        if (scenario === 'SC04') {
          expect(observed.apiStatus).toBe(403);
          expect(observed.apiBody).toEqual({ error: 'ACCESS_DENIED' });
        } else {
          expect(observed.apiStatus).toBe(200);
          expect(observed.apiBody).toEqual({ fixtureMarker: subscriber.fixtureMarker });
        }
      }
      if (faultMode === 'missing_activation' && scenario === 'SC02') {
        expect(observed.apiStatus).toBe(403);
        expect(observed.result.api.verdict).toBe('fail');
      }
      if (faultMode === 'missing_cancellation' && scenario === 'SC04') {
        expect(observed.apiStatus).toBe(200);
        expect(observed.apiBody).toEqual({ fixtureMarker: subscriber.fixtureMarker });
        expect(observed.result.api.verdict).toBe('fail');
      }
    }
    expect(collected.map((entry) => entry.scenario)).toEqual(['SC01', 'SC02', 'SC03', 'SC04']);
    expect(new Set(apiObservationIds).size).toBe(4);
    expect((await evidence.list(identity.runId)).length).toBe(16);

    const outcome = aggregateVerdicts(collected.flatMap(({ result }) => [result.api.verdict, result.browser.verdict, result.state.verdict]));
    if (faultMode === 'none') expect(outcome).toBe('inconclusive');
    else expect(outcome).toBe('failed');

    // Reopening keeps the collected, redacted actual HTTP observations. It does
    // not rerun lifecycle events or create a second user/session/subscription.
    const storedApi = await evidence.get(freeResult.apiObservationId);
    await evidence.close();
    evidence = new EvidenceStore(join(directory, 'evidence.sqlite'));
    expect(await evidence.get(freeResult.apiObservationId)).toEqual(storedApi);
  }, 20_000);
});
