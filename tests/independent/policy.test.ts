import { describe, expect, it } from 'vitest';
import { aggregateVerdicts, createPolicy, evaluateProbe, expectedAccess } from '#domain';

// Independent specification tests. Inputs are synthetic; no provider was contacted.
// Source of expectations: PRD.md and docs/public-contracts.md, version 1.

const marker = 'run-fixture-unique-7b51';

// Vitest treats array rows as argument lists. Wrap values so array-shaped inputs
// are exercised as one argument rather than accidentally destructured.
function singleCases<T>(cases: readonly T[]): [T][] {
  return cases.map((value): [T] => [value]);
}

function policyInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    priceId: 'price_pro',
    featureId: 'pro_export',
    featureConfigHash: 'a'.repeat(64),
    cancellation: 'allow_until_period_end',
    requireInitialPaymentConfirmed: true,
    syncWindowSeconds: 60,
    predicateVersion: 'export-v1',
    ...overrides,
  };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_owned',
    customerId: 'cus_owned',
    priceId: 'price_pro',
    status: 'active',
    initialPaymentConfirmed: true,
    cancelAtPeriodEnd: false,
    periodEnd: 2_000,
    billingTime: 1_000,
    ...overrides,
  };
}

function billing(overrides: Record<string, unknown> = {}) {
  return {
    livemode: false,
    identityResolved: true,
    noSubscriptionConfirmed: false,
    customerId: 'cus_owned',
    subscription: subscription(),
    ...overrides,
  };
}

function accessFor(observation: unknown) {
  return expectedAccess({ policy: createPolicy(policyInput()), billing: observation });
}

function expectUnknown(observation: unknown) {
  const result = accessFor(observation);
  expect(result).toMatchObject({ kind: 'unknown', code: expect.any(String) });
}

function probeInput(
  expected: unknown = { kind: 'deny' },
  overrides: Record<string, unknown> = {},
  fixtureMarker: unknown = marker,
) {
  return {
    expected,
    probe: {
      status: 403,
      body: { error: 'ACCESS_DENIED' },
      transportError: false,
      denialStatuses: [401, 403],
      ...overrides,
    },
    fixtureMarker,
  };
}

function expectProbe(input: unknown, verdict: string) {
  expect(evaluateProbe(input)).toMatchObject({ verdict, code: expect.any(String) });
}

