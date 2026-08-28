import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import { createPolarReader, eventSchema, eventSubscription, polarEventSchema, polarEventSubscription, providerBilling, replayBilling, verifyCustomer } from './billing';
import { verifyReplay } from './replay-signature';
import { ReferenceStore, TargetError, type User } from './store';

const identifier = z.string().min(1).max(255).refine(value => value.trim() === value);
const optionsSchema = z.object({
  databasePath: z.string().min(1), stagingEnabled: z.boolean(), adapterToken: z.string().min(1),
  webhookSecret: z.string().min(1), replaySecret: z.string().min(1), priceId: identifier, buildId: identifier,
  polarToken: z.string().optional(), polarOrganizationId: z.string().optional(), polarProductId: z.string().optional(),
  faultMode: z.enum(['none', 'missing_guard', 'missing_activation', 'missing_cancellation']).default('none'),
});
export type ReferenceOptions = z.input<typeof optionsSchema>;
const userRequest = z.strictObject({ runId: identifier, operationId: identifier, fixtureMarker: z.string().min(1).max(2048) });
const linkRequest = z.strictObject({ runId: identifier, customerId: z.union([z.uuid(), z.string().regex(/^cus_[A-Za-z0-9_]+$/).max(255)]) });
const runRequest = z.strictObject({ runId: identifier });

