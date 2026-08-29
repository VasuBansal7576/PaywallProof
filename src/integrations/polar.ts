import { z } from 'zod';

export const POLAR_API_VERSION = '2026-04';
const sandboxOrigin = 'https://sandbox-api.polar.sh';
const maximumResponseBytes = 1024 * 1024;
const configSchema = z.strictObject({
  token: z.string().regex(/^polar_oat_[A-Za-z0-9_-]+$/),
  organizationId: z.uuid(),
  productId: z.uuid(),
  priceId: z.uuid(),
});
const organizationSchema = z.object({ id: z.uuid() });
const metadata = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const instant = z.iso.datetime({ offset: true });
const customerSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  type: z.literal('individual'),
  external_id: z.string().nullable(),
  metadata,
  deleted_at: instant.nullable(),
});
const subscriptionSchema = z.object({
  id: z.uuid(),
  customer_id: z.uuid(),
  product_id: z.uuid(),
  checkout_id: z.uuid().nullable(),
  metadata,
  status: z.string(),
  amount: z.number().int().positive(),
  currency: z.string(),
  recurring_interval: z.literal('month'),
  recurring_interval_count: z.literal(1),
  current_period_start: instant,
  current_period_end: instant,
  cancel_at_period_end: z.boolean(),
  ended_at: instant.nullable(),
  trial_start: instant.nullable(),
  trial_end: instant.nullable(),
  discount_id: z.null(),
  pause_at_period_end: z.literal(false),
  pending_update: z.null(),
  meters: z.array(z.unknown()).length(0),
  product: z.object({ id: z.uuid(), organization_id: z.uuid() }),
  prices: z
    .array(
      z.object({
        id: z.uuid(),
        product_id: z.uuid(),
        source: z.literal('catalog'),
        amount_type: z.literal('fixed'),
        price_amount: z.number().int().positive(),
        price_currency: z.string(),
      }),
    )
    .length(1),
});
const orderSchema = z.object({
  id: z.uuid(),
  customer_id: z.uuid(),
  product_id: z.uuid().nullable(),
  subscription_id: z.uuid().nullable(),
  checkout_id: z.uuid().nullable(),
  status: z.string(),
  paid: z.boolean(),
  billing_reason: z.string(),
  total_amount: z.number().int().nonnegative(),
  subtotal_amount: z.number().int().nonnegative(),
  discount_amount: z.literal(0),
  refunded_amount: z.literal(0),
  refunded_tax_amount: z.literal(0),
  applied_balance_amount: z.literal(0),
  currency: z.string(),
  metadata,
});
const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    pagination: z.object({
      total_count: z.number().int().nonnegative(),
      max_page: z.number().int().nonnegative(),
    }),
  });
function providerParse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PolarError(code);
  return parsed.data;
}
const productSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  is_archived: z.literal(false),
  is_recurring: z.literal(true),
  recurring_interval: z.literal('month'),
  recurring_interval_count: z.literal(1),
  trial_interval: z.null(),
  trial_interval_count: z.null(),
  meter_interval: z.null(),
  meter_interval_count: z.null(),
  prices: z
    .array(
      z.object({
        id: z.uuid(),
        product_id: z.uuid(),
        is_archived: z.literal(false),
        source: z.literal('catalog'),
        amount_type: z.literal('fixed'),
        price_amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        price_currency: z.string().regex(/^[a-z]{3}$/),
      }),
    )
    .length(1),
});
export class PolarError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PolarError';
  }
}
type Transport = (url: string, options: RequestInit) => Promise<Response>;

