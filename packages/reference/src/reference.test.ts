import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createReferenceApp, type ReferenceOptions } from './index';

const directories: string[] = [];
const targets: Array<ReturnType<typeof createReferenceApp>> = [];
afterEach(() => {
  for (const target of targets.splice(0)) target.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup(extra: Partial<ReferenceOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'paywallproof-reference-'));
  directories.push(directory);
  const options = {
    databasePath: join(directory, 'reference.sqlite'), stagingEnabled: true, adapterToken: 'test-adapter-only',
    webhookSecret: 'whsec_test_real_only', replaySecret: 'whsec_test_replay_only', priceId: 'price_pro', buildId: 'build-test',
    ...extra,
  } satisfies ReferenceOptions;
  const target = createReferenceApp(options);
  targets.push(target);
  return { target, options };
}
const headers = { authorization: 'Bearer test-adapter-only', 'content-type': 'application/json' };
const userSchema = z.object({ principalId: z.string(), runId: z.string(), fixtureMarker: z.string() });
async function createUser(target: ReturnType<typeof createReferenceApp>, runId = 'run_test', operationId = 'operation_test') {
  const response = await target.app.request('/staging/users', { method: 'POST', headers, body: JSON.stringify({ runId, operationId, fixtureMarker: `private_${runId}` }) });
  expect(response.status).toBe(201);
  return userSchema.parse(await response.json());
}
async function provision(target: ReturnType<typeof createReferenceApp>) {
  const user = await createUser(target);
  const linked = await target.app.request(`/staging/users/${user.principalId}/customer`, { method: 'POST', headers, body: JSON.stringify({ runId: user.runId, customerId: 'cus_local' }) });
  expect(linked.status).toBe(200);
  const response = await target.app.request(`/staging/users/${user.principalId}/session`, { method: 'POST', headers, body: JSON.stringify({ runId: user.runId }) });
  const session = z.object({ cookie: z.string(), expiresAt: z.string() }).parse(await response.json());
  return { user, session };
}
function event(status = 'active', created = 100, scheduled = false) {
  return {
    id: `evt_${created}`, type: status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated',
    livemode: false, created,
    data: { object: {
      id: 'sub_local', object: 'subscription', livemode: false, customer: 'cus_local', status,
      metadata: { runId: 'run_test' }, cancel_at_period_end: scheduled,
      items: { data: [{ price: { id: 'price_pro', livemode: false }, current_period_end: 1000 }] },
      latest_invoice: { id: 'in_local', livemode: false, status: 'paid', billing_reason: 'subscription_create', customer: 'cus_local', parent: { subscription_details: { subscription: 'sub_local' } } },
    } },
  };
}
async function sendEvent(target: ReturnType<typeof createReferenceApp>, payload: unknown, route = '/staging/replay', secret = 'whsec_test_replay_only') {
  const body = JSON.stringify(payload);
  return target.app.request(route, { method: 'POST', headers: { ...headers, 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload: body, secret }) }, body });
}