describe('independent contract: immutable policy creation', () => {
  it('preserves the approved fields and returns a lowercase SHA-256-shaped hash', () => {
    const input = policyInput();
    const result = createPolicy(input);
    expect(result).toEqual({ ...input, hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('hashes equivalent fields independently of input key order', () => {
    const input = policyInput();
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    expect(createPolicy(input).hash).toBe(createPolicy(reversed).hash);
    expect(createPolicy(input).hash).toBe(createPolicy(input).hash);
  });

  it.each<[string, unknown]>([
    ['priceId', 'price_other'],
    ['featureId', 'other_export'],
    ['featureConfigHash', 'b'.repeat(64)],
    ['syncWindowSeconds', 61],
    ['predicateVersion', 'export-v2'],
  ])('binds the hash to %s', (field, value) => {
    expect(createPolicy(policyInput({ [field]: value })).hash).not.toBe(
      createPolicy(policyInput()).hash,
    );
  });

  it.each([5, 60, 300])('accepts the synchronization window %s', (seconds) => {
    expect(createPolicy(policyInput({ syncWindowSeconds: seconds })).syncWindowSeconds).toBe(
      seconds,
    );
  });

  it('does not let mutations of its input change the approved policy', () => {
    const input = policyInput();
    const policy = createPolicy(input);
    const before = { ...policy };
    input.priceId = 'price_replaced';
    input.featureConfigHash = 'c'.repeat(64);
    expect(policy).toEqual(before);
    expect(expectedAccess({ policy, billing: billing() })).toEqual({ kind: 'allow' });
  });

  it('does not let callers mutate an approved policy or its hash', () => {
    const policy = createPolicy(policyInput());
    const before = { ...policy };
    for (const change of [
      { priceId: 'price_replaced' },
      { hash: '0'.repeat(64) },
      { featureConfigHash: 'c'.repeat(64) },
      { syncWindowSeconds: 5 },
    ]) {
      try {
        Object.assign(policy, change);
      } catch {
        // Throwing or refusing mutation is acceptable; changing the policy is not.
      }
      expect(policy).toEqual(before);
    }
    expect(expectedAccess({ policy, billing: billing() })).toEqual({ kind: 'allow' });
  });

  it.each<[string, unknown]>([
    ['schemaVersion', 1],
    ['schemaVersion', '1'],
    ['cancellation', 'deny_immediately'],
    ['requireInitialPaymentConfirmed', false],
    ['syncWindowSeconds', 4],
    ['syncWindowSeconds', 301],
    ['syncWindowSeconds', 5.5],
    ['syncWindowSeconds', '60'],
    ['syncWindowSeconds', NaN],
    ['syncWindowSeconds', Infinity],
    ['syncWindowSeconds', null],
    ['syncWindowSeconds', undefined],
    ['featureConfigHash', 'A'.repeat(64)],
    ['featureConfigHash', 'a'.repeat(63)],
    ['featureConfigHash', 'g'.repeat(64)],
    ['featureConfigHash', ` ${'a'.repeat(64)}`],
    ['hash', '0'.repeat(64)],
    ['unexpected', true],
    ['constructor', 'untrusted'],
  ])('rejects invalid or unapproved policy field %s = %s', (field, value) => {
    expect(() => createPolicy(policyInput({ [field]: value }))).toThrow();
  });

  for (const field of ['priceId', 'featureId', 'predicateVersion']) {
    it.each(singleCases(['', ' ', ' padded', 'padded ', '\tvalue', 'value\n', 1, null, false, []]))(
      `rejects an invalid ${field}: %s`,
      (value) => expect(() => createPolicy(policyInput({ [field]: value }))).toThrow(),
    );
  }

  it.each(Object.keys(policyInput()))('rejects a missing policy field %s', (field) => {
    const input: Record<string, unknown> = policyInput();
    delete input[field];
    expect(() => createPolicy(input)).toThrow();
  });

  it.each(singleCases([null, undefined, [], 'policy', 1, true]))(
    'rejects a nonrecord input: %s',
    (input) => {
      expect(() => createPolicy(input)).toThrow();
    },
  );
});

describe('independent contract: expected access', () => {
  it.each([null, 'cus_owned'])('denies a confirmed free user with customer %s', (customerId) => {
    expect(
      accessFor(billing({ customerId, subscription: null, noSubscriptionConfirmed: true })),
    ).toEqual({ kind: 'deny' });
  });

  it('allows an active matching subscription with a paid initial invoice', () => {
    expect(accessFor(billing())).toEqual({ kind: 'allow' });
  });

  it('keeps scheduled cancellation authorized before the boundary', () => {
    expect(
      accessFor(
        billing({ subscription: subscription({ cancelAtPeriodEnd: true, billingTime: 1_999 }) }),
      ),
    ).toEqual({ kind: 'allow' });
  });

  it.each([2_000, 2_001, Number.MAX_SAFE_INTEGER])(
    'does not assume cancellation from an active subscription at time %s',
    (billingTime) =>
      expectUnknown(
        billing({ subscription: subscription({ cancelAtPeriodEnd: true, billingTime }) }),
      ),
  );

  it.each([true, false])(
    'denies confirmed cancellation even with invoice paid = %s',
    (initialPaymentConfirmed) => {
      expect(
        accessFor(
          billing({ subscription: subscription({ status: 'canceled', initialPaymentConfirmed }) }),
        ),
      ).toEqual({ kind: 'deny' });
    },
  );

  it('does not invent a paid entitlement for an active unpaid subscription', () => {
    expectUnknown(billing({ subscription: subscription({ initialPaymentConfirmed: false }) }));
  });

  it.each([
    'trialing',
    'past_due',
    'unpaid',
    'incomplete',
    'incomplete_expired',
    'paused',
    'deleted',
    'ACTIVE',
    'future_status',
  ])('keeps unsupported subscription status %s unknown', (status) =>
    expectUnknown(billing({ subscription: subscription({ status }) })),
  );

  it.each([null, 'cus_owned'])(
    'requires confirmation before treating missing subscription as free: %s',
    (customerId) => {
      expectUnknown(billing({ customerId, subscription: null, noSubscriptionConfirmed: false }));
    },
  );

  for (const status of ['active', 'canceled']) {
    it.each<[string, Record<string, unknown>]>([
      ['live mode', { livemode: true }],
      ['unresolved identity', { identityResolved: false }],
      ['contradictory absence', { noSubscriptionConfirmed: true }],
      ['missing customer mapping', { customerId: null }],
      ['wrong customer mapping', { customerId: 'cus_other' }],
    ])(`gives %s precedence over ${status} status`, (_label, change) => {
      expectUnknown(billing({ subscription: subscription({ status }), ...change }));
    });

    it(`gives wrong price precedence over ${status} status`, () => {
      expectUnknown(billing({ subscription: subscription({ status, priceId: 'price_other' }) }));
    });
  }

  it.each([{ livemode: true }, { identityResolved: false }])(
    'does not turn unsafe free-user evidence into a denial',
    (change) =>
      expectUnknown(billing({ subscription: null, noSubscriptionConfirmed: true, ...change })),
  );

  it.each([0, Number.MAX_SAFE_INTEGER])('accepts valid safe-integer time %s', (time) => {
    expect(
      accessFor(billing({ subscription: subscription({ periodEnd: time, billingTime: time }) })),
    ).toEqual({ kind: 'allow' });
  });

  for (const field of ['periodEnd', 'billingTime']) {
    it.each([
      -1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '1000',
      null,
      undefined,
    ])(`rejects structurally invalid ${field}: %s`, (value) =>
      expect(() =>
        accessFor(billing({ subscription: subscription({ [field]: value }) })),
      ).toThrow(),
    );
  }

  for (const field of ['id', 'customerId', 'priceId']) {
    it.each(['', ' ', ' padded', 'padded ', 1, null, undefined])(
      `rejects invalid subscription ${field}: %s`,
      (value) =>
        expect(() =>
          accessFor(billing({ subscription: subscription({ [field]: value }) })),
        ).toThrow(),
    );
  }

  it.each(['', ' ', ' padded', 'padded ', 1, false])(
    'rejects invalid billing customerId: %s',
    (customerId) => {
      expect(() => accessFor(billing({ customerId }))).toThrow();
    },
  );

  it.each<[string, unknown]>([
    ['livemode', 'false'],
    ['identityResolved', 1],
    ['noSubscriptionConfirmed', null],
    ['subscription', []],
    ['subscription', 'active'],
    ['extra', 'unapproved'],
  ])('rejects malformed billing field %s', (field, value) => {
    expect(() => accessFor(billing({ [field]: value }))).toThrow();
  });

  it.each<[string, unknown]>([
    ['status', null],
    ['status', 1],
    ['initialPaymentConfirmed', 'true'],
    ['cancelAtPeriodEnd', 1],
    ['extra', true],
  ])('rejects malformed subscription field %s', (field, value) => {
    expect(() => accessFor(billing({ subscription: subscription({ [field]: value }) }))).toThrow();
  });

  it.each(Object.keys(billing()))('rejects missing billing field %s', (field) => {
    const candidate: Record<string, unknown> = billing();
    delete candidate[field];
    expect(() => accessFor(candidate)).toThrow();
  });

  it.each(Object.keys(subscription()))('rejects missing subscription field %s', (field) => {
    const candidate: Record<string, unknown> = subscription();
    delete candidate[field];
    expect(() => accessFor(billing({ subscription: candidate }))).toThrow();
  });

  it('rejects unknown evaluator envelope and policy fields', () => {
    const policy = createPolicy(policyInput());
    expect(() => expectedAccess({ policy, billing: billing(), override: 'allow' })).toThrow();
    expect(() =>
      expectedAccess({ policy: { ...policy, override: true }, billing: billing() }),
    ).toThrow();
  });

  it.each(singleCases([null, undefined, [], 'snapshot']))(
    'rejects a malformed evaluator envelope: %s',
    (input) => {
      expect(() => expectedAccess(input)).toThrow();
    },
  );

  it('does not mutate the supplied billing snapshot', () => {
    const snapshot = billing();
    const before = JSON.stringify(snapshot);
    accessFor(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

describe('independent contract: verdict aggregation', () => {
  it('does not mistake zero assertions for a successful run', () => {
    expect(aggregateVerdicts([])).toBe('inconclusive');
  });

  it.each([1, 2, 10_000])('passes a nonempty collection of %s passes', (count) => {
    expect(aggregateVerdicts(Array.from({ length: count }, () => 'pass'))).toBe('passed');
  });

  it.each(['inconclusive', 'unsupported', 'skipped'])(
    'does not hide a required %s assertion among passes',
    (verdict) => {
      expect(aggregateVerdicts([verdict])).toBe('inconclusive');
      expect(aggregateVerdicts(['pass', verdict, 'pass'])).toBe('inconclusive');
    },
  );

  it.each(['pass', 'inconclusive', 'unsupported', 'skipped', 'fail'])(
    'failure takes precedence over %s in either order',
    (verdict) => {
      expect(aggregateVerdicts(['fail', verdict])).toBe('failed');
      expect(aggregateVerdicts([verdict, 'fail'])).toBe('failed');
    },
  );

  it('finds a failure late in a large local collection', () => {
    expect(aggregateVerdicts([...Array.from({ length: 10_000 }, () => 'pass'), 'fail'])).toBe(
      'failed',
    );
  });

  it.each(singleCases(['passed', 'failed', '', 'PASS', null, undefined, 0, {}, []]))(
    'rejects invalid verdict %s even when another verdict already failed',
    (invalid) => {
      expect(() => aggregateVerdicts([invalid])).toThrow();
      expect(() => aggregateVerdicts(['fail', invalid])).toThrow();
    },
  );

  it.each([null, undefined, 'pass', {}, 1, true, new Set(['pass'])])(
    'rejects nonarray input %s',
    (input) => expect(() => aggregateVerdicts(input)).toThrow(),
  );

  it('rejects an array hole as a missing verdict', () => {
    const verdicts = Array(2);
    verdicts[0] = 'pass';
    expect(() => aggregateVerdicts(verdicts)).toThrow();
  });
});

describe('independent contract: protected feature probe', () => {
  it('passes exact protected output for an allowed user', () => {
    expectProbe(
      probeInput({ kind: 'allow' }, { status: 200, body: { fixtureMarker: marker } }),
      'pass',
    );
  });

  it.each([401, 403])('passes an approved %s denial for a denied user', (status) => {
    expectProbe(probeInput({ kind: 'deny' }, { status }), 'pass');
  });

  it('fails a trustworthy denial to an allowed user', () => {
    expectProbe(probeInput({ kind: 'allow' }), 'fail');
  });

  it('fails protected access for a denied user', () => {
    expectProbe(
      probeInput({ kind: 'deny' }, { status: 200, body: { fixtureMarker: marker } }),
      'fail',
    );
  });

  const leakBodies = [
    { fixtureMarker: marker },
    { error: 'ACCESS_DENIED', data: { nested: [null, { value: `prefix${marker}suffix` }] } },
    { error: 'ACCESS_DENIED', [`prefix${marker}suffix`]: false },
    { error: 'ACCESS_DENIED', data: [{ [marker]: null }] },
    [0, false, marker],
    `prefix${marker}suffix`,
  ];
  for (const status of [100, 200, 302, 401, 403, 500, 599]) {
    it.each(singleCases(leakBodies))(
      `fails leaked data at HTTP ${status}, regardless of response shape`,
      (body) => {
        expectProbe(probeInput({ kind: 'deny' }, { status, body }), 'fail');
      },
    );
  }

  it('finds decoded markers containing escaped characters in both values and keys', () => {
    const escapedMarker = 'fixture"quoted\nline\\path';
    const valueBody = JSON.parse(
      JSON.stringify({ error: 'ACCESS_DENIED', nested: [`prefix${escapedMarker}suffix`] }),
    );
    const keyBody = JSON.parse(
      JSON.stringify({
        error: 'ACCESS_DENIED',
        nested: { [`prefix${escapedMarker}suffix`]: null },
      }),
    );
    expectProbe(probeInput({ kind: 'deny' }, { body: valueBody }, escapedMarker), 'fail');
    expectProbe(probeInput({ kind: 'deny' }, { body: keyBody }, escapedMarker), 'fail');
  });

  it('does not treat a similar but nonmatching marker as leaked protected data', () => {
    expectProbe(
      probeInput({ kind: 'deny' }, { body: { error: 'ACCESS_DENIED', note: marker.slice(0, -1) } }),
      'pass',
    );
  });

  it.each(
    singleCases([
      {},
      { error: 'SERVER_ERROR' },
      { fixtureMarker: 'another-run' },
      { fixtureMarker: `prefix${marker}` },
      { nested: { fixtureMarker: marker } },
      '<html>success</html>',
      null,
      true,
      123,
      [marker],
    ]),
  )('does not infer successful allowance from an unexpected HTTP 200 body', (body) => {
    expectProbe(probeInput({ kind: 'allow' }, { status: 200, body }), 'inconclusive');
  });

  it.each([201, 204, 302, 403, 500])('requires HTTP 200 for allowance, not %s', (status) => {
    expectProbe(
      probeInput({ kind: 'allow' }, { status, body: { fixtureMarker: marker } }),
      'inconclusive',
    );
  });

  it.each(
    singleCases([
      {},
      { error: 'ACCESS_DENIED ' },
      { error: 'FORBIDDEN' },
      { error: true },
      'ACCESS_DENIED',
      null,
      false,
      0,
      [{ error: 'ACCESS_DENIED' }],
    ]),
  )('does not infer trustworthy denial from an unexpected body', (body) => {
    expectProbe(probeInput({ kind: 'deny' }, { body }), 'inconclusive');
  });

  it.each([100, 200, 302, 402, 404, 500, 599])(
    'requires an approved denial status, not %s',
    (status) => {
      expectProbe(probeInput({ kind: 'deny' }, { status }), 'inconclusive');
    },
  );

  it('honors a valid configured denial status instead of hardcoding 401/403', () => {
    expectProbe(probeInput({ kind: 'deny' }, { status: 418, denialStatuses: [418] }), 'pass');
  });

  for (const body of [{ fixtureMarker: marker }, { error: 'ACCESS_DENIED', leak: marker }]) {
    it('keeps unknown expectations inconclusive even when a marker is present', () => {
      expectProbe(
        probeInput({ kind: 'unknown', code: 'IDENTITY_UNRESOLVED' }, { status: 200, body }),
        'inconclusive',
      );
    });

    it('keeps transport errors inconclusive even when a marker is present', () => {
      expectProbe(probeInput({ kind: 'deny' }, { transportError: true, body }), 'inconclusive');
    });
  }

  it('keeps unknown expectations inconclusive on an otherwise valid denial', () => {
    expectProbe(probeInput({ kind: 'unknown', code: 'UNSUPPORTED_STATUS' }), 'inconclusive');
  });

  it('keeps transport errors inconclusive on an otherwise valid allowance', () => {
    expectProbe(
      probeInput(
        { kind: 'allow' },
        { transportError: true, status: 200, body: { fixtureMarker: marker } },
      ),
      'inconclusive',
    );
  });

  it('allows an absent HTTP status only for an explicit transport failure', () => {
    expectProbe(
      probeInput({ kind: 'deny' }, { transportError: true, status: null, body: null }),
      'inconclusive',
    );
    expect(() =>
      evaluateProbe(
        probeInput({ kind: 'deny' }, { transportError: false, status: null, body: null }),
      ),
    ).toThrow();
  });

  it.each([99, 600, 200.5, NaN, Infinity, '200', null, undefined])(
    'rejects invalid HTTP status %s',
    (status) => {
      expect(() => evaluateProbe(probeInput({ kind: 'deny' }, { status }))).toThrow();
    },
  );

  it.each(
    singleCases([
      [],
      [403, 403],
      [399],
      [500],
      [200],
      [403.5],
      ['403'],
      [NaN],
      [Infinity],
      null,
      '403',
    ]),
  )('rejects invalid denialStatuses %s', (denialStatuses) => {
    expect(() => evaluateProbe(probeInput({ kind: 'deny' }, { denialStatuses }))).toThrow();
  });

  it.each([400, 499])('accepts the 4xx denial-list boundary %s', (status) => {
    expectProbe(probeInput({ kind: 'deny' }, { status, denialStatuses: [status] }), 'pass');
  });

  it.each(['', ' ', ' padded', 'padded ', '\tvalue', 'value\n', null, undefined, 1, false])(
    'rejects invalid fixture marker %s',
    (fixtureMarker) => {
      expect(() => evaluateProbe({ ...probeInput(), fixtureMarker })).toThrow();
    },
  );

  it.each([
    null,
    {},
    { kind: 'maybe' },
    { kind: 'unknown' },
    { kind: 'unknown', code: 1 },
    { kind: 'allow', code: 'extra' },
  ])('rejects malformed expected access %s', (expected) => {
    expect(() => evaluateProbe(probeInput(expected))).toThrow();
  });

  it('rejects unknown fields outside the arbitrary JSON body', () => {
    expect(() => evaluateProbe({ ...probeInput(), extra: true })).toThrow();
    expect(() => evaluateProbe(probeInput({ kind: 'deny', extra: true }))).toThrow();
    expect(() => evaluateProbe(probeInput({ kind: 'deny' }, { extra: true }))).toThrow();
    expectProbe(
      probeInput({ kind: 'deny' }, { body: { error: 'ACCESS_DENIED', extra: true } }),
      'pass',
    );
  });

  it.each(['expected', 'probe', 'fixtureMarker'])(
    'rejects missing probe-envelope field %s',
    (field) => {
      const input: Record<string, unknown> = probeInput();
      delete input[field];
      expect(() => evaluateProbe(input)).toThrow();
    },
  );

  it.each(['status', 'body', 'transportError', 'denialStatuses'])(
    'rejects missing probe field %s',
    (field) => {
      const input = probeInput();
      const probe: Record<string, unknown> = { ...input.probe };
      delete probe[field];
      expect(() => evaluateProbe({ ...input, probe })).toThrow();
    },
  );

  it.each(singleCases([null, undefined, [], 'probe', false]))(
    'rejects malformed probe envelope %s',
    (input) => {
      expect(() => evaluateProbe(input)).toThrow();
    },
  );

  it.each([null, 0, 'false', undefined])(
    'rejects nonboolean transportError %s',
    (transportError) => {
      expect(() => evaluateProbe(probeInput({ kind: 'deny' }, { transportError }))).toThrow();
    },
  );

  it.each([undefined, NaN, Infinity, -Infinity, () => marker, Symbol('body'), BigInt(1)])(
    'rejects non-JSON scalar bodies',
    (body) => expect(() => evaluateProbe(probeInput({ kind: 'deny' }, { body }))).toThrow(),
  );

  it.each(
    singleCases([
      { nested: undefined },
      { nested: NaN },
      { nested: Infinity },
      { nested: () => marker },
      { nested: Symbol('value') },
      [undefined],
    ]),
  )('rejects non-JSON values nested inside a body', (body) => {
    expect(() => evaluateProbe(probeInput({ kind: 'deny' }, { body }))).toThrow();
  });

  it('rejects direct and indirect cycles', () => {
    const direct: Record<string, unknown> = {};
    direct.self = direct;
    const indirect: unknown[] = [];
    indirect.push({ child: indirect });
    for (const body of [direct, indirect]) {
      expect(() => evaluateProbe(probeInput({ kind: 'deny' }, { body }))).toThrow();
    }
  });

  it('rejects class instances even when their visible fields look valid', () => {
    class Denial {
      error = 'ACCESS_DENIED';
    }
    for (const body of [new Denial(), new Date(0), /denied/, new Map(), new Set()]) {
      expect(() => evaluateProbe(probeInput({ kind: 'deny' }, { body }))).toThrow();
    }
  });

  it('rejects accessor properties', () => {
    const body = { error: 'ACCESS_DENIED' };
    Object.defineProperty(body, 'data', { enumerable: true, get: () => marker });
    expect(() => evaluateProbe(probeInput({ kind: 'deny' }, { body }))).toThrow();
  });

  it('rejects symbol properties rather than ignoring them', () => {
    for (const enumerable of [true, false]) {
      const body = { error: 'ACCESS_DENIED' };
      Object.defineProperty(body, Symbol('hidden'), { enumerable, value: marker });
      expect(() => evaluateProbe(probeInput({ kind: 'deny' }, { body }))).toThrow();
    }
  });

  it('rejects bodies whose toJSON function would hide protected data', () => {
    const body = {
      error: 'ACCESS_DENIED',
      secret: marker,
      toJSON: () => ({ error: 'ACCESS_DENIED' }),
    };
    expect(() => evaluateProbe(probeInput({ kind: 'deny' }, { body }))).toThrow();
  });

  it('accepts shallow JSON nesting and rejects nesting well beyond 32 levels', () => {
    function nested(depth: number) {
      let result: unknown = 'harmless';
      for (let i = 0; i < depth; i += 1) result = { child: result };
      return { error: 'ACCESS_DENIED', nested: result };
    }
    expectProbe(probeInput({ kind: 'deny' }, { body: nested(12) }), 'pass');
    expect(() => evaluateProbe(probeInput({ kind: 'deny' }, { body: nested(40) }))).toThrow();
  });

  it('still validates malformed structure when the expectation is unknown', () => {
    expect(() =>
      evaluateProbe(probeInput({ kind: 'unknown', code: 'UNKNOWN' }, { body: undefined })),
    ).toThrow();
  });
});
