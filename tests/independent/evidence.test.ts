import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPolicy } from '../../packages/core/src/index.ts';
import { EvidenceStore, evaluateEvidence, redact } from '../../packages/evidence/src/index.ts';

// Independent public-boundary tests. Every payload and secret is synthetic.
// Stored browser payloads here are test inputs, not proof of browser execution.

type Source = 'stripe' | 'application' | 'api_probe' | 'browser';
type EvidenceIds = { stripeId: string; applicationId: string; apiId: string; browserId: string };
type Evaluation = Awaited<ReturnType<typeof evaluateEvidence>>;
const sourceSlots: [Source, keyof EvidenceIds][] = [
  ['stripe', 'stripeId'], ['application', 'applicationId'], ['api_probe', 'apiId'], ['browser', 'browserId'],
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

function approvedPolicy() {
  return createPolicy({
    schemaVersion: 1, priceId: 'price_pro', featureId: 'export', featureConfigHash: 'a'.repeat(64),
    cancellation: 'allow_until_period_end', requireInitialInvoicePaid: true,
    syncWindowSeconds: 60, predicateVersion: 'export-v1',
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
    livemode: false, identityResolved: true, noSubscriptionConfirmed: false, customerId: 'cus_owned',
    subscription: {
      id: 'sub_owned', customerId: 'cus_owned', priceId: 'price_pro', status: 'active',
      initialInvoicePaid: true, cancelAtPeriodEnd: false, periodEnd: 2_000, billingTime: 1_000,
    },
    ...overrides,
  };
}

function applicationPayload(overrides: Record<string, unknown> = {}) {
  return { principalId: 'user_owned', runId: 'run_owned', customerId: 'cus_owned', status: 'active', buildId: 'build_owned', ...overrides };
}

function probePayload(overrides: Record<string, unknown> = {}) {
  return { status: 200, body: { fixtureMarker }, transportError: false, denialStatuses: [401, 403], ...overrides };
}

function observationInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run_owned', scenarioId: 'SC02', subjectId: 'user_owned', source: 'stripe',
    policyHash: approvedPolicy().hash, targetBuild: 'build_owned', observedAt: observedNow,
    billingTime: 1_000, mode: 'local_replay', payload: stripePayload(), ...overrides,
  };
}

async function collect(
  store: EvidenceStore,
  changes: Partial<Record<Source, Record<string, unknown>>> = {},
  metadata: Record<string, unknown> = {},
) {
  const defaults: Record<Source, unknown> = {
    stripe: stripePayload(), application: applicationPayload(), api_probe: probePayload(), browser: probePayload(),
  };
  const ids: EvidenceIds = { stripeId: '', applicationId: '', apiId: '', browserId: '' };
  for (const [source, slot] of sourceSlots) {
    const record = await store.record(observationInput({ source, payload: defaults[source], ...metadata, ...changes[source] }));
    ids[slot] = record.id;
  }
  return ids;
}

function evaluationInput(ids: EvidenceIds, overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run_owned', scenarioId: 'SC02', subjectId: 'user_owned', policy: approvedPolicy(),
    targetBuild: 'build_owned', mode: 'local_replay', fixtureMarker, ...ids,
    now: observedNow, notBefore: observedNow - 10_000, ...overrides,
  };
}

function expectAllInconclusive(result: Evaluation) {
  for (const key of ['api', 'browser', 'state'] as const) {
    expect(result[key]).toMatchObject({ verdict: 'inconclusive', code: expect.any(String) });
  }
}

function mutate(record: unknown, changes: object) {
  if (typeof record === 'object' && record !== null) {
    try { Object.assign(record, changes); } catch { /* Frozen outputs are also acceptable. */ }
  }
}