describe('reference target real HTTP and SQLite', () => {
  it('denies ordinary anonymous and free users and never accepts the adapter token as a user session', async () => {
    const { target } = setup();
    const { session } = await provision(target);
    expect((await target.app.request('/api/export')).status).toBe(401);
    expect((await target.app.request('/api/export', { headers })).status).toBe(401);
    const denied = await target.app.request('/api/export', { headers: { cookie: session.cookie } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'ACCESS_DENIED' });
    expect((await target.app.request('/staging/describe', { headers: { cookie: session.cookie } })).status).toBe(401);
  });

  it('persists operation idempotency and sessions across restart without creating duplicate users', async () => {
    const { target, options } = setup();
    const { user, session } = await provision(target);
    target.close();
    targets.splice(targets.indexOf(target), 1);
    const reopened = createReferenceApp(options);
    targets.push(reopened);
    expect(await createUser(reopened)).toEqual(user);
    expect((await reopened.app.request('/api/export', { headers: { cookie: session.cookie } })).status).toBe(403);
    const conflict = await reopened.app.request('/staging/users', { method: 'POST', headers, body: JSON.stringify({ runId: 'other', operationId: 'operation_test', fixtureMarker: 'other' }) });
    expect(conflict.status).toBe(409);
  });

  it('executes free, activation, scheduled cancellation and final cancellation through signed replay', async () => {
    const { target } = setup();
    const { session, user } = await provision(target);
    for (const [payload, status] of [[event(), 200], [event('active', 200, true), 200], [event('canceled', 300), 403]] satisfies Array<[ReturnType<typeof event>, number]>) {
      const replay = await sendEvent(target, payload);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ processed: true, mode: 'local_replay' });
      const feature = await target.app.request('/api/export', { headers: { cookie: session.cookie } });
      expect(feature.status).toBe(status);
      expect(await feature.json()).toEqual(status === 200 ? { fixtureMarker: user.fixtureMarker } : { error: 'ACCESS_DENIED' });
    }
    const billing = await target.app.request(`/staging/users/${user.principalId}/billing?runId=${user.runId}`, { headers });
    expect(await billing.json()).toMatchObject({ status: 'canceled', initialInvoicePaid: true, priceId: 'price_pro', periodEnd: 1000 });
    const me = await target.app.request('/api/me', { headers: { cookie: session.cookie } });
    expect(await me.json()).toMatchObject({ executionMode: 'local_replay', canExport: false });
  });

  it('deduplicates event ids durably and will not overwrite a cancellation with stale replay', async () => {
    const { target, options } = setup();
    const { session } = await provision(target);
    await sendEvent(target, event('canceled', 300));
    expect(await (await sendEvent(target, event('active', 100))).json()).toMatchObject({ stale: true, processed: false });
    target.close();
    targets.splice(targets.indexOf(target), 1);
    const reopened = createReferenceApp(options);
    targets.push(reopened);
    expect(await (await sendEvent(reopened, event('canceled', 300))).json()).toMatchObject({ duplicate: true, processed: false });
    expect((await sendEvent(reopened, event('active', 300))).status).toBe(409);
    expect((await reopened.app.request('/api/export', { headers: { cookie: session.cookie } })).status).toBe(403);
  });

  it('rejects forged, replay-on-live, missing-key and live-mode events without claiming they were processed', async () => {
    const { target } = setup();
    await provision(target);
    expect((await sendEvent(target, event(), '/staging/replay', 'wrong')).status).toBe(400);
    expect((await sendEvent(target, event(), '/api/stripe/webhook')).status).toBe(400);
    const unavailable = await sendEvent(target, event(), '/api/stripe/webhook', 'whsec_test_real_only');
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'STRIPE_WEBHOOK_UNAVAILABLE', processed: false });
    expect((await sendEvent(target, { ...event(), livemode: true })).status).toBe(400);
  });

  it('rejects cross-run replay, unknown customers, wrong prices, unpaid activation and multiple items', async () => {
    const { target } = setup();
    const { session } = await provision(target);
    const wrongRun = event(); wrongRun.data.object.metadata.runId = 'another_run';
    expect((await sendEvent(target, wrongRun)).status).toBe(403);
    const wrongCustomer = event(); wrongCustomer.data.object.customer = 'cus_unknown';
    expect((await sendEvent(target, wrongCustomer)).status).toBe(403);
    const wrongPrice = event(); wrongPrice.data.object.items.data = [{ price: { id: 'price_other', livemode: false }, current_period_end: 1000 }];
    expect((await sendEvent(target, wrongPrice)).status).toBe(422);
    const multiple = event(); multiple.data.object.items.data.push({ price: { id: 'price_pro', livemode: false }, current_period_end: 1000 });
    expect((await sendEvent(target, multiple)).status).toBe(400);
    const unpaid = event(); unpaid.data.object.latest_invoice.status = 'open';
    expect((await sendEvent(target, unpaid)).status).toBe(200);
    expect((await target.app.request('/api/export', { headers: { cookie: session.cookie } })).status).toBe(403);
  });

  it('enforces ownership for reads, sessions and cleanup, then revokes removed user sessions', async () => {
    const { target } = setup();
    const { session, user } = await provision(target);
    expect((await target.app.request(`/staging/users/${user.principalId}/billing?runId=other`, { headers })).status).toBe(403);
    expect((await target.app.request(`/staging/users/${user.principalId}/session`, { method: 'POST', headers, body: JSON.stringify({ runId: 'other' }) })).status).toBe(403);
    expect((await target.app.request(`/staging/users/${user.principalId}?runId=other`, { method: 'DELETE', headers })).status).toBe(403);
    expect((await target.app.request('/api/export', { headers: { cookie: session.cookie } })).status).toBe(403);
    expect((await target.app.request(`/staging/users/${user.principalId}?runId=${user.runId}`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await target.app.request(`/staging/users/${user.principalId}?runId=${user.runId}`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await target.app.request('/api/export', { headers: { cookie: session.cookie } })).status).toBe(401);
  });

  it('requires both staging flag and nonproduction runtime on every staging endpoint', async () => {
    const { target } = setup({ stagingEnabled: false });
    expect((await target.app.request('/staging/describe', { headers })).status).toBe(404);
    expect((await sendEvent(target, event())).status).toBe(404);
    const { target: enabled } = setup();
    try {
      vi.stubEnv('NODE_ENV', 'production');
      expect((await enabled.app.request('/staging/describe', { headers })).status).toBe(404);
      expect((await sendEvent(enabled, event())).status).toBe(404);
      expect(() => setup({ faultMode: 'missing_guard' })).toThrow('FAULT_MODE_REQUIRES_TEST_ENVIRONMENT');
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(['missing_guard', 'missing_activation', 'missing_cancellation'] satisfies Array<NonNullable<ReferenceOptions['faultMode']>>)('exposes the intended behavior defect in the %s variant', async faultMode => {
    const { target } = setup({ faultMode });
    const { session } = await provision(target);
    const probe = () => target.app.request('/api/export', { headers: { cookie: session.cookie } });
    expect((await probe()).status).toBe(faultMode === 'missing_guard' ? 200 : 403);
    await sendEvent(target, event());
    expect((await probe()).status).toBe(faultMode === 'missing_activation' ? 403 : 200);
    await sendEvent(target, event('canceled', 300));
    expect((await probe()).status).toBe(faultMode === 'missing_activation' ? 403 : 200);
    expect((await target.app.request('/api/export', { headers })).status).toBe(401);
  });
});
