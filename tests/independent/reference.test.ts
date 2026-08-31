import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReferenceApp } from '#reference';

// Real local HTTP handlers and SQLite; synthetic signed local_replay only.
// No live provider key, provider client, external HTTP request, or real secret is used.

type Target = ReturnType<typeof createReferenceApp>;
type User = { principalId: string; runId: string; fixtureMarker: string };
const adapterToken = 'SYNTHETIC_ADAPTER_SECRET_38472';
const webhookSecret = 'whsec_SYNTHETIC_REAL_ROUTE_SECRET_38472';
const replaySecret = 'whsec_SYNTHETIC_REPLAY_ROUTE_SECRET_38472';
const runId = 'run_owned';
const customerId = 'cus_local_owned';
const fixtureMarker = 'PRIVATE_SYNTHETIC_FIXTURE_FOR_OWNED_USER';
const buildId = 'build_reference_test';
let directory: string;
let databasePath: string;
const targets = new Set<Target>();

function options() {
  return {
    databasePath,
    stagingEnabled: true,
    adapterToken,
    webhookSecret,
    replaySecret,
    priceId: 'price_pro',
    buildId,
  };
}

function open(overrides: Record<string, unknown> = {}) {
  const target = createReferenceApp({ ...options(), ...overrides });
  targets.add(target);
  return target;
}

async function close(target: Target) {
  await target.close();
  targets.delete(target);
}

