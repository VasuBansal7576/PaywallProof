import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { PolarSandboxReader } from './polar.ts';

// Synthetic boundary responses, not evidence of an actual Polar account or payment.
const organizationId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const priceId = '33333333-3333-4333-8333-333333333333';
const config = {
  token: ['polar', 'oat', 'synthetic_contract_only'].join('_'),
  organizationId,
  productId,
  priceId,
};
const product = () => ({
  id: productId,
  organization_id: organizationId,
  is_archived: false,
  is_recurring: true,
  recurring_interval: 'month',
  recurring_interval_count: 1,
  trial_interval: null,
  trial_interval_count: null,
  meter_interval: null,
  meter_interval_count: null,
  prices: [
    {
      id: priceId,
      product_id: productId,
      is_archived: false,
      source: 'catalog',
      amount_type: 'fixed',
      price_amount: 1000,
      price_currency: 'usd',
    },
  ],
});
function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'x-polar-sandbox': '1',
      'polar-version': '2026-04',
    },
  });
}

describe('Polar read-only sandbox preflight, implementation-aware', () => {
  it('binds the sandbox, organization, product and price without a mutation', async () => {
    const requests: {
      url: string;
      method: string | undefined;
      redirect: RequestRedirect | undefined;
      version: string | null;
    }[] = [];
    const reader = new PolarSandboxReader(config, async (url, options) => {
      const parsed = new URL(url);
      requests.push({
        url,
        method: options.method,
        redirect: options.redirect,
        version: new Headers(options.headers).get('Polar-Version'),
      });
      return response(
        parsed.pathname.includes('/organizations/') ? { id: organizationId } : product(),
      );
    });
    expect(await reader.preflight()).toEqual({
      provider: 'polar',
      mode: 'polar_sandbox',
      organizationId,
      productId,
      priceId,
      amount: 1000,
      currency: 'usd',
      apiVersion: '2026-04',
      scope: 'read_only_preflight',
      lifecycleVerified: false,
    });
    expect(requests).toEqual([
      {
        url: `https://sandbox-api.polar.sh/v1/organizations/${organizationId}`,
        method: 'GET',
        redirect: 'error',
        version: '2026-04',
      },
      {
        url: `https://sandbox-api.polar.sh/v1/products/${productId}`,
        method: 'GET',
        redirect: 'error',
        version: '2026-04',
      },
    ]);
  });

  it.each([
    { ...config, token: 'sk_live_invalid' },
    { ...config, token: 'token\r\nInjected: value' },
    { ...config, organizationId: '../other' },
    { ...config, productId: 'https://api.polar.sh' },
    { ...config, priceId: '' },
    { ...config, baseUrl: 'https://api.polar.sh' },
  ])('rejects malformed credentials and configurable destinations before any request', (input) => {
    let called = false;
    expect(
      () =>
        new PolarSandboxReader(input, async () => {
          called = true;
          return response({});
        }),
    ).toThrow('POLAR_CONFIGURATION_INVALID');
    expect(called).toBe(false);
  });

  it.each([
    ['x-polar-sandbox', null, 'POLAR_SANDBOX_UNCONFIRMED'],
    ['x-polar-sandbox', '0', 'POLAR_SANDBOX_UNCONFIRMED'],
    ['x-polar-sandbox', 'true', 'POLAR_SANDBOX_UNCONFIRMED'],
    ['polar-version', null, 'POLAR_API_VERSION_MISMATCH'],
    ['polar-version', '2026-10', 'POLAR_API_VERSION_MISMATCH'],
    ['content-type', 'text/html', 'POLAR_RESPONSE_INVALID'],
    ['content-length', '1048577', 'POLAR_RESPONSE_TOO_LARGE'],
    ['content-length', '-1', 'POLAR_RESPONSE_TOO_LARGE'],
    ['content-length', '1e3', 'POLAR_RESPONSE_TOO_LARGE'],
  ])('requires trustworthy response metadata: %s=%s', async (header, value, code) => {
    const reader = new PolarSandboxReader(config, async () => {
      const result = response({ id: organizationId });
      if (value === null) result.headers.delete(header);
      else result.headers.set(header, value);
      return result;
    });
    await expect(reader.preflight()).rejects.toThrow(code);
  });

  it.each([301, 302, 303, 307, 308])(
    'refuses a redirect to production with status %i',
    async (status) => {
      let called = 0;
      const reader = new PolarSandboxReader(config, async () => {
        called++;
        return new Response(null, {
          status,
          headers: { Location: 'https://api.polar.sh/v1/organizations/' },
        });
      });
      await expect(reader.preflight()).rejects.toThrow('POLAR_REDIRECT_REJECTED');
      expect(called).toBe(1);
    },
  );

  it.each([401, 403, 404, 429, 500, 503])(
    'reports HTTP %i without disclosing response text or retrying',
    async (status) => {
      let called = 0;
      const reader = new PolarSandboxReader(config, async () => {
        called++;
        return new Response(config.token, { status });
      });
      await expect(reader.preflight()).rejects.toThrow(`POLAR_HTTP_${status}`);
      expect(called).toBe(1);
    },
  );

  it('does not include a transport exception containing credentials in the error', async () => {
    const reader = new PolarSandboxReader(config, async () => {
      throw new Error(`authorization=${config.token}`);
    });
    await expect(reader.preflight()).rejects.toMatchObject({
      message: 'POLAR_TRANSPORT_UNAVAILABLE',
    });
  });

  it.each(['not json', '{"incomplete":', JSON.stringify(config.token)])(
    'rejects malformed or non-object response data',
    async (body) => {
      const reader = new PolarSandboxReader(
        config,
        async () => new Response(body, { headers: response({}).headers }),
      );
      await expect(reader.preflight()).rejects.toThrow(
        /^POLAR_(RESPONSE_INVALID|ORGANIZATION_INVALID)$/,
      );
    },
  );

  it('limits streamed bodies even when Content-Length falsely says one byte', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1048577));
      },
      cancel() {
        canceled = true;
      },
    });
    const headers = response({}).headers;
    headers.set('content-length', '1');
    const reader = new PolarSandboxReader(config, async () => new Response(stream, { headers }));
    await expect(reader.preflight()).rejects.toThrow('POLAR_RESPONSE_TOO_LARGE');
    expect(canceled).toBe(true);
  });

  it('rejects invalid UTF-8 rather than accepting replacement characters', async () => {
    const reader = new PolarSandboxReader(
      config,
      async () => new Response(new Uint8Array([0xc3, 0x28]), { headers: response({}).headers }),
    );
    await expect(reader.preflight()).rejects.toThrow('POLAR_RESPONSE_INVALID');
  });

  it('rejects another organization before looking up its product', async () => {
    let called = 0;
    const reader = new PolarSandboxReader(config, async () => {
      called++;
      return response({ id: productId });
    });
    await expect(reader.preflight()).rejects.toThrow('POLAR_ORGANIZATION_MISMATCH');
    expect(called).toBe(1);
  });

  it.each([
    { is_archived: true },
    { is_recurring: false },
    { recurring_interval: 'year' },
    { recurring_interval_count: 2 },
    { trial_interval: 'day', trial_interval_count: 7 },
    { meter_interval: 'month', meter_interval_count: 1 },
    { prices: [] },
    { prices: [...product().prices, ...product().prices] },
    { prices: [{ ...product().prices[0], is_archived: true }] },
    { prices: [{ ...product().prices[0], source: 'ad_hoc' }] },
    { prices: [{ ...product().prices[0], amount_type: 'custom' }] },
    { prices: [{ ...product().prices[0], price_amount: 0 }] },
    { prices: [{ ...product().prices[0], price_amount: -1 }] },
    { prices: [{ ...product().prices[0], price_amount: 1.5 }] },
    { prices: [{ ...product().prices[0], price_currency: 'usd\r\n' }] },
  ])('rejects unsupported paid-plan configuration: %j', async (patch) => {
    const reader = new PolarSandboxReader(config, async (url) =>
      response(
        url.includes('/organizations/') ? { id: organizationId } : { ...product(), ...patch },
      ),
    );
    await expect(reader.preflight()).rejects.toThrow('POLAR_PRODUCT_UNSUPPORTED');
  });

  it.each([
    [{ organization_id: productId }, 'POLAR_ORGANIZATION_MISMATCH'],
    [{ id: organizationId }, 'POLAR_PRODUCT_MISMATCH'],
    [{ prices: [{ ...product().prices[0], id: organizationId }] }, 'POLAR_PRICE_MISMATCH'],
    [{ prices: [{ ...product().prices[0], product_id: organizationId }] }, 'POLAR_PRICE_MISMATCH'],
  ])('rejects product and price identity mismatches', async (patch, code) => {
    const reader = new PolarSandboxReader(config, async (url) =>
      response(
        url.includes('/organizations/') ? { id: organizationId } : { ...product(), ...patch },
      ),
    );
    await expect(reader.preflight()).rejects.toThrow(code);
  });

  it('requires sandbox provenance on the product as well as the organization', async () => {
    const reader = new PolarSandboxReader(config, async (url) => {
      if (url.includes('/organizations/')) return response({ id: organizationId });
      const result = response(product());
      result.headers.delete('x-polar-sandbox');
      return result;
    });
    await expect(reader.preflight()).rejects.toThrow('POLAR_SANDBOX_UNCONFIRMED');
  });

  it.each([
    [{}, 'POLAR_CONFIGURATION_MISSING'],
    [
      {
        POLAR_ACCESS_TOKEN: 'not-a-provider-token',
        POLAR_ORGANIZATION_ID: organizationId,
        POLAR_PRODUCT_ID: productId,
        POLAR_PRICE_ID: priceId,
      },
      'POLAR_CONFIGURATION_INVALID',
    ],
  ])(
    'the real verifier exits blocked, not skipped or passed, without usable configuration',
    async (environment, code) => {
      const result = await new Promise<{
        code: number | string | null | undefined;
        stdout: string;
        stderr: string;
      }>((done) => {
        execFile(
          process.execPath,
          ['--import', 'tsx', resolve('scripts/verify-polar.ts')],
          {
            // Do not inherit a developer's provider credentials into an offline test.
            env: { PATH: process.env.PATH, NODE_ENV: 'test', ...environment },
          },
          (error, stdout, stderr) => done({ code: error?.code, stdout, stderr }),
        );
      });
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'blocked',
        code,
        lifecycleVerified: false,
      });
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('not-a-provider-token');
    },
  );
});