/** Fixed-host transport shared by the trusted worker and independent target reader. */
export class PolarSandboxApi {
  readonly #config: z.infer<typeof configSchema>;
  readonly #transport: Transport;
  constructor(config: unknown, transport: Transport = (url, options) => fetch(url, options)) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new PolarError('POLAR_CONFIGURATION_INVALID');
    this.#config = parsed.data;
    this.#transport = transport;
  }
  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (
      !/^\/(?:organizations|products|customers|checkouts|subscriptions|orders)(?:\/[A-Za-z0-9_?=&%.,:-]*)+$/.test(
        path,
      ) ||
      path.includes('..')
    )
      throw new PolarError('POLAR_PATH_REJECTED');
    let response: Response;
    try {
      response = await this.#transport(`${sandboxOrigin}/v1${path}`, {
        method,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#config.token}`,
          Accept: 'application/json',
          'Polar-Version': POLAR_API_VERSION,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PolarError('POLAR_TRANSPORT_UNAVAILABLE');
    }
    try {
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw new PolarError('POLAR_REDIRECT_REJECTED');
      if (!response.ok) throw new PolarError(`POLAR_HTTP_${response.status}`);
      if (response.headers.get('x-polar-sandbox') !== '1')
        throw new PolarError('POLAR_SANDBOX_UNCONFIRMED');
      if (response.headers.get('polar-version') !== POLAR_API_VERSION)
        throw new PolarError('POLAR_API_VERSION_MISMATCH');
      if (response.status === 204) return null;
      if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        throw new PolarError('POLAR_RESPONSE_INVALID');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumResponseBytes))
        throw new PolarError('POLAR_RESPONSE_TOO_LARGE');
      if (!response.body) throw new PolarError('POLAR_RESPONSE_INVALID');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maximumResponseBytes) throw new PolarError('POLAR_RESPONSE_TOO_LARGE');
          chunks.push(next.value);
        }
        const bytes = Buffer.concat(chunks, size);
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch (error) {
        if (error instanceof PolarError) throw error;
        throw new PolarError('POLAR_RESPONSE_INVALID');
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } finally {
      if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
}