async function expectInvalid(action: () => unknown) {
  let caught: unknown;
  try { await action(); } catch (error) { caught = error; }
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
    'authorization', 'cookie', 'set-cookie', 'password', 'secret', 'token', 'apiKey', 'api_key',
    'webhookSecret', 'webhook_secret', 'email', 'access_token', 'refresh_token',
    'AUTHORIZATION', 'Cookie', 'PASSWORD', 'APIKEY', 'WebHook_Secret',
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
    const input = { [`prefix_${canary}_suffix`]: { nested: [`start${canary}end`, { [canary]: true }] } };
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
    expect(record).toMatchObject({ ...input, id: expect.any(String), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
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
    const record = await store.record(observationInput({ payload: { [`prefix_${canary}`]: `value_${canary}`, password: 'SYNTHETIC_PASSWORD_456' } }));
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('SYNTHETIC_PASSWORD_456');
    await close(store);
    const reopened = open();
    expect(await reopened.get(record.id)).toEqual(record);
    expect(JSON.stringify(await reopened.list('run_owned'))).not.toContain(canary);
  });

  it.each<[string, unknown]>([
    ['scenarioId', 'SC99'], ['source', 'model'], ['mode', 'production'], ['payload', undefined],
    ['observedAt', 'now'], ['observedAt', NaN], ['extra', true],
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
    class CustomPayload { value = 'canary'; }
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    for (const payload of [cycle, accessor, new CustomPayload(), deep, { value: Infinity }, { value: undefined }, { value: () => 'code' }]) {
      await expectInvalid(() => store.record(observationInput({ payload })));
    }
    expect(await store.list('run_owned')).toEqual([]);
  });
});

describe('independent evidence: evaluation and state drift', () => {
  it.each(['local_replay', 'stripe_sandbox'])('passes a coherent synthetic %s evidence set', async (mode) => {
    const store = open();
    const ids = await collect(store, {}, { mode });
    const result = await evaluateEvidence(store, evaluationInput(ids, { mode }));
    expect(result).toMatchObject({ api: { verdict: 'pass' }, browser: { verdict: 'pass' }, state: { verdict: 'pass' } });
    expect([...result.observationIds].sort()).toEqual(Object.values(ids).sort());
  });

  it('keeps stale application state separate from correct canceled-user access', async () => {
    const store = open();
    const canceled = stripePayload();
    canceled.subscription.status = 'canceled';
    const denial = probePayload({ status: 403, body: { error: 'ACCESS_DENIED' } });
    const ids = await collect(store, {
      stripe: { payload: canceled }, application: { payload: applicationPayload({ status: 'active' }) },
      api_probe: { payload: denial }, browser: { payload: denial },
    });
    const result = await evaluateEvidence(store, evaluationInput(ids));
    expect(result).toMatchObject({
      api: { verdict: 'pass' }, browser: { verdict: 'pass' }, state: { verdict: 'fail', code: 'STATE_DRIFT' },
    });
  });

  it('does not let a correct application label hide an actual canceled-user leak', async () => {
    const store = open();
    const canceled = stripePayload();
    canceled.subscription.status = 'canceled';
    const ids = await collect(store, {
      stripe: { payload: canceled }, application: { payload: applicationPayload({ status: 'canceled' }) },
    });
    expect(await evaluateEvidence(store, evaluationInput(ids))).toMatchObject({
      api: { verdict: 'fail' }, browser: { verdict: 'fail' }, state: { verdict: 'pass' },
    });
  });

  it('evaluates browser and API behavior separately', async () => {
    const store = open();
    const ids = await collect(store, { browser: { payload: probePayload({ status: 403, body: { error: 'ACCESS_DENIED' } }) } });
    expect(await evaluateEvidence(store, evaluationInput(ids))).toMatchObject({
      api: { verdict: 'pass' }, browser: { verdict: 'fail' }, state: { verdict: 'pass' },
    });
  });

  it('accepts a confirmed free user with null customer mapping and none status', async () => {
    const store = open();
    const denial = probePayload({ status: 403, body: { error: 'ACCESS_DENIED' } });
    const ids = await collect(store, {
      stripe: { payload: stripePayload({ noSubscriptionConfirmed: true, customerId: null, subscription: null }) },
      application: { payload: applicationPayload({ customerId: null, status: 'none' }) },
      api_probe: { payload: denial }, browser: { payload: denial },
    }, { scenarioId: 'SC01' });
    expect(await evaluateEvidence(store, evaluationInput(ids, { scenarioId: 'SC01' }))).toMatchObject({
      api: { verdict: 'pass' }, browser: { verdict: 'pass' }, state: { verdict: 'pass' },
    });
  });

  it.each(singleCases([null, {}, { principalId: 'user_owned' }, applicationPayload({ principalId: null }), applicationPayload({ customerId: 'cus_other' }), applicationPayload({ runId: 'another_run' }), applicationPayload({ buildId: 'different_build' }), applicationPayload({ principalId: 'different_user' })]))('makes malformed or mismatched application identity inconclusive', async (payload) => {
    const store = open();
    const ids = await collect(store, { application: { payload } });
    expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
  });

  it.each(['principalId', 'runId', 'customerId', 'status', 'buildId'])('requires application field %s', async (field) => {
    const store = open();
    const payload: Record<string, unknown> = applicationPayload();
    delete payload[field];
    const ids = await collect(store, { application: { payload } });
    expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
  });

  it.each([{ livemode: true }, { identityResolved: false }, { noSubscriptionConfirmed: true }])('cannot evaluate access from an unknown billing expectation', async (change) => {
    const store = open();
    const ids = await collect(store, { stripe: { payload: stripePayload(change) } });
    expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
  });

  it('does not turn an unsupported subscription state into denial', async () => {
    const store = open();
    const stripe = stripePayload();
    stripe.subscription.status = 'trialing';
    const ids = await collect(store, { stripe: { payload: stripe }, application: { payload: applicationPayload({ status: 'trialing' }) } });
    expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
  });
});