// Native-shaped synthetic responses below test parsing and ownership only.
// They are deliberately not stored as real provider evidence.
const runId = '44444444-4444-4444-8444-444444444444';
const customerId = '55555555-5555-4555-8555-555555555555';
const subscriptionId = '66666666-6666-4666-8666-666666666666';
const checkoutId = '77777777-7777-4777-8777-777777777777';
const orderId = '88888888-8888-4888-8888-888888888888';
const nativeCustomer = () => ({
  id: customerId,
  organization_id: organizationId,
  type: 'individual',
  external_id: `paywallproof:${runId}`,
  metadata: { runId },
  deleted_at: null,
});
const nativeSubscription = () => ({
  id: subscriptionId,
  customer_id: customerId,
  product_id: productId,
  checkout_id: checkoutId,
  metadata: { runId },
  status: 'active',
  amount: 1000,
  currency: 'usd',
  recurring_interval: 'month',
  recurring_interval_count: 1,
  current_period_start: '2026-08-01T00:00:00Z',
  current_period_end: '2026-09-01T00:00:00Z',
  cancel_at_period_end: false,
  ended_at: null,
  trial_start: null,
  trial_end: null,
  discount_id: null,
  pause_at_period_end: false,
  pending_update: null,
  meters: [],
  product: { id: productId, organization_id: organizationId },
  prices: product().prices,
});
const nativeOrder = () => ({
  id: orderId,
  customer_id: customerId,
  product_id: productId,
  subscription_id: subscriptionId,
  checkout_id: checkoutId,
  status: 'paid',
  paid: true,
  billing_reason: 'subscription_create',
  total_amount: 1000,
  subtotal_amount: 1000,
  discount_amount: 0,
  refunded_amount: 0,
  refunded_tax_amount: 0,
  applied_balance_amount: 0,
  currency: 'usd',
  metadata: { runId },
});
const page = (items: unknown[]) => ({
  items,
  pagination: { total_count: items.length, max_page: items.length ? 1 : 0 },
});
function nativeResponses(patches: Record<string, unknown> = {}) {
  return {
    organization: { id: organizationId },
    product: product(),
    customer: nativeCustomer(),
    subscriptions: page([nativeSubscription()]),
    orders: page([nativeOrder()]),
    ...patches,
  };
}
function readNative(patches: Record<string, unknown> = {}) {
  const responses = nativeResponses(patches);
  return new PolarSandboxReader(config, async (url, options) => {
    expect(options.method).toBe('GET');
    const path = new URL(url).pathname;
    const key = path.includes('/organizations/')
      ? 'organization'
      : path.includes('/products/')
        ? 'product'
        : path.includes('/customers/')
          ? 'customer'
          : path.includes('/subscriptions/')
            ? 'subscriptions'
            : 'orders';
    return response(responses[key]);
  });
}
const identity = { runId, customerId, subscriptionId };

