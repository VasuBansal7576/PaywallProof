import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPolicy } from '#domain';
import { EvidenceStore, evaluateEvidence, redact } from '#evidence';
import { observeScenario } from '#evidence/probe';

// Independent public-boundary tests. Every payload and secret is synthetic.
// Stored browser payloads here are test inputs, not proof of browser execution.

type Source = 'billing_provider' | 'application' | 'api_probe' | 'browser';
type EvidenceIds = { providerId: string; applicationId: string; apiId: string; browserId: string };
type Evaluation = Awaited<ReturnType<typeof evaluateEvidence>>;
const sourceSlots: [Source, keyof EvidenceIds][] = [
  ['billing_provider', 'providerId'],
  ['application', 'applicationId'],
  ['api_probe', 'apiId'],
  ['browser', 'browserId'],
];
const observedNow = 1_800_000_000_000;
const fixtureMarker = 'fixture_for_owned_run_42';
let directory: string;
let path: string;
const stores = new Set<EvidenceStore>();

function singleCases<T>(cases: readonly T[]): [T][] {
  return cases.map((value): [T] => [value]);
}

// Construct recognizable credential shapes from explicitly synthetic test data.
// No value is obtained from a provider, environment variable, or credential file.
function credentialCanary(prefixParts: string[], suffixLength: number) {
  const suffix = 'SYNTHETIC0123456789'.repeat(3).slice(0, suffixLength);
  return `${prefixParts.join('_')}_${suffix}`;
}

function approvedPolicy(syncWindowSeconds = 60) {
  return createPolicy({
    schemaVersion: 2,
    priceId: 'price_pro',
    featureId: 'export',
    featureConfigHash: 'a'.repeat(64),
    cancellation: 'allow_until_period_end',
    requireInitialPaymentConfirmed: true,
    syncWindowSeconds,
    predicateVersion: 'export-v1',
  });
}

function open(secrets: string[] = []) {
  const store = new EvidenceStore(path, secrets);
  stores.add(store);
  return store;
}

async function close(store: EvidenceStore) {
  await store.close();
  stores.delete(store);
}

function stripePayload(overrides: Record<string, unknown> = {}) {
  return {
    livemode: false,
    identityResolved: true,
    noSubscriptionConfirmed: false,
    customerId: 'cus_owned',
    subscription: {
      id: 'sub_owned',
      customerId: 'cus_owned',
      priceId: 'price_pro',
      status: 'active',
      initialPaymentConfirmed: true,
      cancelAtPeriodEnd: false,
      periodEnd: 2_000,
      billingTime: 1_000,
    },
    ...overrides,
  };
}

function applicationPayload(overrides: Record<string, unknown> = {}) {
  return {
    principalId: 'user_owned',
    runId: 'run_owned',
    customerId: 'cus_owned',
    status: 'active',
    buildId: 'build_owned',
    ...overrides,
  };
}

function probePayload(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: { fixtureMarker },
    transportError: false,
    denialStatuses: [401, 403],
    ...overrides,
  };
}

function observationInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run_owned',
    scenarioId: 'SC02',
    subjectId: 'user_owned',
    source: 'billing_provider',
    policyHash: approvedPolicy().hash,
    targetBuild: 'build_owned',
    observedAt: observedNow,
    billingTime: 1_000,
    mode: 'local_replay',
    payload: stripePayload(),
    ...overrides,
  };
}

async function collect(
  store: EvidenceStore,
  changes: Partial<Record<Source, Record<string, unknown>>> = {},
  metadata: Record<string, unknown> = {},
) {
  const defaults: Record<Source, unknown> = {
    billing_provider: stripePayload(),
    application: applicationPayload(),
    api_probe: probePayload(),
    browser: probePayload(),
  };
  const ids: EvidenceIds = { providerId: '', applicationId: '', apiId: '', browserId: '' };
  for (const [source, slot] of sourceSlots) {
    const record = await store.record(
      observationInput({ source, payload: defaults[source], ...metadata, ...changes[source] }),
    );
    ids[slot] = record.id;
  }
  return ids;
}

function evaluationInput(ids: EvidenceIds, overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run_owned',
    scenarioId: 'SC02',
    subjectId: 'user_owned',
    policy: approvedPolicy(),
    targetBuild: 'build_owned',
    mode: 'local_replay',
    fixtureMarker,
    ...ids,
    now: observedNow,
    notBefore: observedNow - 10_000,
    ...overrides,
  };
}

function expectAllInconclusive(result: Evaluation) {
  for (const key of ['api', 'browser', 'state'] as const) {
    expect(result[key]).toMatchObject({ verdict: 'inconclusive', code: expect.any(String) });
  }
}

function mutate(record: unknown, changes: object) {
  if (typeof record === 'object' && record !== null) {
    try {
      Object.assign(record, changes);
    } catch {
      /* Frozen outputs are also acceptable. */
    }
  }
}

async function expectInvalid(action: () => unknown) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'paywallproof-independent-evidence-'));
  path = join(directory, 'evidence.sqlite');
});

afterEach(async () => {
  for (const store of stores) await close(store);
  rmSync(directory, { recursive: true, force: true });
});