/** Reads provider facts without importing the controller or access policy. */
export class PolarSandboxReader {
  readonly #config: z.infer<typeof configSchema>;
  readonly #api: PolarSandboxApi;
  #verified: ReturnType<PolarSandboxReader['preflight']> | undefined;
  constructor(config: unknown, transport?: Transport) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new PolarError('POLAR_CONFIGURATION_INVALID');
    this.#config = parsed.data;
    this.#api = new PolarSandboxApi(config, transport);
  }
  #read(path: string) {
    return this.#api.request('GET', path);
  }
  async preflight() {
    const organization = organizationSchema.safeParse(
      await this.#read(`/organizations/${this.#config.organizationId}`),
    );
    if (!organization.success) throw new PolarError('POLAR_ORGANIZATION_INVALID');
    if (organization.data.id !== this.#config.organizationId)
      throw new PolarError('POLAR_ORGANIZATION_MISMATCH');
    const product = productSchema.safeParse(
      await this.#read(`/products/${this.#config.productId}`),
    );
    if (!product.success) throw new PolarError('POLAR_PRODUCT_UNSUPPORTED');
    if (product.data.organization_id !== this.#config.organizationId)
      throw new PolarError('POLAR_ORGANIZATION_MISMATCH');
    if (product.data.id !== this.#config.productId) throw new PolarError('POLAR_PRODUCT_MISMATCH');
    const [price] = product.data.prices;
    if (!price || price.id !== this.#config.priceId || price.product_id !== product.data.id)
      throw new PolarError('POLAR_PRICE_MISMATCH');
    return {
      provider: 'polar',
      mode: 'polar_sandbox',
      organizationId: organization.data.id,
      productId: product.data.id,
      priceId: price.id,
      amount: price.price_amount,
      currency: price.price_currency,
      apiVersion: POLAR_API_VERSION,
      scope: 'read_only_preflight',
      lifecycleVerified: false,
    };
  }
  async #ensurePreflight() {
    this.#verified ??= this.preflight().catch((error) => {
      this.#verified = undefined;
      throw error;
    });
    return this.#verified;
  }
  async customer(input: { runId: string; customerId: string }) {
    await this.#ensurePreflight();
    const id = providerParse(z.uuid(), input.customerId, 'POLAR_CUSTOMER_ID_INVALID');
    const customer = providerParse(
      customerSchema,
      await this.#read(`/customers/${id}`),
      'POLAR_CUSTOMER_INVALID',
    );
    if (
      customer.id !== id ||
      customer.organization_id !== this.#config.organizationId ||
      customer.metadata.runId !== input.runId ||
      customer.external_id !== `paywallproof:${input.runId}` ||
      customer.deleted_at !== null
    )
      throw new PolarError('POLAR_CUSTOMER_NOT_OWNED');
    return customer;
  }
  async findSubscription(input: { runId: string; customerId: string }) {
    const customer = await this.customer(input);
    const page = providerParse(
      pageSchema(z.object({ id: z.uuid(), customer_id: z.uuid(), product_id: z.uuid(), metadata })),
      await this.#read(`/subscriptions/?customer_id=${customer.id}&limit=2`),
      'POLAR_SUBSCRIPTION_INVALID',
    );
    if (page.pagination.total_count === 0 && page.items.length === 0) return null;
    const [subscription] = page.items;
    if (
      page.pagination.total_count !== 1 ||
      page.items.length !== 1 ||
      page.pagination.max_page > 1 ||
      !subscription ||
      subscription.customer_id !== customer.id ||
      subscription.product_id !== this.#config.productId ||
      subscription.metadata.runId !== input.runId
    )
      throw new PolarError('POLAR_SUBSCRIPTION_IDENTITY_UNRESOLVED');
    return subscription.id;
  }
  /** Return independently read provider facts, never an application entitlement decision. */
  async observe(input: { runId: string; customerId: string; subscriptionId: string }) {
    const plan = await this.#ensurePreflight();
    const customer = await this.customer(input);
    const expectedSubscription = providerParse(
      z.uuid(),
      input.subscriptionId,
      'POLAR_SUBSCRIPTION_ID_INVALID',
    );
    const subscriptions = providerParse(
      pageSchema(subscriptionSchema),
      await this.#read(`/subscriptions/?customer_id=${customer.id}&limit=2`),
      'POLAR_SUBSCRIPTION_INVALID',
    );
    const [subscription] = subscriptions.items;
    if (
      subscriptions.pagination.total_count !== 1 ||
      subscriptions.items.length !== 1 ||
      subscriptions.pagination.max_page > 1 ||
      !subscription
    )
      throw new PolarError('POLAR_SUBSCRIPTION_IDENTITY_UNRESOLVED');
    if (
      subscription.id !== expectedSubscription ||
      subscription.customer_id !== customer.id ||
      subscription.product_id !== this.#config.productId ||
      subscription.product.id !== this.#config.productId ||
      subscription.product.organization_id !== this.#config.organizationId ||
      subscription.metadata.runId !== input.runId ||
      !subscription.checkout_id
    )
      throw new PolarError('POLAR_SUBSCRIPTION_NOT_OWNED');
    const [price] = subscription.prices;
    if (
      !price ||
      price.id !== this.#config.priceId ||
      price.product_id !== this.#config.productId ||
      price.price_amount !== plan.amount ||
      price.price_currency !== plan.currency ||
      subscription.amount !== plan.amount ||
      subscription.currency !== plan.currency ||
      subscription.trial_start !== null ||
      subscription.trial_end !== null
    )
      throw new PolarError('POLAR_SUBSCRIPTION_UNSUPPORTED');
    const periodStart = Math.floor(Date.parse(subscription.current_period_start) / 1000),
      periodEnd = Math.floor(Date.parse(subscription.current_period_end) / 1000);
    if (!Number.isSafeInteger(periodEnd) || periodEnd <= periodStart)
      throw new PolarError('POLAR_PERIOD_INVALID');
    const orders = providerParse(
      pageSchema(orderSchema),
      await this.#read(
        `/orders/?customer_id=${customer.id}&subscription_id=${subscription.id}&limit=100`,
      ),
      'POLAR_ORDER_INVALID',
    );
    if (
      orders.pagination.total_count !== orders.items.length ||
      orders.pagination.max_page > 1 ||
      orders.items.some(
        (order) =>
          order.customer_id !== customer.id ||
          order.subscription_id !== subscription.id ||
          order.product_id !== this.#config.productId ||
          order.currency !== plan.currency,
      )
    )
      throw new PolarError('POLAR_ORDER_IDENTITY_UNRESOLVED');
    const initial = orders.items.filter((order) => order.billing_reason === 'subscription_create');
    const [initialOrder] = initial;
    if (
      initial.length !== 1 ||
      !initialOrder ||
      initialOrder.checkout_id !== subscription.checkout_id ||
      initialOrder.subtotal_amount !== plan.amount
    )
      throw new PolarError('POLAR_INITIAL_ORDER_UNRESOLVED');
    const observedAt = Date.now();
    return {
      customer,
      subscription,
      initialOrder,
      periodEnd,
      billingTime: Math.floor(observedAt / 1000),
      observedAt,
      initialPaymentConfirmed:
        initialOrder.paid && initialOrder.status === 'paid' && initialOrder.total_amount > 0,
    };
  }
}