describe('Polar observation boundaries, implementation-aware', () => {
  it('confirms only a paid initial order with the expected identities', async () => {
    const facts = await readNative().observe(identity);
    expect(facts.initialPaymentConfirmed).toBe(true);
    expect(facts.initialOrder.id).toBe(orderId);
    expect(facts.periodEnd).toBe(Date.parse('2026-09-01T00:00:00Z') / 1000);
    expect(facts.billingTime).toBe(Math.floor(facts.observedAt / 1000));
    expect(facts.customer).not.toHaveProperty('email');
  });
  it.each([
    { id: orderId },
    { organization_id: orderId },
    { external_id: 'foreign' },
    { metadata: { runId: 'foreign' } },
    { deleted_at: '2026-08-01T00:00:00Z' },
    { type: 'team' },
  ])('rejects customer ownership mismatch %j', async (patch) => {
    await expect(
      readNative({ customer: { ...nativeCustomer(), ...patch } }).observe(identity),
    ).rejects.toThrow(/^POLAR_CUSTOMER/);
  });
  it.each([
    { id: orderId },
    { customer_id: orderId },
    { product_id: orderId },
    { checkout_id: null },
    { metadata: { runId: 'foreign' } },
    { product: { id: productId, organization_id: orderId } },
    { product: { id: orderId, organization_id: organizationId } },
    { prices: [] },
    { prices: [...product().prices, ...product().prices] },
    { prices: [{ ...product().prices[0], id: orderId }] },
    { prices: [{ ...product().prices[0], source: 'ad_hoc' }] },
    { amount: 0 },
    { amount: 999 },
    { currency: 'eur' },
    { recurring_interval: 'year' },
    { trial_start: '2026-08-01T00:00:00Z' },
    { trial_end: '2026-09-01T00:00:00Z' },
    { discount_id: orderId },
    { pause_at_period_end: true },
    { pending_update: {} },
    { meters: [{}] },
    { current_period_end: '2026-07-01T00:00:00Z' },
  ])('rejects unsupported or foreign subscription %j', async (patch) => {
    await expect(
      readNative({ subscriptions: page([{ ...nativeSubscription(), ...patch }]) }).observe(
        identity,
      ),
    ).rejects.toThrow(/^POLAR_/);
  });
  it.each([
    { items: [], pagination: { total_count: 0, max_page: 0 } },
    { items: [nativeSubscription()], pagination: { total_count: 2, max_page: 2 } },
    page([nativeSubscription(), nativeSubscription()]),
  ])('does not hide pagination or multiple subscriptions', async (subscriptions) => {
    await expect(readNative({ subscriptions }).observe(identity)).rejects.toThrow(
      'POLAR_SUBSCRIPTION_IDENTITY_UNRESOLVED',
    );
  });
  it.each([
    { customer_id: orderId },
    { subscription_id: orderId },
    { product_id: orderId },
    { checkout_id: orderId },
    { currency: 'eur' },
    { subtotal_amount: 999 },
    { discount_amount: 1 },
    { refunded_amount: 1 },
    { refunded_tax_amount: 1 },
    { applied_balance_amount: 1 },
    { billing_reason: 'subscription_cycle' },
  ])('rejects foreign, discounted, refunded or renewal payment %j', async (patch) => {
    await expect(
      readNative({ orders: page([{ ...nativeOrder(), ...patch }]) }).observe(identity),
    ).rejects.toThrow(/^POLAR_/);
  });
  it.each([{ paid: false }, { status: 'pending' }, { total_amount: 0 }])(
    'never grants paid status from an unconfirmed initial order %j',
    async (patch) => {
      expect(
        (await readNative({ orders: page([{ ...nativeOrder(), ...patch }]) }).observe(identity))
          .initialPaymentConfirmed,
      ).toBe(false);
    },
  );
  it.each([
    page([]),
    page([nativeOrder(), nativeOrder()]),
    { items: [nativeOrder()], pagination: { total_count: 101, max_page: 2 } },
  ])('requires one complete initial-order identity', async (orders) => {
    await expect(readNative({ orders }).observe(identity)).rejects.toThrow(
      /^POLAR_(ORDER_IDENTITY|INITIAL_ORDER)/,
    );
  });
  it('allows discovery only when a single run-owned subscription exists', async () => {
    expect(await readNative().findSubscription(identity)).toBe(subscriptionId);
    expect(await readNative({ subscriptions: page([]) }).findSubscription(identity)).toBeNull();
    await expect(
      readNative({
        subscriptions: page([{ ...nativeSubscription(), metadata: { runId: 'foreign' } }]),
      }).findSubscription(identity),
    ).rejects.toThrow('POLAR_SUBSCRIPTION_IDENTITY_UNRESOLVED');
  });
});