function sameSecret(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function entitled(user: User, priceId: string) {
  return user.status === 'active' && user.price_id === priceId && user.initial_payment_confirmed === 1;
}

/** Independent target process. No controller database, credentials, or policy code is imported. */
export function createReferenceApp(input: ReferenceOptions) {
  const options = optionsSchema.parse(input);
  if (sameSecret(options.webhookSecret, options.replaySecret)) throw new Error('WEBHOOK_AND_REPLAY_SECRETS_MUST_DIFFER');
  if (options.faultMode !== 'none' && (!options.stagingEnabled || process.env.NODE_ENV === 'production')) throw new Error('FAULT_MODE_REQUIRES_TEST_ENVIRONMENT');
  const provider = createPolarReader({token: options.polarToken, organizationId: options.polarOrganizationId, productId: options.polarProductId, priceId: options.priceId});
  const store = new ReferenceStore(options.databasePath);
  const app = new Hono();
  const customerQueues = new Map<string, Promise<void>>();
  function serializeCustomer<T>(customerId: string, action: () => Promise<T>): Promise<T> {
    const result = (customerQueues.get(customerId) ?? Promise.resolve()).then(action);
    const completed = result.then(() => undefined, () => undefined);
    customerQueues.set(customerId, completed);
    void completed.then(() => { if (customerQueues.get(customerId) === completed) customerQueues.delete(customerId); });
    return result;
  }
  const faultMode = () => options.stagingEnabled && process.env.NODE_ENV !== 'production' ? options.faultMode : 'none';
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 262_144, onError: c => c.json({ error: 'REQUEST_TOO_LARGE' }, 413) }));
  app.use('/staging/*', async (c, next) => {
    // Evaluate NODE_ENV on every request so hooks cannot survive a production transition.
    if (!options.stagingEnabled || process.env.NODE_ENV === 'production') return c.json({ error: 'NOT_FOUND' }, 404);
    if (!sameSecret(c.req.header('authorization'), `Bearer ${options.adapterToken}`)) return c.json({ error: 'ADAPTER_AUTH_REQUIRED' }, 401);
    await next();
  });
  app.get('/staging/describe', c => c.json({
    adapterVersion: '1', environment: 'test', buildId: options.buildId, billingTimeModel: 'provider_status',
    feature: { id: 'pro_export', method: 'GET', path: '/api/export', denialStatuses: [403], browserPath: '/dashboard', actionTestId: 'export-button', resultTestId: 'export-result' },
  }));
  app.post('/staging/users', async c => c.json(store.createUser(userRequest.parse(await c.req.json())), 201));
  app.post('/staging/users/:id/customer', async c => {
    const request = linkRequest.parse(await c.req.json());
    store.ownedUser(c.req.param('id'), request.runId);
    if (provider && !request.customerId.startsWith('cus_replay_')) await verifyCustomer(provider, request.customerId, request.runId);
    store.linkCustomer(c.req.param('id'), request.runId, request.customerId);
    return c.json({ principalId: c.req.param('id'), runId: request.runId, customerId: request.customerId });
  });
  app.post('/staging/users/:id/session', async c => {
    const { runId } = runRequest.parse(await c.req.json());
    const session = store.session(c.req.param('id'), runId);
    // Return only the Cookie header value to the trusted runner. This is an ordinary session.
    return c.json({ cookie: `pp_session=${session.token}`, expiresAt: session.expiresAt });
  });
  app.get('/staging/users/:id/billing', c => {
    const runId = identifier.parse(c.req.query('runId'));
    const user = store.ownedUser(c.req.param('id'), runId);
    return c.json({
      principalId: user.id, runId: user.run_id, customerId: user.customer_id, status: user.status,
      subscriptionId: user.subscription_id, priceId: user.price_id, initialPaymentConfirmed: user.initial_payment_confirmed === 1,
      cancelAtPeriodEnd: user.cancel_at_period_end === 1, periodEnd: user.period_end, buildId: options.buildId,
    });
  });
  app.delete('/staging/users/:id', c => {
    const runId = identifier.parse(c.req.query('runId'));
    store.removeUser(c.req.param('id'), runId);
    return c.json({ removed: true, principalId: c.req.param('id'), runId });
  });
  app.get('/api/me', c => {
    const user = store.sessionUser(getCookie(c, 'pp_session'));
    if (!user) return c.json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
    return c.json({ principalId: user.id, plan: entitled(user, options.priceId) ? 'Pro' : 'Free', canExport: entitled(user, options.priceId), subscriptionStatus: user.status, cancelAtPeriodEnd: user.cancel_at_period_end === 1, periodEnd: user.period_end, executionMode: user.billing_mode });
  });
  app.get('/api/export', c => {
    const user = store.sessionUser(getCookie(c, 'pp_session'));
    if (!user) return c.json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
    if (faultMode() !== 'missing_guard' && !entitled(user, options.priceId)) return c.json({ error: 'ACCESS_DENIED' }, 403);
    return c.json({ fixtureMarker: user.fixture_marker });
  });

  for (const mode of ['polar_sandbox', 'local_replay'] satisfies Array<'polar_sandbox' | 'local_replay'>) {
    app.post(mode === 'polar_sandbox' ? '/api/polar/webhook' : '/staging/replay', async c => {
      const rawBody = await c.req.text();
      let rawEvent: unknown;
      try {
        if (mode === 'local_replay') {
          rawEvent = verifyReplay(rawBody, c.req.header('paywallproof-replay-signature') ?? '', options.replaySecret);
        } else {
          rawEvent = new Webhook(Buffer.from(options.webhookSecret, 'utf8').toString('base64')).verify(rawBody, {
            'webhook-id': c.req.header('webhook-id') ?? '', 'webhook-timestamp': c.req.header('webhook-timestamp') ?? '',
            'webhook-signature': c.req.header('webhook-signature') ?? '',
          });
        }
      } catch {
        throw new TargetError('INVALID_WEBHOOK_SIGNATURE', 400);
      }
      const replay = mode === 'local_replay' ? eventSchema.parse(rawEvent) : null;
      const polar = mode === 'polar_sandbox' ? polarEventSchema.parse(rawEvent) : null;
      if (polar && !provider) return c.json({ error: 'POLAR_WEBHOOK_UNAVAILABLE', processed: false }, 503);
      const eventId = replay ? replay.id : identifier.parse(c.req.header('webhook-id'));
      const created = replay ? replay.created : Math.floor(Date.parse(polar!.timestamp) / 1000);
      const reference = replay ? eventSubscription(replay) : polarEventSubscription(polar!);
      if (!reference) return c.json({ received: true, processed: false, ignored: true, mode });
      const outcome = await serializeCustomer(reference.customerId, async () => {
        if (store.eventAlreadyProcessed(eventId, rawBody, mode)) return 'duplicate';
        const user = store.customerUser(reference.customerId);
        const billing = replay
          ? replayBilling(replay, user, options.priceId)
          : await providerBilling(requireProvider(), reference.subscriptionId, user, options.priceId);
        const skipProjection = (faultMode() === 'missing_activation' && billing.status === 'active') || (faultMode() === 'missing_cancellation' && billing.status === 'canceled');
        return store.applyEvent({ eventId, rawBody, created, mode, user, billing, skipProjection });
      });
      return c.json({ received: true, processed: outcome === 'processed', duplicate: outcome === 'duplicate', stale: outcome === 'stale', mode });
    });
  }
  function requireProvider() {
    if (!provider) throw new TargetError('POLAR_WEBHOOK_UNAVAILABLE', 503);
    return provider;
  }
  app.notFound(c => c.json({ error: 'NOT_FOUND' }, 404));
  app.onError((error, c) => {
    if (error instanceof TargetError) return c.json({ error: error.code }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'INVALID_REQUEST' }, 400);
    // Never reflect provider bodies, SQL, cookies, or credentials to a caller.
    return c.json({ error: 'TARGET_UNAVAILABLE' }, 503);
  });
  return { app, close: () => store.close() };
}