describe('independent evidence: provenance and freshness', () => {
  for (const [source, slot] of sourceSlots) {
    it(`cannot pass when the ${source} observation is missing`, async () => {
      const store = open();
      const ids = await collect(store);
      expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids, { [slot]: 'missing_observation' })));
    });

    it.each<[string, unknown]>([
      ['runId', 'foreign_run'], ['scenarioId', 'SC03'], ['subjectId', 'foreign_user'],
      ['policyHash', 'b'.repeat(64)], ['targetBuild', 'foreign_build'], ['mode', 'stripe_sandbox'],
    ])(`rejects ${source} evidence with the wrong %s`, async (field, value) => {
      const store = open();
      const ids = await collect(store, { [source]: { [field]: value } });
      expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
    });

    it(`rejects a wrong source recorded for ${source}`, async () => {
      const store = open();
      const ids = await collect(store, { [source]: { source: source === 'stripe' ? 'application' : 'stripe' } });
      expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
    });

    it.each([observedNow - 10_001, observedNow + 1])(`rejects ${source} evidence outside the current 10-second window`, async (observedAt) => {
      const store = open();
      const ids = await collect(store, { [source]: { observedAt } });
      expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids)));
    });

    it(`rejects fresh ${source} evidence collected before the allowed cycle`, async () => {
      const store = open();
      const ids = await collect(store, { [source]: { observedAt: observedNow - 1_001 } });
      expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids, { notBefore: observedNow - 1_000 })));
    });
  }

  it.each([observedNow - 10_000, observedNow])('accepts the inclusive freshness boundary %s', async (observedAt) => {
    const store = open();
    const ids = await collect(store, {}, { observedAt });
    expect(await evaluateEvidence(store, evaluationInput(ids))).toMatchObject({
      api: { verdict: 'pass' }, browser: { verdict: 'pass' }, state: { verdict: 'pass' },
    });
  });

  it('does not substitute the API observation for independent browser evidence', async () => {
    const store = open();
    const ids = await collect(store);
    expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids, { browserId: ids.apiId })));
  });

  it('does not promote local replay observations into a sandbox run', async () => {
    const store = open();
    const ids = await collect(store);
    expectAllInconclusive(await evaluateEvidence(store, evaluationInput(ids, { mode: 'stripe_sandbox' })));
  });

  it('rejects replacement payloads or model-authored outcomes at the evaluator boundary', async () => {
    const store = open();
    const ids = await collect(store);
    await expectInvalid(() => evaluateEvidence(store, { ...evaluationInput(ids), stripe: stripePayload() }));
    await expectInvalid(() => evaluateEvidence(store, { ...evaluationInput(ids), outcome: 'passed' }));
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