async function request(
  target: Target,
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return target.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${adapterToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body: unknown = await response.json();
  return body;
}

function field(value: unknown, key: string): string {
  if (typeof value === 'object' && value !== null) {
    const found: unknown = Reflect.get(value, key);
    if (typeof found === 'string') return found;
  }
  throw new Error(`Expected response string field ${key}`);
}

async function createUser(target: Target, overrides: Record<string, unknown> = {}): Promise<User> {
  const response = await request(target, '/staging/users', 'POST', {
    runId,
    operationId: 'create_user_one',
    fixtureMarker,
    ...overrides,
  });
  expect(response.status).toBe(201);
  const body = await json(response);
  return {
    principalId: field(body, 'principalId'),
    runId: field(body, 'runId'),
    fixtureMarker: field(body, 'fixtureMarker'),
  };
}

async function link(target: Target, user: User, id = customerId) {
  const response = await request(target, `/staging/users/${user.principalId}/customer`, 'POST', {
    runId: user.runId,
    customerId: id,
  });
  expect(response.status).toBe(200);
  return json(response);
}

async function session(target: Target, user: User) {
  const response = await request(target, `/staging/users/${user.principalId}/session`, 'POST', {
    runId: user.runId,
  });
  expect(response.status).toBe(200);
  const body = await json(response);
  return { cookie: field(body, 'cookie'), expiresAt: field(body, 'expiresAt') };
}

function event(
  eventChanges: Record<string, unknown> = {},
  subscriptionChanges: Record<string, unknown> = {},
) {
  return {
    id: 'evt_local_created',
    type: 'customer.subscription.created',
    livemode: false,
    created: 1_800_000_000,
    data: {
      object: {
        id: 'sub_local_owned',
        object: 'subscription',
        livemode: false,
        customer: customerId,
        metadata: { runId },
        status: 'active',
        cancel_at_period_end: false,
        items: {
          data: [
            { price: { id: 'price_pro', livemode: false }, current_period_end: 1_802_678_400 },
          ],
          has_more: false,
        },
        latest_invoice: {
          id: 'in_local_creation',
          livemode: false,
          status: 'paid',
          billing_reason: 'subscription_create',
          customer: customerId,
          parent: { subscription_details: { subscription: 'sub_local_owned' } },
        },
        ...subscriptionChanges,
      },
    },
    ...eventChanges,
  };
}

function signature(raw: string, secret = replaySecret, timestamp = Math.floor(Date.now() / 1_000)) {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

async function replay(target: Target, payload: unknown, extraHeaders: Record<string, string> = {}) {
  const raw = JSON.stringify(payload);
  return target.app.request('/staging/replay', {
    method: 'POST',
    body: raw,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adapterToken}`,
      'paywallproof-replay-signature': signature(raw),
      ...extraHeaders,
    },
  });
}

async function replayAccepted(target: Target, payload: unknown) {
  const response = await replay(target, payload);
  expect(response.status).toBe(200);
  const body = await json(response);
  expect(body).toMatchObject({ mode: 'local_replay' });
  return body;
}

async function ordinary(
  target: Target,
  path: string,
  cookie?: string,
  extra: Record<string, string> = {},
) {
  return target.app.request(path, {
    headers: { ...(cookie === undefined ? {} : { cookie }), ...extra },
  });
}

async function expectExport(
  target: Target,
  cookie: string | undefined,
  status: number,
  expectedMarker = fixtureMarker,
) {
  const response = await ordinary(target, '/api/export', cookie);
  expect(response.status).toBe(status);
  const body = await json(response);
  if (status === 200) expect(body).toEqual({ fixtureMarker: expectedMarker });
  else {
    expect(body).toEqual({ error: status === 401 ? 'AUTHENTICATION_REQUIRED' : 'ACCESS_DENIED' });
    expect(JSON.stringify(body)).not.toContain(expectedMarker);
  }
}

async function expectSafeError(response: Response, status?: number, code?: string) {
  if (status !== undefined) expect(response.status).toBe(status);
  else expect(response.status).toBeGreaterThanOrEqual(400);
  const body = await json(response);
  expect(body).toMatchObject({ error: code ?? expect.any(String) });
  for (const forbidden of [fixtureMarker, adapterToken, webhookSecret, replaySecret])
    expect(JSON.stringify(body)).not.toContain(forbidden);
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  directory = mkdtempSync(join(tmpdir(), 'paywallproof-independent-reference-'));
  databasePath = join(directory, 'reference.sqlite');
});

afterEach(async () => {
  for (const target of targets) await close(target);
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('independent reference: staging and ordinary-session separation', () => {
  it('describes the configured test adapter and real protected route', async () => {
    const target = open();
    const response = await request(target, '/staging/describe');
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      adapterVersion: '1',
      environment: 'test',
      buildId,
      billingTimeModel: 'provider_status',
      feature: {
        id: 'pro_export',
        method: 'GET',
        path: '/api/export',
        denialStatuses: [403],
        browserPath: '/dashboard',
        actionTestId: 'export-button',
        resultTestId: 'export-result',
      },
    });
  });

  it.each(['', 'Bearer WRONG_SYNTHETIC_TOKEN', `Basic ${adapterToken}`])(
    'rejects staging credential %s',
    async (authorization) => {
      const target = open();
      await expectSafeError(
        await request(target, '/staging/describe', 'GET', undefined, { authorization }),
        401,
      );
    },
  );

  it('never treats the adapter token as an ordinary user session', async () => {
    const target = open();
    await expectSafeError(
      await ordinary(target, '/api/export', undefined, { authorization: `Bearer ${adapterToken}` }),
      401,
      'AUTHENTICATION_REQUIRED',
    );
    await expectSafeError(
      await ordinary(target, '/api/me', undefined, { authorization: `Bearer ${adapterToken}` }),
      401,
    );
  });

  it('does not grant staging privileges to an ordinary session', async () => {
    const target = open();
    const user = await createUser(target);
    const current = await session(target, user);
    const response = await target.app.request('/staging/describe', {
      headers: { cookie: current.cookie },
    });
    await expectSafeError(response, 401);
  });

  it('hides all tested staging routes when staging is disabled', async () => {
    const target = open({ stagingEnabled: false });
    await expectSafeError(await request(target, '/staging/describe'), 404);
    await expectSafeError(
      await request(target, '/staging/users', 'POST', {
        runId,
        operationId: 'create',
        fixtureMarker,
      }),
      404,
    );
    await expectSafeError(await replay(target, event()), 404);
  });

  it('hides staging in production even when explicitly enabled with the correct token', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const target = open();
    await expectSafeError(await request(target, '/staging/describe'), 404);
    await expectSafeError(
      await request(target, '/staging/users', 'POST', {
        runId,
        operationId: 'create',
        fixtureMarker,
      }),
      404,
    );
    await expectSafeError(await replay(target, event()), 404);
  });

  it('issues a real-time ordinary cookie with a 15-minute expiry', async () => {
    const target = open();
    const user = await createUser(target);
    const before = Date.now();
    const current = await session(target, user);
    const after = Date.now();
    expect(current.cookie).toMatch(/^pp_session=[^;\s]+$/);
    // Permit ISO timestamps rounded to whole seconds without waiting 15 minutes.
    expect(Date.parse(current.expiresAt)).toBeGreaterThanOrEqual(before + 15 * 60 * 1_000 - 1_000);
    expect(Date.parse(current.expiresAt)).toBeLessThanOrEqual(after + 15 * 60 * 1_000);
    await expectExport(target, current.cookie, 403);
    await expectExport(target, undefined, 401);
    await expectExport(target, 'pp_session=FORGED_SYNTHETIC_SESSION', 401);
  });

  it('returns a free identity view without marker or credentials', async () => {
    const target = open();
    const user = await createUser(target);
    const current = await session(target, user);
    const response = await ordinary(target, '/api/me', current.cookie);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({
      principalId: user.principalId,
      plan: 'Free',
      canExport: false,
      subscriptionStatus: 'none',
      executionMode: 'none',
    });
    for (const secret of [fixtureMarker, current.cookie, adapterToken, webhookSecret, replaySecret])
      expect(JSON.stringify(body)).not.toContain(secret);
  });
});

describe('independent reference: fixture ownership, retries, and cleanup', () => {
  it('persists the same user-creation receipt across duplicate requests and reopen', async () => {
    const target = open();
    const user = await createUser(target);
    expect(await createUser(target)).toEqual(user);
    await close(target);
    const reopened = open();
    expect(await createUser(reopened)).toEqual(user);
  });

  it('rejects changed creation arguments for an existing operation', async () => {
    const target = open();
    await createUser(target);
    for (const change of [{ fixtureMarker: 'different_marker' }, { runId: 'different_run' }]) {
      await expectSafeError(
        await request(target, '/staging/users', 'POST', {
          runId,
          operationId: 'create_user_one',
          fixtureMarker,
          ...change,
        }),
        409,
        'OPERATION_CONFLICT',
      );
    }
  });

  it('links customers idempotently without granting entitlement', async () => {
    const target = open();
    const user = await createUser(target);
    const first = await link(target, user);
    expect(await link(target, user)).toEqual(first);
    const response = await request(
      target,
      `/staging/users/${user.principalId}/billing?runId=${runId}`,
    );
    expect(await json(response)).toMatchObject({
      principalId: user.principalId,
      runId,
      customerId,
      status: 'none',
      initialPaymentConfirmed: false,
    });
    await expectExport(target, (await session(target, user)).cookie, 403);
  });

  it('enforces one customer per principal and one principal per customer', async () => {
    const target = open();
    const first = await createUser(target);
    const second = await createUser(target, {
      operationId: 'create_user_two',
      fixtureMarker: 'second_marker',
    });
    await link(target, first);
    await expectSafeError(
      await request(target, `/staging/users/${first.principalId}/customer`, 'POST', {
        runId,
        customerId: 'cus_other',
      }),
      409,
    );
    await expectSafeError(
      await request(target, `/staging/users/${second.principalId}/customer`, 'POST', {
        runId,
        customerId,
      }),
      409,
    );
  });

  it('rejects every scoped operation for another run principal', async () => {
    const target = open();
    const user = await createUser(target);
    for (const response of [
      await request(target, `/staging/users/${user.principalId}/session`, 'POST', {
        runId: 'foreign_run',
      }),
      await request(target, `/staging/users/${user.principalId}/customer`, 'POST', {
        runId: 'foreign_run',
        customerId,
      }),
      await request(target, `/staging/users/${user.principalId}/billing?runId=foreign_run`),
      await request(target, `/staging/users/${user.principalId}?runId=foreign_run`, 'DELETE'),
    ])
      await expectSafeError(response, 403, 'RUN_OWNERSHIP_MISMATCH');
    expect((await session(target, user)).cookie).toMatch(/^pp_session=/);
  });

  it('does not treat unknown principals as owned fixtures', async () => {
    const target = open();
    await expectSafeError(
      await request(target, '/staging/users/usr_missing/session', 'POST', { runId }),
      404,
      'USER_NOT_FOUND',
    );
    await expectSafeError(
      await request(target, `/staging/users/usr_missing/billing?runId=${runId}`),
      404,
      'USER_NOT_FOUND',
    );
    await expectSafeError(
      await request(target, `/staging/users/usr_missing?runId=${runId}`, 'DELETE'),
      404,
      'USER_NOT_FOUND',
    );
  });

  it('deletes sessions, keeps a retry tombstone, and never recreates the removed fixture', async () => {
    const target = open();
    const user = await createUser(target);
    const current = await session(target, user);
    const deletionPath = `/staging/users/${user.principalId}?runId=${runId}`;
    const first = await request(target, deletionPath, 'DELETE');
    expect(first.status).toBe(200);
    const receipt = await json(first);
    expect(receipt).toEqual({ removed: true, principalId: user.principalId, runId });
    expect(await json(await request(target, deletionPath, 'DELETE'))).toEqual(receipt);
    await expectExport(target, current.cookie, 401);
    await close(target);
    const reopened = open();
    await expectSafeError(
      await request(reopened, '/staging/users', 'POST', {
        runId,
        operationId: 'create_user_one',
        fixtureMarker,
      }),
      410,
      'FIXTURE_ALREADY_REMOVED',
    );
  });
});

describe('independent reference: signed synthetic lifecycle', () => {
  it('executes free, paid, scheduled-cancellation, and canceled access through real routes', async () => {
    const target = open();
    const user = await createUser(target);
    await link(target, user);
    const current = await session(target, user);
    await expectExport(target, current.cookie, 403);
    await replayAccepted(target, event());
    await expectExport(target, current.cookie, 200);
    expect(await json(await ordinary(target, '/api/me', current.cookie))).toMatchObject({
      plan: 'Pro',
      canExport: true,
      executionMode: 'local_replay',
    });
    await replayAccepted(
      target,
      event(
        {
          id: 'evt_local_scheduled',
          type: 'customer.subscription.updated',
          created: 1_800_000_100,
        },
        { cancel_at_period_end: true },
      ),
    );
    await expectExport(target, current.cookie, 200);
    const scheduled = await json(
      await request(target, `/staging/users/${user.principalId}/billing?runId=${runId}`),
    );
    expect(scheduled).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
      periodEnd: 1_802_678_400,
      initialPaymentConfirmed: true,
      buildId,
    });
    await replayAccepted(
      target,
      event(
        { id: 'evt_local_canceled', type: 'customer.subscription.deleted', created: 1_800_000_200 },
        { status: 'canceled', cancel_at_period_end: true },
      ),
    );
    await expectExport(target, current.cookie, 403);
    expect(await json(await ordinary(target, '/api/me', current.cookie))).toMatchObject({
      plan: 'Free',
      canExport: false,
      subscriptionStatus: 'canceled',
      executionMode: 'local_replay',
    });
  });

  it('does not let host time revoke a provider-active scheduled subscription', async () => {
    const target = open();
    const user = await createUser(target);
    await link(target, user);
    const current = await session(target, user);
    await replayAccepted(
      target,
      event(
        {},
        {
          cancel_at_period_end: true,
          items: {
            data: [{ price: { id: 'price_pro', livemode: false }, current_period_end: 1 }],
            has_more: false,
          },
        },
      ),
    );
    await expectExport(target, current.cookie, 200);
  });

  it('retains the confirmed initial invoice fact when a later lifecycle invoice is unpaid', async () => {
    const target = open();
    const user = await createUser(target);
    await link(target, user);
    const current = await session(target, user);
    await replayAccepted(target, event());
    await replayAccepted(
      target,
      event(
        { id: 'evt_later_update', type: 'customer.subscription.updated', created: 1_800_000_100 },
        {
          latest_invoice: {
            id: 'in_later',
            livemode: false,
            status: 'open',
            billing_reason: 'subscription_cycle',
          },
        },
      ),
    );
    await expectExport(target, current.cookie, 200);
  });

  it('does not treat a paid recurring invoice as proof of an initial payment', async () => {
    const target = open();
    const user = await createUser(target);
    await link(target, user);
    await replayAccepted(
      target,
      event(
        {},
        {
          latest_invoice: {
            id: 'in_cycle',
            livemode: false,
            status: 'paid',
            billing_reason: 'subscription_cycle',
          },
        },
      ),
    );
    await expectExport(target, (await session(target, user)).cookie, 403);
  });

  it('does not grant an active subscription whose creation invoice is unpaid', async () => {
    const target = open();
    const user = await createUser(target);
    await link(target, user);
    await replayAccepted(
      target,
      event(
        {},
        {
          latest_invoice: {
            livemode: false,
            status: 'open',
            billing_reason: 'subscription_create',
          },
        },
      ),
    );
    await expectExport(target, (await session(target, user)).cookie, 403);
  });

  it.each(['omitted', 'null'])(
    'retains same-subscription payment across update and deletion with %s invoice',
    async (absence) => {
      const target = open();
      const user = await createUser(target);
      await link(target, user);
      const current = await session(target, user);
      await replayAccepted(target, event());
      const latest_invoice = absence === 'omitted' ? undefined : null;
      await replayAccepted(
        target,
        event(
          {
            id: 'evt_update_without_invoice',
            type: 'customer.subscription.updated',
            created: 1_800_000_100,
          },
          {
            latest_invoice,
            cancel_at_period_end: true,
          },
        ),
      );
      expect(
        await json(
          await request(target, `/staging/users/${user.principalId}/billing?runId=${runId}`),
        ),
      ).toMatchObject({
        subscriptionId: 'sub_local_owned',
        status: 'active',
        cancelAtPeriodEnd: true,
        initialPaymentConfirmed: true,
      });
      await expectExport(target, current.cookie, 200);
      await replayAccepted(
        target,
        event(
          {
            id: 'evt_delete_without_invoice',
            type: 'customer.subscription.deleted',
            created: 1_800_000_200,
          },
          {
            latest_invoice,
            status: 'canceled',
            cancel_at_period_end: true,
          },
        ),
      );
      expect(
        await json(
          await request(target, `/staging/users/${user.principalId}/billing?runId=${runId}`),
        ),
      ).toMatchObject({
        subscriptionId: 'sub_local_owned',
        status: 'canceled',
        initialPaymentConfirmed: true,
      });
      await expectExport(target, current.cookie, 403);
    },
  );

  it.each(['omitted', 'null'])(
    'accepts a new subscription with %s invoice without inventing initial payment',
    async (absence) => {
      const target = open();
      const user = await createUser(target);
      await link(target, user);
      await replayAccepted(
        target,
        event({}, { latest_invoice: absence === 'omitted' ? undefined : null }),
      );
      expect(
        await json(
          await request(target, `/staging/users/${user.principalId}/billing?runId=${runId}`),
        ),
      ).toMatchObject({
        subscriptionId: 'sub_local_owned',
        status: 'active',
        initialPaymentConfirmed: false,
      });
      await expectExport(target, (await session(target, user)).cookie, 403);
    },
  );

  it.each(['omitted', 'null'])(
    'rejects replacing the bound subscription even with %s invoice',
    async (absence) => {
      const target = open();
      const user = await createUser(target);
      await link(target, user);
      const current = await session(target, user);
      await replayAccepted(target, event());
      await expectExport(target, current.cookie, 200);
      const original = await json(
        await request(target, `/staging/users/${user.principalId}/billing?runId=${runId}`),
      );
      await expectSafeError(
        await replay(
          target,
          event(
            { id: 'evt_replacement_unpaid', created: 1_800_000_100 },
            {
              id: 'sub_local_replacement',
              latest_invoice: absence === 'omitted' ? undefined : null,
            },
          ),
        ),
      );
      expect(
        await json(
          await request(target, `/staging/users/${user.principalId}/billing?runId=${runId}`),
        ),
      ).toEqual(original);
      await expectExport(target, current.cookie, 200);
      await expectSafeError(
        await replay(
          target,
          event(
            {
              id: 'evt_replacement_paid',
              type: 'customer.subscription.updated',
              created: 1_800_000_200,
            },
            {
              id: 'sub_local_replacement',
              latest_invoice: {
                id: 'in_replacement_creation',
                livemode: false,
                status: 'paid',
                billing_reason: 'subscription_create',
                customer: customerId,
                parent: { subscription_details: { subscription: 'sub_local_replacement' } },
              },
            },
          ),
        ),
      );
      expect(
        await json(
          await request(target, `/staging/users/${user.principalId}/billing?runId=${runId}`),
        ),
      ).toEqual(original);
      await expectExport(target, current.cookie, 200);
    },
  );

  it('does not treat a differing invoice ID alone as foreign ownership', async () => {
    const target = open();
    const user = await createUser(target);
    await link(target, user);
    await replayAccepted(
      target,
      event(
        {},
        {
          latest_invoice: {
            id: 'in_another_synthetic_id',
            livemode: false,
            status: 'paid',
            billing_reason: 'subscription_create',
            customer: customerId,
            parent: { subscription_details: { subscription: 'sub_local_owned' } },
          },
        },
      ),
    );
    await expectExport(target, (await session(target, user)).cookie, 200);
  });

  it.each([
    'in_unexpanded_synthetic_invoice',
    {},
    { livemode: false },
    { status: 'paid' },
    { livemode: false, status: 123 },
    { livemode: true, status: 'paid', billing_reason: 'subscription_create' },
  ])(
    'does not ignore a malformed supplied invoice after initial payment was established',
    async (latest_invoice) => {
      const target = open();
      const user = await createUser(target);
      await link(target, user);
      const current = await session(target, user);
      await replayAccepted(target, event());
      await expectExport(target, current.cookie, 200);
      await expectSafeError(
        await replay(
          target,
          event(
            {
              id: 'evt_later_malformed_invoice',
              type: 'customer.subscription.updated',
              created: 1_800_000_100,
            },
            { latest_invoice },
          ),
        ),
        400,
      );
      expect(
        await json(
          await request(target, `/staging/users/${user.principalId}/billing?runId=${runId}`),
        ),
      ).toMatchObject({
        subscriptionId: 'sub_local_owned',
        status: 'active',
        initialPaymentConfirmed: true,
      });
      await expectExport(target, current.cookie, 200);
    },
  );

  it.each([
    { customer: 'cus_foreign' },
    { parent: { subscription_details: { subscription: 'sub_foreign' } } },
    { subscription: 'sub_foreign' },
  ])(
    'does not ignore foreign invoice identity after initial payment was established',
    async (foreignIdentity) => {
      const target = open();
      const user = await createUser(target);
      await link(target, user);
      const current = await session(target, user);
      await replayAccepted(target, event());
      await expectSafeError(
        await replay(
          target,
          event(
            {
              id: 'evt_later_foreign_invoice',
              type: 'customer.subscription.updated',
              created: 1_800_000_100,
            },
            {
              latest_invoice: {
                id: 'in_synthetic_foreign_identity',
                livemode: false,
                status: 'paid',
                billing_reason: 'subscription_create',
                ...foreignIdentity,
              },
            },
          ),
        ),
      );
      expect(
        await json(
          await request(target, `/staging/users/${user.principalId}/billing?runId=${runId}`),
        ),
      ).toMatchObject({
        subscriptionId: 'sub_local_owned',
        status: 'active',
        initialPaymentConfirmed: true,
      });
      await expectExport(target, current.cookie, 200);
    },
  );

  it('stores exact event duplicates across reopen and rejects reuse for different raw bytes', async () => {
    const target = open();
    const user = await createUser(target);
    await link(target, user);
    const payload = event();
    await replayAccepted(target, payload);
    expect(await replayAccepted(target, payload)).toMatchObject({ duplicate: true });
    await close(target);
    const reopened = open();
    expect(await replayAccepted(reopened, payload)).toMatchObject({ duplicate: true });
    await expectSafeError(
      await replay(reopened, event({}, { status: 'canceled' })),
      409,
      'EVENT_ID_CONFLICT',
    );
    await expectExport(reopened, (await session(reopened, user)).cookie, 200);
  });

  it('does not let an older activation replay restore canceled access', async () => {
    const target = open();
    const user = await createUser(target);
    await link(target, user);
    const current = await session(target, user);
    await replayAccepted(target, event());
    await replayAccepted(
      target,
      event(
        { id: 'evt_new_canceled', type: 'customer.subscription.deleted', created: 1_800_000_200 },
        { status: 'canceled' },
      ),
    );
    expect(
      await replayAccepted(
        target,
        event({
          id: 'evt_old_active',
          type: 'customer.subscription.updated',
          created: 1_800_000_100,
        }),
      ),
    ).toMatchObject({ stale: true });
    await expectExport(target, current.cookie, 403);
  });

  it('never exposes another ordinary user fixture through an authorized session', async () => {
    const target = open();
    const owner = await createUser(target);
    const other = await createUser(target, {
      operationId: 'create_other',
      fixtureMarker: 'OTHER_PRIVATE_MARKER',
    });
    await link(target, owner);
    await replayAccepted(target, event());
    await expectExport(target, (await session(target, owner)).cookie, 200);
    await expectExport(target, (await session(target, other)).cookie, 403, other.fixtureMarker);
  });

  it('rejects replay without both staging authorization and the replay signature', async () => {
    const target = open();
    const user = await createUser(target);
    await link(target, user);
    await expectSafeError(await replay(target, event(), { authorization: '' }), 401);
    await expectSafeError(
      await replay(target, event(), { 'paywallproof-replay-signature': '' }),
      400,
    );
    await expectSafeError(
      await replay(target, event(), {
        'paywallproof-replay-signature': signature(JSON.stringify(event()), webhookSecret),
      }),
      400,
    );
    await expectExport(target, (await session(target, user)).cookie, 403);
  });

  it('rejects raw-body changes and expired signatures', async () => {
    const target = open();
    const user = await createUser(target);
    await link(target, user);
    const raw = JSON.stringify(event());
    const modified = await target.app.request('/staging/replay', {
      method: 'POST',
      body: `${raw} `,
      headers: {
        authorization: `Bearer ${adapterToken}`,
        'content-type': 'application/json',
        'paywallproof-replay-signature': signature(raw),
      },
    });
    await expectSafeError(modified, 400);
    await expectSafeError(
      await replay(target, event(), {
        'paywallproof-replay-signature': signature(
          raw,
          replaySecret,
          Math.floor(Date.now() / 1_000) - 3_600,
        ),
      }),
      400,
    );
    await expectExport(target, (await session(target, user)).cookie, 403);
  });

  it('keeps the real webhook unavailable without Polar credentials and rejects replay signatures there', async () => {
    const target = open();
    const user = await createUser(target);
    await link(target, user);
    const raw = JSON.stringify({
      type: 'subscription.updated',
      timestamp: new Date().toISOString(),
      data: {},
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const deliveryId = 'independent_delivery';
    const signed = createHmac('sha256', webhookSecret)
      .update(`${deliveryId}.${timestamp}.${raw}`)
      .digest('base64');
    const response = await target.app.request('/api/polar/webhook', {
      method: 'POST',
      body: raw,
      headers: {
        'content-type': 'application/json',
        'webhook-id': deliveryId,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${signed}`,
      },
    });
    expect(response.status).toBe(503);
    expect(await json(response)).toEqual({ error: 'POLAR_WEBHOOK_UNAVAILABLE', processed: false });
    const wrongRoute = await target.app.request('/api/polar/webhook', {
      method: 'POST',
      body: raw,
      headers: {
        'content-type': 'application/json',
        'paywallproof-replay-signature': signature(raw, replaySecret),
      },
    });
    await expectSafeError(wrongRoute, 400, 'INVALID_WEBHOOK_SIGNATURE');
    await expectExport(target, (await session(target, user)).cookie, 403);
  });
});

