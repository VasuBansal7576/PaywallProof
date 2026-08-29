import Database from 'better-sqlite3';
import { z } from 'zod';
import { billingSchema, hashValue, type Billing } from '#domain';
import { PolarSandboxApi, PolarSandboxReader, PolarError } from './polar.ts';

const configSchema = z.strictObject({
  token: z.string(),
  organizationId: z.uuid(),
  productId: z.uuid(),
  priceId: z.uuid(),
  databasePath: z.string().min(1),
  testCustomerEmail: z.email(),
});
const resourceSchema = z.object({
  id: z.uuid(),
  run_id: z.string(),
  kind: z.enum(['customer', 'checkout', 'subscription']),
  receipt: z.string(),
});
const checkoutSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  customer_id: z.uuid(),
  product_id: z.uuid(),
  product_price_id: z.uuid(),
  metadata: z.record(z.string(), z.unknown()),
  url: z.url(),
  status: z.string(),
  is_free_product_price: z.literal(false),
  allow_trial: z.literal(false),
  discount_id: z.null(),
  amount: z.number().int().positive(),
  currency: z.string(),
});
type Transport = ConstructorParameters<typeof PolarSandboxApi>[1];
export type PolarMutationKind =
  | 'create_customer'
  | 'create_checkout'
  | 'set_period_end'
  | 'schedule_cancellation'
  | 'cleanup'
  | 'external_wait';
const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const verificationPeriodSeconds = 120;
const cancellationConfirmationGraceMs = 60_000;