import { PolarSandboxAdapter } from './polar-runtime.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, vi } from 'vitest';
import { redact } from '#evidence';
const runtimeFixtures: { directory: string; adapter: PolarSandboxAdapter }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const item of runtimeFixtures.splice(0)) {
    item.adapter.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});
function runtimeFixture(
  options: {
    rejectMutation?: boolean;
    loseCustomerResponse?: boolean;
    checkoutPatch?: Record<string, unknown>;
    testCustomerEmail?: string;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'pp-polar-runtime-'));
  let subscription = {
    ...nativeSubscription(),
    current_period_start: new Date(Date.now() - 60_000).toISOString(),
    current_period_end: new Date(Date.now() + 86400_000).toISOString(),
  };
  let customerCreated = false,
    checkoutCreated = false;
  const requests: { method: string; path: string; body: unknown }[] = [];
  const adapter = new PolarSandboxAdapter(
    {
      ...config,
      databasePath: join(directory, 'state.sqlite'),
      testCustomerEmail: options.testCustomerEmail ?? 'synthetic-owner@example.com',
    },
    (_runId, kind) => {
      if (options.rejectMutation && kind !== 'poll') throw new Error('TEST_APPROVAL_DENIED');
    },
    async (url, init) => {
      const method = init.method ?? 'GET',
        path = new URL(url).pathname;
      const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      requests.push({ method, path, body });
      if (path.includes('/organizations/')) return response({ id: organizationId });
      if (path.includes('/products/')) return response(product());
      if (path === '/v1/customers/' && method === 'POST') {
        customerCreated = true;
        if (options.loseCustomerResponse) throw new Error('synthetic lost response');
        return response(nativeCustomer());
      }
      if (path === `/v1/customers/${customerId}`) {
        if (!customerCreated) throw new Error('No fixture');
        return response(nativeCustomer());
      }
      if (path.startsWith('/v1/checkouts/')) {
        if (method === 'POST') checkoutCreated = true;
        return response({
          id: checkoutId,
          organization_id: organizationId,
          customer_id: customerId,
          product_id: productId,
          product_price_id: priceId,
          metadata: { runId },
          url: 'https://sandbox.polar.sh/checkout/synthetic-only',
          status: 'succeeded',
          is_free_product_price: false,
          allow_trial: false,
          discount_id: null,
          amount: 1000,
          currency: 'usd',
          ...options.checkoutPatch,
        });
      }
      if (path === '/v1/subscriptions/')
        return response(page(checkoutCreated ? [subscription] : []));
      if (path === `/v1/subscriptions/${subscriptionId}` && method === 'PATCH') {
        const data = body !== null && typeof body === 'object' ? body : {};
        if (
          'current_billing_period_end' in data &&
          typeof data.current_billing_period_end === 'string'
        )
          subscription = { ...subscription, current_period_end: data.current_billing_period_end };
        if ('cancel_at_period_end' in data && data.cancel_at_period_end === true)
          subscription = { ...subscription, cancel_at_period_end: true };
        if ('revoke' in data && data.revoke === true)
          subscription = { ...subscription, status: 'canceled' };
        return response(subscription);
      }
      if (path === '/v1/orders/') return response(page([nativeOrder()]));
      throw new Error(`Unexpected synthetic request ${method} ${path}`);
    },
  );
  runtimeFixtures.push({ directory, adapter });
  return {
    adapter,
    requests,
    cancel: () => {
      subscription = { ...subscription, status: 'canceled' };
    },
  };
}