describe('independent reference: malformed boundaries and fault controls', () => {
  it.each<[string, unknown]>([
    ['runId', ''],
    ['runId', ' padded'],
    ['runId', 'x'.repeat(256)],
    ['operationId', ''],
    ['fixtureMarker', ''],
    ['fixtureMarker', 'x'.repeat(2049)],
    ['extra', true],
  ])('rejects malformed fixture field %s', async (key, value) => {
    const target = open();
    await expectSafeError(
      await request(target, '/staging/users', 'POST', {
        runId,
        operationId: 'create_user_one',
        fixtureMarker,
        [key]: value,
      }),
      400,
    );
  });

  it('rejects malformed JSON and oversized bodies without creating a fixture', async () => {
    const target = open();
    for (const body of [
      '{malformed',
      JSON.stringify({
        runId,
        operationId: 'create_user_one',
        fixtureMarker: 'x'.repeat(256 * 1024),
      }),
    ]) {
      const response = await target.app.request('/staging/users', {
        method: 'POST',
        body,
        headers: { authorization: `Bearer ${adapterToken}`, 'content-type': 'application/json' },
      });
      await expectSafeError(response);
    }
    expect((await createUser(target)).fixtureMarker).toBe(fixtureMarker);
  });

  it.each(['not_a_customer', 'cus_with-dash', 'cus_with/slash', 'cus_with space', 'cus_é'])(
    'rejects unsupported customer identifier %s',
    async (id) => {
      const target = open();
      const user = await createUser(target);
      await expectSafeError(
        await request(target, `/staging/users/${user.principalId}/customer`, 'POST', {
          runId,
          customerId: id,
        }),
        400,
      );
    },
  );

  it('rejects unsafe subscription and invoice replay shapes without granting access', async () => {
    const target = open();
    const user = await createUser(target);
    await link(target, user);
    const current = await session(target, user);
    const invalidEvents = [
      event({ livemode: true }),
      event({}, { livemode: true }),
      event({}, { metadata: { runId: 'foreign_run' } }),
      event({}, { customer: 'cus_unlinked' }),
      event({}, { items: { data: [], has_more: false } }),
      event(
        {},
        {
          items: {
            data: [
              { price: { id: 'price_pro', livemode: false }, current_period_end: 1_802_678_400 },
              { price: { id: 'price_pro', livemode: false }, current_period_end: 1_802_678_400 },
            ],
            has_more: false,
          },
        },
      ),
      event(
        {},
        {
          items: {
            data: [
              { price: { id: 'price_other', livemode: false }, current_period_end: 1_802_678_400 },
            ],
            has_more: false,
          },
        },
      ),
      event(
        {},
        {
          items: {
            data: [
              { price: { id: 'price_pro', livemode: true }, current_period_end: 1_802_678_400 },
            ],
            has_more: false,
          },
        },
      ),
      event(
        {},
        {
          latest_invoice: { livemode: true, status: 'paid', billing_reason: 'subscription_create' },
        },
      ),
      event(
        {},
        {
          latest_invoice: {
            livemode: false,
            status: 'paid',
            billing_reason: 'subscription_create',
            customer: 'cus_foreign',
          },
        },
      ),
      event(
        {},
        {
          latest_invoice: {
            livemode: false,
            status: 'paid',
            billing_reason: 'subscription_create',
            parent: { subscription_details: { subscription: 'sub_foreign' } },
          },
        },
      ),
    ];
    for (const payload of invalidEvents) {
      await expectSafeError(await replay(target, payload));
      await expectExport(target, current.cookie, 403);
    }
  });

  it('rejects identical replay and webhook secrets at construction', () => {
    expect(() => open({ replaySecret: webhookSecret })).toThrow();
  });

  it('rejects a legacy live-provider key before any provider call', () => {
    expect(() => open({ polarToken: 'sk_live_SYNTHETIC_REJECT_BEFORE_NETWORK' })).toThrow();
  });

  it.each(['missing_guard', 'missing_activation', 'missing_cancellation'])(
    'rejects fault mode %s outside staging',
    (faultMode) => {
      expect(() => open({ stagingEnabled: false, faultMode })).toThrow();
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => open({ faultMode })).toThrow();
    },
  );

  it('keeps authentication even in the missing-guard variant', async () => {
    const target = open({ faultMode: 'missing_guard' });
    await expectSafeError(
      await ordinary(target, '/api/export', undefined, { authorization: `Bearer ${adapterToken}` }),
      401,
      'AUTHENTICATION_REQUIRED',
    );
    const user = await createUser(target);
    await expectExport(target, (await session(target, user)).cookie, 200);
  });

  it('exposes the seeded missing-activation failure through ordinary feature behavior', async () => {
    const target = open({ faultMode: 'missing_activation' });
    const user = await createUser(target);
    await link(target, user);
    await replayAccepted(target, event());
    await expectExport(target, (await session(target, user)).cookie, 403);
  });

  it('exposes the seeded missing-cancellation failure through ordinary feature behavior', async () => {
    const target = open({ faultMode: 'missing_cancellation' });
    const user = await createUser(target);
    await link(target, user);
    const current = await session(target, user);
    await replayAccepted(target, event());
    await replayAccepted(
      target,
      event(
        {
          id: 'evt_cancellation_fault',
          type: 'customer.subscription.deleted',
          created: 1_800_000_100,
        },
        { status: 'canceled' },
      ),
    );
    await expectExport(target, current.cookie, 200);
  });
});