/** Mutations stay on the sandbox host. A dispatched request is never blindly retried. */
export class PolarSandboxAdapter {
  readonly #config: z.infer<typeof configSchema>;
  readonly #api: PolarSandboxApi;
  readonly #reader: PolarSandboxReader;
  readonly #database: Database.Database;
  readonly #guard: (runId: string, kind: PolarMutationKind | 'poll') => void;
  #verified: Awaited<ReturnType<PolarSandboxReader['preflight']>> | null = null;
  constructor(
    input: unknown,
    guard: (runId: string, kind: PolarMutationKind | 'poll') => void,
    transport?: Transport,
  ) {
    const config = configSchema.safeParse(input);
    if (!config.success) throw new PolarError('POLAR_CONFIGURATION_INVALID');
    this.#config = config.data;
    this.#guard = guard;
    const { token, organizationId, productId, priceId } = config.data;
    this.#api = new PolarSandboxApi({ token, organizationId, productId, priceId }, transport);
    this.#reader = new PolarSandboxReader({ token, organizationId, productId, priceId }, transport);
    this.#database = new Database(config.data.databasePath);
    this.#database.exec(
      'CREATE TABLE IF NOT EXISTS polar_resources(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,kind TEXT NOT NULL,receipt TEXT NOT NULL,UNIQUE(run_id,kind)); CREATE TABLE IF NOT EXISTS polar_intents(operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,kind TEXT NOT NULL,args_hash TEXT NOT NULL,response TEXT,UNIQUE(run_id,kind)); CREATE TABLE IF NOT EXISTS polar_periods(run_id TEXT PRIMARY KEY,period_end INTEGER NOT NULL);',
    );
  }
  async preflight() {
    this.#verified = await this.#reader.preflight();
    return this.#verified;
  }
  #ready() {
    if (!this.#verified) throw new PolarError('POLAR_PREFLIGHT_REQUIRED');
    return this.#verified;
  }
  #record(
    runId: string,
    kind: z.infer<typeof resourceSchema>['kind'],
    id: string,
    receipt: unknown,
  ) {
    const previous = this.#resource(runId, kind);
    if (previous && previous.id !== id) throw new PolarError('POLAR_RESOURCE_CONFLICT');
    this.#database
      .prepare('INSERT INTO polar_resources VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(id, runId, kind, JSON.stringify(receipt));
  }
  #resource(runId: string, kind: z.infer<typeof resourceSchema>['kind']) {
    const row = this.#database
      .prepare('SELECT * FROM polar_resources WHERE run_id=? AND kind=?')
      .get(runId, kind);
    return row ? resourceSchema.parse(row) : null;
  }
  #require(runId: string, kind: z.infer<typeof resourceSchema>['kind']) {
    const resource = this.#resource(runId, kind);
    if (!resource) throw new PolarError('POLAR_OWNERSHIP_UNRESOLVED');
    return resource;
  }
  listOwned(runId: string) {
    return this.#database
      .prepare('SELECT * FROM polar_resources WHERE run_id=? ORDER BY kind')
      .all(runId)
      .map((row) => {
        const resource = resourceSchema.parse(row);
        return { id: resource.id, kind: resource.kind, runId };
      });
  }
  async #mutate(
    runId: string,
    operationId: string,
    kind: PolarMutationKind,
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ) {
    this.#ready();
    const argsHash = hashValue({ runId, kind, method, path, body: body ?? null });
    const previous = this.#database
      .prepare('SELECT * FROM polar_intents WHERE operation_id=? OR (run_id=? AND kind=?)')
      .get(operationId, runId, kind);
    if (previous) {
      const intent = z
        .object({
          operation_id: z.string(),
          run_id: z.string(),
          args_hash: z.string(),
          response: z.string().nullable(),
        })
        .parse(previous);
      if (
        intent.operation_id !== operationId ||
        intent.run_id !== runId ||
        intent.args_hash !== argsHash
      )
        throw new PolarError('POLAR_OPERATION_CONFLICT');
      if (intent.response === null) throw new PolarError('POLAR_RECONCILIATION_REQUIRED');
      return JSON.parse(intent.response);
    }
    this.#guard(runId, kind);
    this.#database
      .prepare('INSERT INTO polar_intents VALUES(?,?,?,?,NULL)')
      .run(operationId, runId, kind, argsHash);
    const result = await this.#api.request(method, path, body);
    this.#database
      .prepare('UPDATE polar_intents SET response=? WHERE operation_id=?')
      .run(JSON.stringify(result), operationId);
    return result;
  }
  async createCustomer(runId: string, operationId: string) {
    z.uuid().parse(runId);
    this.#ready();
    // The mailbox is explicit operator configuration. Never read an account email implicitly.
    const [local, domain] = this.#config.testCustomerEmail.split('@');
    const email = z
      .email()
      .parse(`${local?.split('+')[0]}+pp${runId.replaceAll('-', '')}@${domain}`);
    const body = {
      email,
      type: 'individual',
      external_id: `paywallproof:${runId}`,
      metadata: { runId, purpose: 'paywallproof_sandbox_verification' },
    };
    const created = z
      .object({
        id: z.uuid(),
        organization_id: z.uuid(),
        external_id: z.string(),
        metadata: z.object({ runId: z.string() }),
      })
      .parse(
        await this.#mutate(runId, operationId, 'create_customer', 'POST', '/customers/', body),
      );
    if (
      created.organization_id !== this.#config.organizationId ||
      created.external_id !== body.external_id ||
      created.metadata.runId !== runId
    )
      throw new PolarError('POLAR_CUSTOMER_NOT_OWNED');
    this.#record(runId, 'customer', created.id, { id: created.id });
    await this.#reader.customer({ runId, customerId: created.id });
    return { customerId: created.id };
  }
  #checkout(input: unknown, runId: string, customerId: string) {
    const checkout = checkoutSchema.parse(input),
      plan = this.#ready();
    if (
      checkout.organization_id !== this.#config.organizationId ||
      checkout.customer_id !== customerId ||
      checkout.product_id !== this.#config.productId ||
      checkout.product_price_id !== this.#config.priceId ||
      checkout.metadata.runId !== runId ||
      checkout.amount !== plan.amount ||
      checkout.currency !== plan.currency
    )
      throw new PolarError('POLAR_CHECKOUT_NOT_OWNED');
    const url = new URL(checkout.url);
    if (
      url.origin !== 'https://sandbox.polar.sh' ||
      url.username ||
      url.password ||
      !url.pathname.startsWith('/checkout/')
    )
      throw new PolarError('POLAR_CHECKOUT_URL_REJECTED');
    return checkout;
  }
  /** This credential-bearing URL is only for the authenticated operator route, never a report/tool response. */
  checkoutUrl(runId: string) {
    const resource = this.#resource(runId, 'checkout');
    return resource
      ? this.#checkout(JSON.parse(resource.receipt), runId, this.#require(runId, 'customer').id).url
      : null;
  }
  /** Creates the owned checkout and returns before a human is asked to complete it. */
  async beginSubscriptionCheckout(runId: string, operationId: string) {
    const customer = this.#require(runId, 'customer');
    await this.#reader.customer({ runId, customerId: customer.id });
    const checkout = this.#checkout(
      await this.#mutate(
        runId,
        `${operationId}:checkout`,
        'create_checkout',
        'POST',
        '/checkouts/',
        {
          products: [this.#config.productId],
          customer_id: customer.id,
          allow_trial: false,
          allow_discount_codes: false,
          metadata: { runId, purpose: 'paywallproof_sandbox_verification' },
        },
      ),
      runId,
      customer.id,
    );
    this.#record(runId, 'checkout', checkout.id, checkout);
    return { checkoutId: checkout.id, status: 'checkout_required', mode: 'polar_sandbox' } as const;
  }
  async #currentCheckout(runId: string, guardKind: 'poll' | 'external_wait' = 'poll') {
    this.#ready();
    this.#guard(runId, guardKind);
    const customer = this.#require(runId, 'customer');
    return this.#checkout(
      await this.#api.request('GET', `/checkouts/${this.#require(runId, 'checkout').id}`),
      runId,
      customer.id,
    );
  }
  /** One provider read used to decide whether a persisted TrueForge turn may resume. */
  async checkoutCompleted(runId: string) {
    const checkout = await this.#currentCheckout(runId, 'external_wait');
    if (['expired', 'failed'].includes(checkout.status))
      throw new PolarError('POLAR_CHECKOUT_NOT_COMPLETED');
    return checkout.status === 'succeeded';
  }
  /** Provider-read continuation for a previously recorded checkout; never waits on a person. */
  async completeSubscriptionCheckout(runId: string) {
    const customer = this.#require(runId, 'customer');
    const checkout = await this.#currentCheckout(runId);
    if (['expired', 'failed'].includes(checkout.status))
      throw new PolarError('POLAR_CHECKOUT_NOT_COMPLETED');
    if (checkout.status !== 'succeeded') return null;
    const subscriptionId = await this.#reader.findSubscription({ runId, customerId: customer.id });
    if (!subscriptionId) return null;
    this.#record(runId, 'subscription', subscriptionId, { id: subscriptionId });
    const facts = await this.#reader.observe({ runId, customerId: customer.id, subscriptionId });
    if (
      !facts.initialPaymentConfirmed ||
      facts.subscription.checkout_id !== checkout.id ||
      facts.subscription.status !== 'active' ||
      facts.subscription.cancel_at_period_end
    )
      throw new PolarError('POLAR_INITIAL_PAYMENT_UNCONFIRMED');
    const existing = this.#database
      .prepare('SELECT period_end FROM polar_periods WHERE run_id=?')
      .get(runId);
    const periodEnd = existing
      ? z.object({ period_end: z.number().int().positive() }).parse(existing).period_end
      : Math.floor(Date.now() / 1000) + verificationPeriodSeconds;
    this.#database
      .prepare('INSERT INTO polar_periods VALUES(?,?) ON CONFLICT(run_id) DO NOTHING')
      .run(runId, periodEnd);
    await this.#mutate(
      runId,
      `checkout-confirm:${runId}:period`,
      'set_period_end',
      'PATCH',
      `/subscriptions/${subscriptionId}`,
      { current_billing_period_end: new Date(periodEnd * 1000).toISOString() },
    );
    const confirmed = await this.#reader.observe({
      runId,
      customerId: customer.id,
      subscriptionId,
    });
    if (confirmed.periodEnd !== periodEnd) throw new PolarError('POLAR_PERIOD_UPDATE_UNCONFIRMED');
    return { subscriptionId, checkoutId: checkout.id, periodEnd, mode: 'polar_sandbox' } as const;
  }
  async observe(runId: string): Promise<Billing> {
    this.#ready();
    const facts = await this.#reader.observe({
      runId,
      customerId: this.#require(runId, 'customer').id,
      subscriptionId: this.#require(runId, 'subscription').id,
    });
    return billingSchema.parse({
      livemode: false,
      identityResolved: true,
      noSubscriptionConfirmed: false,
      customerId: facts.customer.id,
      subscription: {
        id: facts.subscription.id,
        customerId: facts.customer.id,
        priceId: this.#config.priceId,
        status: facts.subscription.status,
        initialPaymentConfirmed: facts.initialPaymentConfirmed,
        cancelAtPeriodEnd: facts.subscription.cancel_at_period_end,
        periodEnd: facts.periodEnd,
        billingTime: facts.billingTime,
      },
    });
  }
  async scheduleCancellation(runId: string, operationId: string) {
    const before = await this.observe(runId),
      subscription = before.subscription;
    if (
      !subscription ||
      subscription.status !== 'active' ||
      subscription.billingTime >= subscription.periodEnd
    )
      throw new PolarError('POLAR_CANCELLATION_PRECONDITION');
    await this.#mutate(
      runId,
      operationId,
      'schedule_cancellation',
      'PATCH',
      `/subscriptions/${subscription.id}`,
      { cancel_at_period_end: true },
    );
    const after = (await this.observe(runId)).subscription;
    if (
      !after?.cancelAtPeriodEnd ||
      after.periodEnd !== subscription.periodEnd ||
      after.status !== 'active'
    )
      throw new PolarError('POLAR_CANCELLATION_UNCONFIRMED');
    return { subscriptionId: after.id, cancelAtPeriodEnd: true, periodEnd: after.periodEnd };
  }
  async awaitPeriodEnd(runId: string, operationId: string) {
    z.string().min(1).parse(operationId);
    const before = (await this.observe(runId)).subscription;
    if (!before?.cancelAtPeriodEnd) throw new PolarError('POLAR_CANCELLATION_REQUIRED');
    if (before.periodEnd - Math.floor(Date.now() / 1000) > 600)
      throw new PolarError('POLAR_PERIOD_WAIT_BOUND');
    const remainingUntilPeriodEnd = Math.max(0, before.periodEnd * 1000 - Date.now());
    const deadline = performance.now() + remainingUntilPeriodEnd + cancellationConfirmationGraceMs;
    for (;;) {
      this.#guard(runId, 'poll');
      const subscription = (await this.observe(runId)).subscription;
      if (
        !subscription ||
        subscription.id !== before.id ||
        subscription.periodEnd !== before.periodEnd
      )
        throw new PolarError('POLAR_PERIOD_IDENTITY_CHANGED');
      if (subscription.status === 'canceled' && subscription.billingTime > subscription.periodEnd)
        return {
          subscriptionId: subscription.id,
          billingTime: subscription.billingTime,
          mode: 'polar_sandbox',
        };
      if (performance.now() >= deadline) throw new PolarError('POLAR_PERIOD_END_UNCONFIRMED');
      await delay(5000);
    }
  }
  async cleanup(runId: string) {
    this.#ready();
    const customer = this.#resource(runId, 'customer');
    if (!customer) return [];
    await this.#reader.customer({ runId, customerId: customer.id });
    const subscriptionId = await this.#reader.findSubscription({ runId, customerId: customer.id });
    if (subscriptionId) {
      const owned = this.#require(runId, 'subscription');
      if (owned.id !== subscriptionId) throw new PolarError('POLAR_CLEANUP_OWNERSHIP_UNRESOLVED');
      const facts = await this.#reader.observe({ runId, customerId: customer.id, subscriptionId });
      if (facts.subscription.status !== 'canceled')
        await this.#mutate(
          runId,
          `cleanup:${runId}`,
          'cleanup',
          'PATCH',
          `/subscriptions/${subscriptionId}`,
          { revoke: true },
        );
      if (
        (await this.#reader.observe({ runId, customerId: customer.id, subscriptionId }))
          .subscription.status !== 'canceled'
      )
        throw new PolarError('POLAR_CLEANUP_UNCONFIRMED');
    }
    const checkout = this.#resource(runId, 'checkout');
    if (checkout && !subscriptionId) {
      const current = this.#checkout(
        await this.#api.request('GET', `/checkouts/${checkout.id}`),
        runId,
        customer.id,
      );
      if (current.status !== 'expired')
        return this.listOwned(runId).map((resource) => ({
          resourceId: resource.id,
          status: 'leftover' as const,
          code: 'POLAR_CHECKOUT_STILL_OPEN',
        }));
    }
    // Polar retains customer, checkout and order audit records. Do not claim deletion.
    return this.listOwned(runId).map((resource) => ({
      resourceId: resource.id,
      status: 'retained' as const,
      code: subscriptionId ? 'POLAR_CANCELED_AUDIT_RETAINED' : 'POLAR_UNPAID_AUDIT_RETAINED',
    }));
  }
  close() {
    this.#database.close();
  }
}