describe('Polar mutation protocol, implementation-aware synthetic transport', () => {
  it('re-establishes process-local preflight before a post-restart mutation', async () => {
    const { adapter, requests } = runtimeFixture();

    await expect(adapter.createCustomer(runId, 'create')).rejects.toThrow(
      'POLAR_PREFLIGHT_REQUIRED',
    );
    await adapter.ensurePreflight();
    await expect(adapter.createCustomer(runId, 'create')).resolves.toEqual({ customerId });
    const readsAfterFirstCheck = requests.filter((request) => request.method === 'GET').length;
    await adapter.ensurePreflight();

    expect(requests.filter((request) => request.method === 'GET')).toHaveLength(
      readsAfterFirstCheck,
    );
  });

  it('refuses mutation before preflight or approval', async () => {
    const { adapter, requests } = runtimeFixture({ rejectMutation: true });
    await expect(adapter.createCustomer(runId, 'create')).rejects.toThrow(
      'POLAR_PREFLIGHT_REQUIRED',
    );
    await adapter.preflight();
    await expect(adapter.createCustomer(runId, 'create')).rejects.toThrow('TEST_APPROVAL_DENIED');
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });
  it('does not resend an uncertain customer request under the same or a new operation ID', async () => {
    const { adapter, requests } = runtimeFixture({ loseCustomerResponse: true });
    await adapter.preflight();
    await expect(adapter.createCustomer(runId, 'create')).rejects.toThrow(
      'POLAR_TRANSPORT_UNAVAILABLE',
    );
    await expect(adapter.createCustomer(runId, 'create')).rejects.toThrow(
      'POLAR_RECONCILIATION_REQUIRED',
    );
    await expect(adapter.createCustomer(runId, 'different')).rejects.toThrow(
      'POLAR_OPERATION_CONFLICT',
    );
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });
  it('returns a confirmed customer receipt without creating another customer', async () => {
    const { adapter, requests } = runtimeFixture();
    await adapter.preflight();
    expect(await adapter.createCustomer(runId, 'create')).toEqual({ customerId });
    expect(await adapter.createCustomer(runId, 'create')).toEqual({ customerId });
    const mutations = requests.filter((request) => request.method === 'POST');
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.body).not.toHaveProperty('organization_id');
    expect(JSON.stringify(adapter.listOwned(runId))).not.toContain('@');
  });
  it('derives the customer from the same canonical mailbox identity used by approval binding', async () => {
    const { adapter, requests } = runtimeFixture({
      testCustomerEmail: 'Synthetic.Owner+operator@EXAMPLE.COM',
    });
    await adapter.preflight();

    await adapter.createCustomer(runId, 'create');

    expect(requests.find((request) => request.path === '/v1/customers/')?.body).toMatchObject({
      email: `Synthetic.Owner+pp${runId.replaceAll('-', '')}@example.com`,
    });
  });
  it.each([
    { url: 'https://polar.sh/checkout/production' },
    { url: 'https://sandbox.polar.sh.evil.invalid/checkout/x' },
    { url: 'https://user:secret@sandbox.polar.sh/checkout/x' },
    { url: 'https://sandbox.polar.sh/settings' },
    { organization_id: orderId },
    { customer_id: orderId },
    { product_id: orderId },
    { product_price_id: orderId },
    { allow_trial: true },
    { is_free_product_price: true },
    { discount_id: orderId },
    { amount: 0 },
    { amount: 999 },
  ])('rejects unsafe checkout response %j', async (checkoutPatch) => {
    const { adapter, requests } = runtimeFixture({ checkoutPatch });
    await adapter.preflight();
    await adapter.createCustomer(runId, 'create');
    await expect(adapter.beginSubscriptionCheckout(runId, 'subscribe')).rejects.toThrow();
    expect(requests.filter((request) => request.method === 'PATCH')).toEqual([]);
    expect(adapter.checkoutUrl(runId)).toBeNull();
  });
  it('shortens the actual period before SC02, schedules cancellation and waits for real time and provider cancellation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T00:00:00Z'));
    const fixture = runtimeFixture();
    await fixture.adapter.preflight();
    await fixture.adapter.createCustomer(runId, 'create');
    const checkout = await fixture.adapter.beginSubscriptionCheckout(runId, 'subscribe');
    expect(checkout).toMatchObject({ checkoutId, status: 'checkout_required' });
    expect(fixture.requests.filter((request) => request.method === 'PATCH')).toEqual([]);
    await expect(fixture.adapter.checkoutCompleted(runId)).resolves.toBe(true);
    const created = await fixture.adapter.completeSubscriptionCheckout(runId);
    expect(created).not.toBeNull();
    if (!created) throw new Error('Synthetic checkout should be complete');
    expect(created.periodEnd).toBe(Math.floor(Date.now() / 1000) + 120);
    expect(await fixture.adapter.observe(runId)).toMatchObject({
      subscription: { status: 'active', initialPaymentConfirmed: true, cancelAtPeriodEnd: false },
    });
    await fixture.adapter.scheduleCancellation(runId, 'schedule');
    expect(
      fixture.requests
        .filter((request) => request.method === 'PATCH')
        .map((request) => request.body),
    ).toEqual([
      { current_billing_period_end: new Date(created.periodEnd * 1000).toISOString() },
      { cancel_at_period_end: true },
    ]);
    const waiting = fixture.adapter.awaitPeriodEnd(runId, 'wait');
    let completed = false;
    void waiting.then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(completed).toBe(false); // Time alone is not a cancellation receipt.
    fixture.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await waiting).toMatchObject({ subscriptionId, mode: 'polar_sandbox' });
    expect(fixture.requests.filter((request) => request.method === 'PATCH')).toHaveLength(2); // Waiting never mutates a fake clock.
    expect(await fixture.adapter.cleanup(runId)).toEqual(
      expect.arrayContaining([
        { resourceId: subscriptionId, status: 'retained', code: 'POLAR_CANCELED_AUDIT_RETAINED' },
      ]),
    );
  });
  it('returns promptly while an externally completed checkout is still pending', async () => {
    const fixture = runtimeFixture({ checkoutPatch: { status: 'open' } });
    await fixture.adapter.preflight();
    await fixture.adapter.createCustomer(runId, 'create');
    await expect(fixture.adapter.beginSubscriptionCheckout(runId, 'subscribe')).resolves.toEqual({
      checkoutId,
      status: 'checkout_required',
      mode: 'polar_sandbox',
    });
    await expect(fixture.adapter.checkoutCompleted(runId)).resolves.toBe(false);
    await expect(fixture.adapter.completeSubscriptionCheckout(runId)).resolves.toBeNull();
    expect(fixture.requests.filter((request) => request.method === 'PATCH')).toEqual([]);
  });
  it('redacts Polar credentials, mailboxes and private checkout links without erasing the mode label', () => {
    const token = ['polar', 'oat', 'SYNTHETIC_ONLY_123456789'].join('_');
    const cleaned = redact({
      mode: 'polar_sandbox',
      message: `${token} https://sandbox.polar.sh/checkout/private-secret synthetic@example.com`,
      workerToken: 'canary-worker',
      referenceToken: 'canary-reader',
      client_secret: 'canary-client',
      ownerEmail: 'canary-owner',
    });
    expect(JSON.stringify(cleaned)).not.toMatch(/SYNTHETIC_ONLY|private-secret|synthetic@|canary-/);
    expect(cleaned).toMatchObject({ mode: 'polar_sandbox' });
  });
});