describe('independent evidence: redaction', () => {
  it.each([
    'authorization',
    'cookie',
    'set-cookie',
    'password',
    'secret',
    'token',
    'apiKey',
    'api_key',
    'webhookSecret',
    'webhook_secret',
    'email',
    'access_token',
    'refresh_token',
    'AUTHORIZATION',
    'Cookie',
    'PASSWORD',
    'APIKEY',
    'WebHook_Secret',
  ])('redacts sensitive key %s without changing the original', (key) => {
    const canary = 'SYNTHETIC_KEY_VALUE_CANARY_9942';
    const input = { nested: [{ [key]: canary }], ordinary: 'preserve-me' };
    const before = JSON.stringify(input);
    const output = redact(input);
    expect(JSON.stringify(output)).not.toContain(canary);
    expect(JSON.stringify(output)).toContain('preserve-me');
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    credentialCanary(['sk', 'test'], 35),
    credentialCanary(['sk', 'live'], 35),
    credentialCanary(['rk', 'test'], 35),
    credentialCanary(['rk', 'live'], 35),
    credentialCanary(['whsec'], 35),
    credentialCanary(['ghp'], 44),
    credentialCanary(['github', 'pat'], 44),
    ['Bearer', 'SYNTHETIC_BEARER_CREDENTIAL'].join(' '),
    ['Basic', Buffer.from('SYNTHETIC:CANARY').toString('base64')].join(' '),
    'synthetic-canary@example.invalid',
  ])('removes credentials embedded in ordinary text: %s', (canary) => {
    const input = { notes: [`prefix ${canary} suffix`], harmless: 'unchanged' };
    const before = JSON.stringify(input);
    const output = redact(input);
    expect(JSON.stringify(output)).not.toContain(canary);
    expect(JSON.stringify(output)).toContain('unchanged');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('redacts supplied literal canaries in both nested keys and string values', () => {
    const canary = 'SYNTHETIC_LITERAL_4477';
    const input = {
      [`prefix_${canary}_suffix`]: { nested: [`start${canary}end`, { [canary]: true }] },
    };
    const before = JSON.stringify(input);
    expect(JSON.stringify(redact(input, [canary]))).not.toContain(canary);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('treats supplied secrets as literals rather than regular expressions', () => {
    const canary = 'SYNTHETIC.a+b[0](x)?';
    const output = redact({ text: `before ${canary} after`, safe: 'SYNTHETICZaab0x' }, [canary]);
    expect(JSON.stringify(output)).not.toContain(canary);
    expect(JSON.stringify(output)).toContain('SYNTHETICZaab0x');
  });

  it('ignores an empty literal and returns a detached harmless JSON tree', () => {
    const input = { data: [{ label: 'safe', count: 2 }], nullValue: null, allowed: true };
    const output = redact(input, ['']);
    expect(output).toEqual(input);
    mutate(output, { data: 'changed' });
    expect(input.data).toEqual([{ label: 'safe', count: 2 }]);
  });
});

describe('independent evidence: authoritative storage', () => {
  it('persists immutable observations and hashes across reopen', async () => {
    const store = open();
    const input = observationInput({ payload: { nested: { value: 'original' } } });
    const record = await store.record(input);
    expect(record).toMatchObject({
      ...input,
      id: expect.any(String),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(statSync(path).isFile()).toBe(true);
    const before = JSON.stringify(await store.get(record.id));
    mutate(input.payload, { nested: { value: 'mutated-input' } });
    mutate(record, { source: 'browser', sha256: '0'.repeat(64) });
    mutate(record.payload, { nested: { value: 'mutated-output' } });
    expect(JSON.stringify(await store.get(record.id))).toBe(before);
    await close(store);
    const reopened = open();
    expect(JSON.stringify(await reopened.get(record.id))).toBe(before);
  });

  it('creates new IDs rather than replacing previous observations', async () => {
    const store = open();
    const original = await store.record(observationInput({ payload: { value: 'first' } }));
    const later = await store.record(observationInput({ payload: { value: 'second' } }));
    expect(later.id).not.toBe(original.id);
    expect((await store.get(original.id)).payload).toEqual({ value: 'first' });
    expect((await store.get(later.id)).payload).toEqual({ value: 'second' });
    await expectInvalid(() => store.record({ ...observationInput(), id: original.id }));
    await expectInvalid(() => store.record({ ...observationInput(), sha256: '0'.repeat(64) }));
  });

  it('lists only the requested run and returns detached list records', async () => {
    const store = open();
    const owned = await store.record(observationInput());
    await store.record(observationInput({ runId: 'another_run' }));
    const records = await store.list('run_owned');
    expect(records.map((record) => record.id)).toEqual([owned.id]);
    mutate(records[0], { runId: 'another_run' });
    expect((await store.list('run_owned')).map((record) => record.id)).toEqual([owned.id]);
  });

  it('stores and later returns only redacted payloads', async () => {
    const canary = 'SYNTHETIC_PERSISTED_CANARY_9021';
    const store = open([canary]);
    const record = await store.record(
      observationInput({
        payload: { [`prefix_${canary}`]: `value_${canary}`, password: 'SYNTHETIC_PASSWORD_456' },
      }),
    );
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('SYNTHETIC_PASSWORD_456');
    await close(store);
    const reopened = open();
    expect(await reopened.get(record.id)).toEqual(record);
    expect(JSON.stringify(await reopened.list('run_owned'))).not.toContain(canary);
  });

  it.each<[string, unknown]>([
    ['scenarioId', 'SC99'],
    ['source', 'model'],
    ['mode', 'production'],
    ['payload', undefined],
    ['observedAt', 'now'],
    ['observedAt', NaN],
    ['extra', true],
  ])('rejects malformed observation field %s', async (field, value) => {
    const store = open();
    await expectInvalid(() => store.record(observationInput({ [field]: value })));
    expect(await store.list('run_owned')).toEqual([]);
  });

  it('rejects non-JSON payloads, cycles, accessors, classes, and excessive nesting', async () => {
    const store = open();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 'canary' });
    class CustomPayload {
      value = 'canary';
    }
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    for (const payload of [
      cycle,
      accessor,
      new CustomPayload(),
      deep,
      { value: Infinity },
      { value: undefined },
      { value: () => 'code' },
    ]) {
      await expectInvalid(() => store.record(observationInput({ payload })));
    }
    expect(await store.list('run_owned')).toEqual([]);
  });
});

describe('independent evidence: evaluation and state drift', () => {
  it.each(['local_replay', 'polar_sandbox'])(
    'passes a coherent synthetic %s evidence set',
    async (mode) => {
      const store = open();
      const ids = await collect(store, {}, { mode });
      const result = await evaluateEvidence(store, evaluationInput(ids, { mode }));
      expect(result).toMatchObject({
        api: { verdict: 'pass' },
        browser: { verdict: 'pass' },
        state: { verdict: 'pass' },
      });
      expect([...result.observationIds].sort()).toEqual(Object.values(ids).sort());
    },
  );

  it('keeps stale application state separate from correct canceled-user access', async () => {
    const store = open();
    const canceled = stripePayload();
    canceled.subscription.status = 'canceled';
    const denial = probePayload({ status: 403, body: { error: 'ACCESS_DENIED' } });
    const ids = await collect(store, {
      billing_provider: { payload: canceled },
      application: { payload: applicationPayload({ status: 'active' }) },
      api_probe: { payload: denial },
      browser: { payload: denial },
    });
    const result = await evaluateEvidence(store, evaluationInput(ids));
    expect(result).toMatchObject({
      api: { verdict: 'pass' },
      browser: { verdict: 'pass' },
      state: { verdict: 'fail', code: 'STATE_DRIFT' },
    });
  });

  it('does not let a correct application label hide an actual canceled-user leak', async () => {
    const store = open();
    const canceled = stripePayload();
    canceled.subscription.status = 'canceled';
    const ids = await collect(store, {
      billing_provider: { payload: canceled },
      application: { payload: applicationPayload({ status: 'canceled' }) },
    });
    expect(await evaluateEvidence(store, evaluationInput(ids))).toMatchObject({
      api: { verdict: 'fail' },
      browser: { verdict: 'fail' },
      state: { verdict: 'pass' },
    });
  });

  it('evaluates browser and API behavior separately', async () => {
    const store = open();
    const ids = await collect(store, {
      browser: { payload: probePayload({ status: 403, body: { error: 'ACCESS_DENIED' } }) },
    });
    expect(await evaluateEvidence(store, evaluationInput(ids))).toMatchObject({
      api: { verdict: 'pass' },
      browser: { verdict: 'fail' },
      state: { verdict: 'pass' },
    });
  });

  it('accepts a confirmed free user with null customer mapping and none status', async () => {
    const store = open();
    const denial = probePayload({ status: 403, body: { error: 'ACCESS_DENIED' } });
    const ids = await collect(
      store,
      {
        billing_provider: {
          payload: stripePayload({
            noSubscriptionConfirmed: true,
            customerId: null,
            subscription: null,
          }),
        },
        application: { payload: applicationPayload({ customerId: null, status: 'none' }) },
        api_probe: { payload: denial },
        browser: { payload: denial },
      },
      { scenarioId: 'SC01' },
    );
    expect(
      await evaluateEvidence(store, evaluationInput(ids, { scenarioId: 'SC01' })),
    ).toMatchObject({
      api: { verdict: 'pass' },
      browser: { verdict: 'pass' },
      state: { verdict: 'pass' },
    });
  });

  it.each(
    singleCases([
      null,
      {},
      { principalId: 'user_owned' },
      applicationPayload({ principalId: null }),
      applicationPayload({ customerId: 'cus_other' }),
      applicationPayload({ runId: 'another_run' }),
      applicationPayload({ buildId: 'different_build' }),
      applicationPayload({ principalId: 'different_user' }),
    ]),
  )('makes malformed or mismatched application identity inconclusive', async (payload) => {
    const store = open();
    const ids = await collect(store, { application: { payload } });
    expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
  });

  it.each(['principalId', 'runId', 'customerId', 'status', 'buildId'])(
    'requires application field %s',
    async (field) => {
      const store = open();
      const payload: Record<string, unknown> = applicationPayload();
      delete payload[field];
      const ids = await collect(store, { application: { payload } });
      expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
    },
  );

  it.each([{ livemode: true }, { identityResolved: false }, { noSubscriptionConfirmed: true }])(
    'cannot evaluate access from an unknown billing expectation',
    async (change) => {
      const store = open();
      const ids = await collect(store, { billing_provider: { payload: stripePayload(change) } });
      expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
    },
  );

  it('does not turn an unsupported subscription state into denial', async () => {
    const store = open();
    const stripe = stripePayload();
    stripe.subscription.status = 'trialing';
    const ids = await collect(store, {
      billing_provider: { payload: stripe },
      application: { payload: applicationPayload({ status: 'trialing' }) },
    });
    expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
  });
});

describe('independent evidence: provenance and freshness', () => {
  for (const [source, slot] of sourceSlots) {
    it(`cannot pass when the ${source} observation is missing`, async () => {
      const store = open();
      const ids = await collect(store);
      expectAllInconclusive(
        await evaluateEvidence(store, evaluationInput(ids, { [slot]: 'missing_observation' })),
      );
    });

    it.each<[string, unknown]>([
      ['runId', 'foreign_run'],
      ['scenarioId', 'SC03'],
      ['subjectId', 'foreign_user'],
      ['policyHash', 'b'.repeat(64)],
      ['targetBuild', 'foreign_build'],
      ['mode', 'polar_sandbox'],
    ])(`rejects ${source} evidence with the wrong %s`, async (field, value) => {
      const store = open();
      const ids = await collect(store, { [source]: { [field]: value } });
      expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
    });

    it(`rejects a wrong source recorded for ${source}`, async () => {
      const store = open();
      const ids = await collect(store, {
        [source]: { source: source === 'billing_provider' ? 'application' : 'billing_provider' },
      });
      expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
    });

    it.each([observedNow - 10_001, observedNow + 1])(
      `rejects ${source} evidence outside the current 10-second window`,
      async (observedAt) => {
        const store = open();
        const ids = await collect(store, { [source]: { observedAt } });
        expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
      },
    );

    it(`rejects fresh ${source} evidence collected before the allowed cycle`, async () => {
      const store = open();
      const ids = await collect(store, { [source]: { observedAt: observedNow - 1_001 } });
      expectAllInconclusive(
        await evaluateEvidence(store, evaluationInput(ids, { notBefore: observedNow - 1_000 })),
      );
    });
  }

  it.each([observedNow - 10_000, observedNow])(
    'accepts the inclusive freshness boundary %s',
    async (observedAt) => {
      const store = open();
      const ids = await collect(store, {}, { observedAt });
      expect(await evaluateEvidence(store, evaluationInput(ids))).toMatchObject({
        api: { verdict: 'pass' },
        browser: { verdict: 'pass' },
        state: { verdict: 'pass' },
      });
    },
  );

  it('does not substitute the API observation for independent browser evidence', async () => {
    const store = open();
    const ids = await collect(store);
    expectAllInconclusive(
      await evaluateEvidence(store, evaluationInput(ids, { browserId: ids.apiId })),
    );
  });

  it('does not promote local replay observations into a sandbox run', async () => {
    const store = open();
    const ids = await collect(store);
    expectAllInconclusive(
      await evaluateEvidence(store, evaluationInput(ids, { mode: 'polar_sandbox' })),
    );
  });

  it('rejects replacement payloads or model-authored outcomes at the evaluator boundary', async () => {
    const store = open();
    const ids = await collect(store);
    await expectInvalid(() =>
      evaluateEvidence(store, { ...evaluationInput(ids), billing_provider: stripePayload() }),
    );
    await expectInvalid(() =>
      evaluateEvidence(store, { ...evaluationInput(ids), outcome: 'passed' }),
    );
  });

  it('re-evaluates only persisted observations after restart', async () => {
    const store = open();
    const ids = await collect(store);
    const before = await evaluateEvidence(store, evaluationInput(ids));
    await close(store);
    const reopened = open();
    expect(await evaluateEvidence(reopened, evaluationInput(ids))).toEqual(before);
  });
});

type ProbeOptions = Parameters<typeof observeScenario>[0];
type ProbeScenario = ProbeOptions['scenarioId'];
type ProbeBilling = Awaited<ReturnType<ProbeOptions['billing']>>;
type ProbeChannel = 'api' | 'browser' | 'state';
type ProbeVerdict = Evaluation['api']['verdict'];
const probeChannels: ProbeChannel[] = ['api', 'browser', 'state'];

function probeClock() {
  let time = observedNow;
  const waits: number[] = [];
  return {
    now: () => time,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    wait: async (milliseconds: number) => {
      expect(Number.isFinite(milliseconds)).toBe(true);
      expect(milliseconds).toBeGreaterThan(0);
      waits.push(milliseconds);
      time += milliseconds;
      if (time > observedNow + 500_000 || waits.length > 10_000)
        throw new Error('Synthetic timing harness bound exceeded');
    },
    waits,
  };
}

function scenarioBilling(scenarioId: ProbeScenario): ProbeBilling {
  if (scenarioId === 'SC01')
    return {
      livemode: false,
      identityResolved: true,
      noSubscriptionConfirmed: true,
      customerId: null,
      subscription: null,
    };
  return {
    livemode: false,
    identityResolved: true,
    noSubscriptionConfirmed: false,
    customerId: 'cus_synthetic_probe',
    subscription: {
      id: 'sub_synthetic_probe',
      customerId: 'cus_synthetic_probe',
      priceId: 'price_pro',
      status: scenarioId === 'SC04' ? 'canceled' : 'active',
      initialPaymentConfirmed: true,
      cancelAtPeriodEnd: scenarioId === 'SC03',
      periodEnd: 2_000,
      billingTime: scenarioId === 'SC04' ? 2_000 : 1_000,
    },
  };
}

function subscriptionChange(
  scenarioId: ProbeScenario,
  change: Partial<NonNullable<ProbeBilling['subscription']>>,
): ProbeBilling {
  const billing = scenarioBilling(scenarioId);
  if (!billing.subscription) throw new Error('Synthetic subscription fixture required');
  return { ...billing, subscription: { ...billing.subscription, ...change } };
}

function syntheticEvaluation(
  label: string,
  changes: Partial<Pick<Evaluation, ProbeChannel>> = {},
): Evaluation {
  return {
    api: { verdict: 'pass', code: 'SYNTHETIC_API_PASS' },
    browser: { verdict: 'pass', code: 'SYNTHETIC_BROWSER_PASS' },
    state: { verdict: 'pass', code: 'SYNTHETIC_STATE_PASS' },
    observationIds: sourceSlots.map(([source]) => `synthetic_${label}_${source}`),
    ...changes,
  };
}

function allSynthetic(verdict: ProbeVerdict, label: string): Evaluation {
  return syntheticEvaluation(label, {
    api: { verdict, code: 'SYNTHETIC_API_RESULT' },
    browser: { verdict, code: 'SYNTHETIC_BROWSER_RESULT' },
    state: { verdict, code: 'SYNTHETIC_STATE_RESULT' },
  });
}

async function postBoundaryResult(first: Evaluation, second: Evaluation) {
  const clock = probeClock();
  const boundary = observedNow + 60_000;
  const postCalls: { time: number; notBefore: number }[] = [];
  const result = await observeScenario({
    scenarioId: 'SC02',
    policy: approvedPolicy(),
    billing: async () => scenarioBilling('SC02'),
    now: clock.now,
    wait: clock.wait,
    collect: async (notBefore) => {
      if (clock.now() < boundary) {
        expect(notBefore).toBe(observedNow);
        return allSynthetic('inconclusive', 'within_window');
      }
      postCalls.push({ time: clock.now(), notBefore });
      if (postCalls.length > 2) throw new Error('Unexpected additional post-boundary collection');
      expect(notBefore).toBeGreaterThanOrEqual(boundary);
      expect(notBefore).toBeLessThanOrEqual(clock.now());
      return postCalls.length === 1 ? first : second;
    },
  });
  expect(clock.now()).toBeGreaterThanOrEqual(boundary);
  expect(postCalls).toHaveLength(2);
  for (const call of postCalls) expect(call.time).toBeGreaterThanOrEqual(boundary);
  for (const id of [...first.observationIds, ...second.observationIds])
    expect(result.observationIds).toContain(id);
  return result;
}

describe('independent shared probe: provider establishment and bounds', () => {
  it.each<ProbeScenario>(['SC01', 'SC02', 'SC03', 'SC04'])(
    'collects an established %s without waiting when every channel passes',
    async (scenarioId) => {
      const clock = probeClock();
      const candidate = syntheticEvaluation('early_success');
      const notBeforeValues: number[] = [];
      const result = await observeScenario({
        scenarioId,
        policy: approvedPolicy(),
        billing: async () => scenarioBilling(scenarioId),
        now: clock.now,
        wait: clock.wait,
        collect: async (notBefore) => {
          notBeforeValues.push(notBefore);
          return candidate;
        },
      });
      expect(result).toEqual(candidate);
      expect(notBeforeValues).toEqual([observedNow]);
      expect(clock.waits).toEqual([]);
    },
  );

  it.each<[ProbeScenario, string, ProbeBilling]>([
    [
      'SC01',
      'unconfirmed free state',
      { ...scenarioBilling('SC01'), noSubscriptionConfirmed: false },
    ],
    ['SC01', 'existing subscription', scenarioBilling('SC02')],
    [
      'SC02',
      'unpaid initial invoice',
      subscriptionChange('SC02', { initialPaymentConfirmed: false }),
    ],
    ['SC02', 'scheduled cancellation', subscriptionChange('SC02', { cancelAtPeriodEnd: true })],
    ['SC02', 'nonactive status', subscriptionChange('SC02', { status: 'past_due' })],
    ['SC03', 'unscheduled cancellation', subscriptionChange('SC03', { cancelAtPeriodEnd: false })],
    [
      'SC03',
      'unpaid initial invoice',
      subscriptionChange('SC03', { initialPaymentConfirmed: false }),
    ],
    ['SC03', 'period boundary already reached', subscriptionChange('SC03', { billingTime: 2_000 })],
    ['SC04', 'cancellation not confirmed', subscriptionChange('SC04', { status: 'active' })],
    ['SC04', 'billing time before boundary', subscriptionChange('SC04', { billingTime: 1_999 })],
  ])(
    'does not collect %s with %s until the provider confirms',
    async (scenarioId, _reason, pending) => {
      const clock = probeClock();
      const reads: number[] = [];
      const collected: number[] = [];
      await observeScenario({
        scenarioId,
        policy: approvedPolicy(),
        now: clock.now,
        wait: clock.wait,
        billing: async () => {
          reads.push(clock.now());
          return reads.length === 1 ? pending : scenarioBilling(scenarioId);
        },
        collect: async (notBefore) => {
          collected.push(clock.now());
          expect(notBefore).toBe(observedNow + 1_000);
          return syntheticEvaluation('established');
        },
      });
      expect(reads).toEqual([observedNow, observedNow + 1_000]);
      expect(collected).toEqual([observedNow + 1_000]);
    },
  );

  it('retries temporary provider errors and starts freshness at actual confirmation', async () => {
    const clock = probeClock();
    let reads = 0;
    await observeScenario({
      scenarioId: 'SC02',
      policy: approvedPolicy(),
      now: clock.now,
      wait: clock.wait,
      billing: async () => {
        reads += 1;
        if (reads < 3) throw new Error('Synthetic temporary provider rejection');
        return scenarioBilling('SC02');
      },
      collect: async (notBefore) => {
        expect(notBefore).toBe(observedNow + 2_000);
        return syntheticEvaluation('recovered');
      },
    });
    expect(reads).toBe(3);
    expect(clock.waits).toEqual([1_000, 1_000]);
  });

  it.each(['unestablished', 'unavailable'] as const)(
    'stops %s provider polling at exactly 90 seconds without collecting',
    async (kind) => {
      const clock = probeClock();
      const reads: number[] = [];
      let collected = 0;
      await expect(
        observeScenario({
          scenarioId: 'SC02',
          policy: approvedPolicy(),
          now: clock.now,
          wait: clock.wait,
          billing: async () => {
            reads.push(clock.now());
            if (kind === 'unavailable') throw new Error('Synthetic unavailable provider');
            return subscriptionChange('SC02', { initialPaymentConfirmed: false });
          },
          collect: async () => {
            collected += 1;
            return syntheticEvaluation('must_not_collect');
          },
        }),
      ).rejects.toMatchObject({
        code: kind === 'unavailable' ? 'PROVIDER_UNAVAILABLE' : 'SYNC_TIMEOUT',
      });
      expect(reads).toEqual(Array.from({ length: 91 }, (_, index) => observedNow + index * 1_000));
      expect(clock.now()).toBe(observedNow + 90_000);
      expect(collected).toBe(0);
    },
  );

  it('accepts provider confirmation exactly at the 90-second bound', async () => {
    const clock = probeClock();
    await observeScenario({
      scenarioId: 'SC02',
      policy: approvedPolicy(),
      now: clock.now,
      wait: clock.wait,
      billing: async () =>
        clock.now() < observedNow + 90_000
          ? subscriptionChange('SC02', { initialPaymentConfirmed: false })
          : scenarioBilling('SC02'),
      collect: async (notBefore) => {
        expect(notBefore).toBe(observedNow + 90_000);
        return syntheticEvaluation('at_provider_bound');
      },
    });
    expect(clock.now()).toBe(observedNow + 90_000);
  });

  it('rejects a provider read that returns established state after the 90-second bound', async () => {
    const clock = probeClock();
    let collected = 0;
    await expect(
      observeScenario({
        scenarioId: 'SC02',
        policy: approvedPolicy(),
        now: clock.now,
        wait: clock.wait,
        billing: async () => {
          clock.advance(90_001);
          return scenarioBilling('SC02');
        },
        collect: async () => {
          collected += 1;
          return syntheticEvaluation('late_provider');
        },
      }),
    ).rejects.toMatchObject({ code: 'SYNC_TIMEOUT' });
    expect(collected).toBe(0);
  });
});

describe('independent shared probe: full window and independent confirmation', () => {
  it.each([5, 60, 300])(
    'preserves the full approved %s-second window after provider confirmation',
    async (seconds) => {
      const clock = probeClock();
      const policy = approvedPolicy(seconds);
      const originalPolicy = JSON.stringify(policy);
      const confirmedAt = observedNow + 2_000;
      const boundary = confirmedAt + seconds * 1_000;
      const postIds: string[] = [];
      let postCount = 0;
      await observeScenario({
        scenarioId: 'SC02',
        policy,
        now: clock.now,
        wait: clock.wait,
        billing: async () =>
          clock.now() < confirmedAt
            ? subscriptionChange('SC02', { initialPaymentConfirmed: false })
            : scenarioBilling('SC02'),
        collect: async (notBefore) => {
          expect(clock.now()).toBeGreaterThanOrEqual(confirmedAt);
          if (clock.now() < boundary) {
            expect(notBefore).toBe(confirmedAt);
            return allSynthetic('fail', 'before_boundary');
          }
          postCount += 1;
          expect(notBefore).toBeGreaterThanOrEqual(boundary);
          expect(notBefore).toBeLessThanOrEqual(clock.now());
          const evaluation = allSynthetic('fail', `post_${postCount}`);
          postIds.push(...evaluation.observationIds);
          return evaluation;
        },
      }).then((result) => {
        expect(postCount).toBe(2);
        expect(result.api.verdict).toBe('fail');
        for (const id of postIds) expect(result.observationIds).toContain(id);
      });
      expect(clock.now()).toBeGreaterThanOrEqual(boundary);
      expect(JSON.stringify(policy)).toBe(originalPolicy);
    },
  );

  it.each<ProbeVerdict>(['fail', 'inconclusive', 'unsupported', 'skipped'])(
    'does not end the window early for %s evidence',
    async (verdict) => {
      const clock = probeClock();
      const boundary = observedNow + 60_000;
      let postCount = 0;
      const result = await observeScenario({
        scenarioId: 'SC02',
        policy: approvedPolicy(),
        now: clock.now,
        wait: clock.wait,
        billing: async () => scenarioBilling('SC02'),
        collect: async (notBefore) => {
          if (clock.now() >= boundary) {
            postCount += 1;
            expect(notBefore).toBeGreaterThanOrEqual(boundary);
            expect(notBefore).toBeLessThanOrEqual(clock.now());
          }
          return allSynthetic(verdict, `nonpass_${postCount}`);
        },
      });
      expect(clock.now()).toBeGreaterThanOrEqual(boundary);
      expect(postCount).toBe(2);
      for (const channel of probeChannels) expect(result[channel].verdict).toBe(verdict);
    },
  );

  it.each(probeChannels)('does not finish early when only %s lacks a pass', async (channel) => {
    const clock = probeClock();
    let calls = 0;
    const result = await observeScenario({
      scenarioId: 'SC02',
      policy: approvedPolicy(),
      now: clock.now,
      wait: clock.wait,
      billing: async () => scenarioBilling('SC02'),
      collect: async () => {
        calls += 1;
        return calls === 1
          ? syntheticEvaluation('one_missing', {
              [channel]: { verdict: 'inconclusive', code: 'SYNTHETIC_MISSING' },
            })
          : syntheticEvaluation('all_pass');
      },
    });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result).toEqual(syntheticEvaluation('all_pass'));
  });

  for (const channel of probeChannels) {
    it(`retains a repeated same-reason ${channel} failure`, async () => {
      const failure = { verdict: 'fail' as const, code: 'SYNTHETIC_STABLE_REASON' };
      const result = await postBoundaryResult(
        syntheticEvaluation('first', { [channel]: failure }),
        syntheticEvaluation('second', { [channel]: failure }),
      );
      expect(result[channel]).toEqual(failure);
      for (const other of probeChannels.filter((item) => item !== channel))
        expect(result[other].verdict).toBe('pass');
    });

    it(`does not combine different ${channel} failure reasons`, async () => {
      const first = syntheticEvaluation('first', {
        [channel]: { verdict: 'fail', code: 'SYNTHETIC_REASON_A' },
      });
      const second = syntheticEvaluation('second', {
        [channel]: { verdict: 'fail', code: 'SYNTHETIC_REASON_B' },
      });
      expect((await postBoundaryResult(first, second))[channel]).toEqual({
        verdict: 'inconclusive',
        code: 'UNSTABLE_CONTRADICTION',
      });
    });

    it.each<ProbeVerdict>(['pass', 'inconclusive', 'unsupported', 'skipped'])(
      `requires the first post-boundary ${channel} result to fail, not %s`,
      async (verdict) => {
        const first = syntheticEvaluation('first', {
          [channel]: { verdict, code: 'SYNTHETIC_SAME_CODE' },
        });
        const second = syntheticEvaluation('second', {
          [channel]: { verdict: 'fail', code: 'SYNTHETIC_SAME_CODE' },
        });
        expect((await postBoundaryResult(first, second))[channel]).toEqual({
          verdict: 'inconclusive',
          code: 'UNSTABLE_CONTRADICTION',
        });
      },
    );

    it.each<ProbeVerdict>(['pass', 'inconclusive', 'unsupported', 'skipped'])(
      `does not promote the second ${channel} %s into an earlier failure`,
      async (verdict) => {
        const first = syntheticEvaluation('first', {
          [channel]: { verdict: 'fail', code: 'SYNTHETIC_PREVIOUS_FAILURE' },
        });
        const current = { verdict, code: 'SYNTHETIC_CURRENT_RESULT' };
        const result = await postBoundaryResult(
          first,
          syntheticEvaluation('second', { [channel]: current }),
        );
        expect(result[channel]).toEqual(current);
      },
    );
  }

  it('compares channels independently without mutating either original evaluation', async () => {
    const first = syntheticEvaluation('immutable_first', {
      api: { verdict: 'fail', code: 'SYNTHETIC_API_STABLE' },
      browser: { verdict: 'fail', code: 'SYNTHETIC_BROWSER_A' },
    });
    const second = syntheticEvaluation('immutable_second', {
      api: { verdict: 'fail', code: 'SYNTHETIC_API_STABLE' },
      browser: { verdict: 'fail', code: 'SYNTHETIC_BROWSER_B' },
      state: { verdict: 'fail', code: 'STATE_DRIFT' },
    });
    const before = JSON.stringify([first, second]);
    for (const evaluation of [first, second]) {
      for (const channel of probeChannels) Object.freeze(evaluation[channel]);
      Object.freeze(evaluation.observationIds);
      Object.freeze(evaluation);
    }
    const result = await postBoundaryResult(first, second);
    expect(result).toMatchObject({
      api: { verdict: 'fail', code: 'SYNTHETIC_API_STABLE' },
      browser: { verdict: 'inconclusive', code: 'UNSTABLE_CONTRADICTION' },
      state: { verdict: 'inconclusive', code: 'UNSTABLE_CONTRADICTION' },
    });
    expect(JSON.stringify([first, second])).toBe(before);
  });
});

describe('independent shared probe: authorization and exception propagation', () => {
  it('rejects revoked authorization before any provider or feature call', async () => {
    const denied = new Error('Synthetic authorization revoked');
    let providerCalls = 0;
    let collections = 0;
    await expect(
      observeScenario({
        scenarioId: 'SC02',
        policy: approvedPolicy(),
        assertActive: async () => {
          throw denied;
        },
        billing: async () => {
          providerCalls += 1;
          return scenarioBilling('SC02');
        },
        collect: async () => {
          collections += 1;
          return syntheticEvaluation('unauthorized');
        },
      }),
    ).rejects.toBe(denied);
    expect(providerCalls).toBe(0);
    expect(collections).toBe(0);
  });

  it('does not swallow authorization revoked while polling as a provider error', async () => {
    const clock = probeClock();
    const denied = new Error('Synthetic polling authorization revoked');
    let providerCalls = 0;
    let collections = 0;
    await expect(
      observeScenario({
        scenarioId: 'SC02',
        policy: approvedPolicy(),
        now: clock.now,
        wait: clock.wait,
        assertActive: async () => {
          if (providerCalls > 0) throw denied;
        },
        billing: async () => {
          providerCalls += 1;
          throw new Error('Synthetic provider read rejection');
        },
        collect: async () => {
          collections += 1;
          return syntheticEvaluation('unauthorized');
        },
      }),
    ).rejects.toBe(denied);
    expect(providerCalls).toBe(1);
    expect(collections).toBe(0);
  });

  it.each([
    'after_provider',
    'during_window',
    'after_first_post',
    'after_second_post',
    'after_early_success',
  ] as const)('rechecks authorization %s', async (stage) => {
    const clock = probeClock();
    const denied = new Error(`Synthetic revoked ${stage}`);
    const boundary = observedNow + 60_000;
    let active = true;
    let collections = 0;
    let postCollections = 0;
    await expect(
      observeScenario({
        scenarioId: 'SC02',
        policy: approvedPolicy(),
        now: clock.now,
        wait: clock.wait,
        assertActive: async () => {
          if (!active) throw denied;
        },
        billing: async () => {
          if (stage === 'after_provider') active = false;
          return scenarioBilling('SC02');
        },
        collect: async () => {
          collections += 1;
          if (clock.now() >= boundary) postCollections += 1;
          if (stage === 'during_window' || stage === 'after_early_success') active = false;
          if (stage === 'after_first_post' && postCollections === 1) active = false;
          if (stage === 'after_second_post' && postCollections === 2) active = false;
          return allSynthetic(
            stage === 'after_early_success' ? 'pass' : 'fail',
            `auth_${collections}`,
          );
        },
      }),
    ).rejects.toBe(denied);
    if (stage === 'after_provider') expect(collections).toBe(0);
    if (stage === 'during_window' || stage === 'after_early_success') expect(collections).toBe(1);
    if (stage === 'after_first_post') expect(postCollections).toBe(1);
    if (stage === 'after_second_post') expect(postCollections).toBe(2);
  });

  it.each(['within_window', 'first_post', 'second_post'] as const)(
    'propagates a %s collection exception unchanged',
    async (stage) => {
      const clock = probeClock();
      const failure = new Error(`Synthetic collection exception ${stage}`);
      let postCollections = 0;
      await expect(
        observeScenario({
          scenarioId: 'SC02',
          policy: approvedPolicy(),
          now: clock.now,
          wait: clock.wait,
          billing: async () => scenarioBilling('SC02'),
          collect: async () => {
            if (clock.now() >= observedNow + 60_000) postCollections += 1;
            if (
              stage === 'within_window' ||
              (stage === 'first_post' && postCollections === 1) ||
              (stage === 'second_post' && postCollections === 2)
            )
              throw failure;
            return allSynthetic('inconclusive', `exception_${postCollections}`);
          },
        }),
      ).rejects.toBe(failure);
    },
  );
});
