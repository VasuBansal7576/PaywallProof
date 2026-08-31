import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReferenceApp } from '#reference';
import { TargetTransport } from '#integrations/network';
import { LocalReplayAdapter } from '#integrations/replay';

// Signed synthetic LocalReplayAdapter delivery through actual reference handlers.
// The only listening server binds an ephemeral loopback port. No provider SDK,
// provider credentials, TrueForge endpoint, or external service is used.

type Reference = ReturnType<typeof createReferenceApp>;
const adapterToken = 'SYNTHETIC_REPLAY_ADAPTER_TOKEN';
const replaySecret = ['whsec', 'SYNTHETIC_REPLAY_ADAPTER_SECRET'].join('_');
const priceId = 'price_synthetic_pro';
const buildId = 'synthetic_replay_reference_build';
let directory: string;
let target: Reference | undefined;
let server: Server | undefined;
let origin: string;
const adapters = new Set<LocalReplayAdapter>();
let dispatched: { method: string; path: string }[];

function field(value: unknown, key: string): string {
  if (value !== null && typeof value === 'object') {
    const found: unknown = Reflect.get(value, key);
    if (typeof found === 'string') return found;
  }
  throw new Error(`Expected public response string ${key}`);
}

async function exposeReference(app: Reference) {
  async function bridge(request: IncomingMessage, response: ServerResponse) {
    const method = request.method ?? 'GET';
    const path = request.url ?? '/';
    dispatched.push({ method, path });
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of request)
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    const localRequest = new Request(`${origin}${path}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: Buffer.concat(chunks).toString('utf8') }),
    });
    const result = await app.app.fetch(localRequest);
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    response.end(Buffer.from(await result.arrayBuffer()));
  }
  server = createServer((request, response) => {
    void bridge(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":"SYNTHETIC_BRIDGE_FAILURE"}');
    });
  });
  const listening = server;
  await new Promise<void>((resolve, reject) => {
    listening.once('error', reject);
    listening.listen(0, '127.0.0.1', () => {
      listening.removeListener('error', reject);
      resolve();
    });
  });
  const address = listening.address();
  if (address === null || typeof address === 'string')
    throw new Error('Expected ephemeral IPv4 listener');
  origin = `http://127.0.0.1:${address.port}`;
}

function openAdapter(overrides: Record<string, unknown> = {}) {
  const adapter = new LocalReplayAdapter({
    databasePath: join(directory, 'replay.sqlite'),
    priceId,
    adapterToken,
    replaySecret,
    transport: new TargetTransport({ origin, allowLoopback: true, timeoutMs: 2_000 }),
    ...overrides,
  });
  adapters.add(adapter);
  return adapter;
}

async function closeAdapter(adapter: LocalReplayAdapter) {
  await adapter.close();
  adapters.delete(adapter);
}

async function staging(app: Reference, path: string, method = 'GET', body?: unknown) {
  return app.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${adapterToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createAndLink(app: Reference, runId: string, customerId: string) {
  const fixtureMarker = `SYNTHETIC_FIXTURE_${runId}`;
  const created = await staging(app, '/staging/users', 'POST', {
    runId,
    operationId: `create_${runId}`,
    fixtureMarker,
  });
  expect(created.status).toBe(201);
  const principalId = field(await created.json(), 'principalId');
  const linked = await staging(app, `/staging/users/${principalId}/customer`, 'POST', {
    runId,
    customerId,
  });
  expect(linked.status).toBe(200);
  const session = await staging(app, `/staging/users/${principalId}/session`, 'POST', { runId });
  expect(session.status).toBe(200);
  return { principalId, fixtureMarker, cookie: field(await session.json(), 'cookie') };
}

async function checkAccess(app: Reference, cookie: string, status: number, fixtureMarker: string) {
  const response = await app.app.request('/api/export', { headers: { cookie } });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(
    status === 200 ? { fixtureMarker } : { error: 'ACCESS_DENIED' },
  );
}

async function expectRejected(action: () => unknown) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
}

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  directory = mkdtempSync(join(tmpdir(), 'paywallproof-independent-replay-'));
  dispatched = [];
  target = createReferenceApp({
    databasePath: join(directory, 'reference.sqlite'),
    stagingEnabled: true,
    adapterToken,
    replaySecret,
    webhookSecret: ['whsec', 'SYNTHETIC_SEPARATE_WEBHOOK_SECRET'].join('_'),
    priceId,
    buildId,
  });
  await exposeReference(target);
});