import { createHmac } from 'node:crypto';
import { createReferenceApp } from '#reference';
const nativeTargets: ReturnType<typeof createReferenceApp>[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const target of nativeTargets.splice(0)) target.close();
});
async function nativeTarget() {
  let subscription = nativeSubscription(),
    failed = false;
  vi.stubGlobal('fetch', async (url: string) => {
    if (failed) return new Response('synthetic unavailable', { status: 503 });
    const path = new URL(url).pathname;
    return response(
      path.includes('/organizations/')
        ? { id: organizationId }
        : path.includes('/products/')
          ? product()
          : path.includes('/customers/')
            ? nativeCustomer()
            : path.includes('/subscriptions/')
              ? page([subscription])
              : page([nativeOrder()]),
    );
  });
  const secret = 'synthetic-polar-webhook-only';
  const target = createReferenceApp({
    databasePath: ':memory:',
    stagingEnabled: true,
    adapterToken: 'synthetic-adapter',
    webhookSecret: secret,
    replaySecret: 'different-replay-secret',
    priceId,
    buildId: 'synthetic-build',
    polarToken: config.token,
    polarOrganizationId: organizationId,
    polarProductId: productId,
  });
  nativeTargets.push(target);
  const headers = { authorization: 'Bearer synthetic-adapter', 'content-type': 'application/json' };
  const created = await target.app.request('/staging/users', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      runId,
      operationId: 'create',
      fixtureMarker: 'synthetic-private-marker',
    }),
  });
  const user = await created.json();
  if (
    !user ||
    typeof user !== 'object' ||
    !('principalId' in user) ||
    typeof user.principalId !== 'string'
  )
    throw new Error('Invalid local fixture');
  expect(
    (
      await target.app.request(`/staging/users/${user.principalId}/customer`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ runId, customerId }),
      })
    ).status,
  ).toBe(200);
  const session = await (
    await target.app.request(`/staging/users/${user.principalId}/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ runId }),
    })
  ).json();
  if (
    !session ||
    typeof session !== 'object' ||
    !('cookie' in session) ||
    typeof session.cookie !== 'string'
  )
    throw new Error('Invalid local session');
  const cookie = session.cookie;
  const access = () => target.app.request('/api/export', { headers: { cookie } });
  const send = (
    deliveryId: string,
    type = 'subscription.updated',
    timestamp = new Date().toISOString(),
    patch: Record<string, unknown> = {},
  ) => {
    // Body status deliberately lies. Only independently fetched provider state may grant access.
    const raw = JSON.stringify({
      type,
      timestamp,
      data: { id: subscriptionId, customer_id: customerId, status: 'active', ...patch },
    });
    const signedAt = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret)
      .update(`${deliveryId}.${signedAt}.${raw}`)
      .digest('base64');
    return target.app.request('/api/polar/webhook', {
      method: 'POST',
      body: raw,
      headers: {
        'content-type': 'application/json',
        'webhook-id': deliveryId,
        'webhook-timestamp': signedAt,
        'webhook-signature': `v1,${signature}`,
      },
    });
  };
  return {
    target,
    send,
    access,
    schedule: () => {
      subscription = { ...subscription, cancel_at_period_end: true };
    },
    cancel: () => {
      subscription = { ...subscription, status: 'canceled' };
    },
    fail: (value: boolean) => {
      failed = value;
    },
  };
}
describe('native Polar webhook to real local projection, implementation-aware synthetic provider', () => {
  it('reconciles current state through paid, scheduled, canceled and out-of-order deliveries', async () => {
    const fixture = await nativeTarget();
    expect((await fixture.access()).status).toBe(403);
    expect((await fixture.send('paid', 'subscription.active')).status).toBe(200);
    expect((await fixture.access()).status).toBe(200);
    fixture.schedule();
    expect((await fixture.send('scheduled', 'subscription.canceled')).status).toBe(200);
    expect((await fixture.access()).status).toBe(200);
    fixture.cancel();
    expect((await fixture.send('ended', 'subscription.revoked')).status).toBe(200);
    expect((await fixture.access()).status).toBe(403);
    expect(
      (await fixture.send('delayed', 'subscription.active', '2026-01-01T00:00:00Z')).status,
    ).toBe(200);
    expect((await fixture.access()).status).toBe(403);
  });
  it('deduplicates exact bytes but rejects a conflicting delivery ID', async () => {
    const fixture = await nativeTarget(),
      time = new Date().toISOString();
    expect((await fixture.send('same', 'subscription.active', time)).status).toBe(200);
    fixture.fail(true);
    expect(await (await fixture.send('same', 'subscription.active', time)).json()).toMatchObject({
      duplicate: true,
      processed: false,
    });
    expect((await fixture.send('same', 'subscription.revoked', time)).status).toBe(409);
  });
  it('does not commit a projection or receipt when provider reads fail', async () => {
    const fixture = await nativeTarget(),
      time = new Date().toISOString();
    fixture.fail(true);
    expect((await fixture.send('retry', 'subscription.active', time)).status).toBe(503);
    expect((await fixture.access()).status).toBe(403);
    fixture.fail(false);
    expect(await (await fixture.send('retry', 'subscription.active', time)).json()).toMatchObject({
      processed: true,
      duplicate: false,
    });
    expect((await fixture.access()).status).toBe(200);
  });
});