afterEach(async () => {
  for (const adapter of adapters) await closeAdapter(adapter);
  if (server) {
    const listening = server;
    await new Promise<void>((resolve, reject) => {
      listening.close((error) => (error ? reject(error) : resolve()));
      listening.closeAllConnections();
    });
  }
  if (target) await target.close();
  server = undefined;
  target = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('vertical synthetic replay adapter to actual reference handlers', () => {
  it('supports UUID run IDs through the complete signed local lifecycle', async () => {
    if (!target) throw new Error('Expected local reference fixture');
    const runId = randomUUID();
    const adapter = openAdapter();
    const customer = await adapter.createCustomer(runId);
    expect(customer.customerId).toMatch(/^cus_[A-Za-z0-9_]+$/);
    expect(await adapter.createCustomer(runId)).toEqual(customer);
    expect(dispatched).toEqual([]);
    const user = await createAndLink(target, runId, customer.customerId);
    await checkAccess(target, user.cookie, 403, user.fixtureMarker);
    await expectRejected(() => adapter.observe(runId));

    const created = await adapter.createSubscription(runId, `create_${runId}`);
    expect(created).toMatchObject({ mode: 'local_replay' });
    const active = await adapter.observe(runId);
    expect(active).toMatchObject({
      livemode: false,
      identityResolved: true,
      noSubscriptionConfirmed: false,
      customerId: customer.customerId,
      subscription: {
        customerId: customer.customerId,
        priceId,
        status: 'active',
        initialPaymentConfirmed: true,
        cancelAtPeriodEnd: false,
      },
    });
    await checkAccess(target, user.cookie, 200, user.fixtureMarker);

    const scheduled = await adapter.scheduleCancellation(runId, `schedule_${runId}`);
    expect(scheduled).toMatchObject({ mode: 'local_replay' });
    const pending = await adapter.observe(runId);
    expect(pending).toMatchObject({
      customerId: customer.customerId,
      subscription: { status: 'active', initialPaymentConfirmed: true, cancelAtPeriodEnd: true },
    });
    await checkAccess(target, user.cookie, 200, user.fixtureMarker);
    await closeAdapter(adapter);
    const reopened = openAdapter();
    expect(await reopened.createCustomer(runId)).toEqual(customer);
    expect(await reopened.observe(runId)).toEqual(pending);

    const canceled = await reopened.awaitPeriodEnd(runId, `advance_${runId}`);
    expect(canceled).toMatchObject({ mode: 'local_replay' });
    const finalBilling = await reopened.observe(runId);
    expect(finalBilling).toMatchObject({
      customerId: customer.customerId,
      subscription: { status: 'canceled', initialPaymentConfirmed: true },
    });
    await checkAccess(target, user.cookie, 403, user.fixtureMarker);
    const snapshot = await staging(
      target,
      `/staging/users/${user.principalId}/billing?runId=${encodeURIComponent(runId)}`,
    );
    expect(await snapshot.json()).toMatchObject({
      customerId: customer.customerId,
      status: 'canceled',
      initialPaymentConfirmed: true,
      buildId,
    });
    expect(dispatched).toEqual([
      { method: 'POST', path: '/staging/replay' },
      { method: 'POST', path: '/staging/replay' },
      { method: 'POST', path: '/staging/replay' },
    ]);
  }, 20_000);

  it('never collides customer IDs when run IDs differ only by punctuation', async () => {
    if (!target) throw new Error('Expected local reference fixture');
    const adapter = openAdapter();
    const ids = ['run-a', 'run_a', 'run.a', 'runa'];
    const customers: string[] = [];
    for (const runId of ids) {
      const customer = await adapter.createCustomer(runId);
      expect(customer.customerId).toMatch(/^cus_[A-Za-z0-9_]+$/);
      customers.push(customer.customerId);
      await createAndLink(target, runId, customer.customerId);
    }
    expect(new Set(customers).size).toBe(ids.length);
    expect(dispatched).toEqual([]);
    await closeAdapter(adapter);
    const reopened = openAdapter();
    for (const [index, runId] of ids.entries())
      expect((await reopened.createCustomer(runId)).customerId).toBe(customers[index]);
  }, 20_000);

  it('refuses clock advancement before cancellation has been scheduled', async () => {
    if (!target) throw new Error('Expected local reference fixture');
    const adapter = openAdapter();
    const runId = randomUUID();
    const customer = await adapter.createCustomer(runId);
    const user = await createAndLink(target, runId, customer.customerId);
    await adapter.createSubscription(runId, 'create_before_invalid_advance');
    const before = [...dispatched];
    await expectRejected(() => adapter.awaitPeriodEnd(runId, 'advance_without_schedule'));
    expect(dispatched).toEqual(before);
    await checkAccess(target, user.cookie, 200, user.fixtureMarker);
  }, 20_000);

  it('does not dispatch a signed target event when beforeMutation rejects', async () => {
    if (!target) throw new Error('Expected local reference fixture');
    const runId = randomUUID();
    const gateCalls: string[] = [];
    let revoked = false;
    const adapter = openAdapter({
      beforeMutation: (requestedRunId: string) => {
        if (revoked) {
          gateCalls.push(requestedRunId);
          throw new Error('Synthetic approval revoked');
        }
      },
    });
    const customer = await adapter.createCustomer(runId);
    const user = await createAndLink(target, runId, customer.customerId);
    revoked = true;
    await expectRejected(() => adapter.createSubscription(runId, 'rejected_create'));
    expect(gateCalls).toEqual([runId]);
    expect(dispatched).toEqual([]);
    await checkAccess(target, user.cookie, 403, user.fixtureMarker);
  }, 20_000);

  it.each(['signing_secret', 'adapter_authorization'])(
    'does not report successful delivery when target rejects %s',
    async (failure) => {
      if (!target) throw new Error('Expected local reference fixture');
      const runId = randomUUID();
      const adapter = openAdapter(
        failure === 'signing_secret'
          ? { replaySecret: 'SYNTHETIC_WRONG_SIGNING_SECRET' }
          : { adapterToken: 'SYNTHETIC_WRONG_ADAPTER_TOKEN' },
      );
      const customer = await adapter.createCustomer(runId);
      const user = await createAndLink(target, runId, customer.customerId);
      await expectRejected(() => adapter.createSubscription(runId, 'rejected_delivery'));
      expect(dispatched).toEqual([{ method: 'POST', path: '/staging/replay' }]);
      const snapshot = await staging(
        target,
        `/staging/users/${user.principalId}/billing?runId=${encodeURIComponent(runId)}`,
      );
      expect(await snapshot.json()).toMatchObject({
        customerId: customer.customerId,
        status: 'none',
        initialPaymentConfirmed: false,
      });
      await checkAccess(target, user.cookie, 403, user.fixtureMarker);
    },
    20_000,
  );
});
