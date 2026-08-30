import { type IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import { TargetTransport } from './network.ts';

const targetIdentifierSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value);
const targetPathSchema = z
  .string()
  .min(2)
  .max(256)
  .regex(/^\/[A-Za-z0-9_./~-]+$/)
  .refine(
    (value) =>
      !value.startsWith('//') &&
      !value.split('/').some((segment) => segment === '.' || segment === '..'),
  );
const targetTestIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const targetFeatureSchema = z.strictObject({
  id: targetIdentifierSchema.max(100),
  method: z.literal('GET'),
  path: targetPathSchema,
  denialStatuses: z
    .array(z.number().int().min(400).max(499))
    .min(1)
    .max(16)
    .refine((statuses) => new Set(statuses).size === statuses.length),
  browserPath: targetPathSchema,
  actionTestId: targetTestIdSchema,
  resultTestId: targetTestIdSchema,
});
export type TargetFeature = Readonly<z.infer<typeof targetFeatureSchema>>;

export const targetDescriptionSchema = z.strictObject({
  adapterVersion: z.literal('1'),
  environment: z.literal('test'),
  buildId: targetIdentifierSchema,
  billingTimeModel: z.literal('provider_status'),
  feature: targetFeatureSchema,
});
export type TargetDescription = Readonly<z.infer<typeof targetDescriptionSchema>>;

export const targetPrincipalIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_-]+$/);
export const targetFixtureReceiptSchema = z.strictObject({
  principalId: targetPrincipalIdSchema,
  runId: z.string().min(1).max(255),
  fixtureMarker: z.string().min(1).max(2_048),
});
const targetLinkReceiptSchema = z.strictObject({
  principalId: targetPrincipalIdSchema,
  runId: z.string().min(1).max(255),
  customerId: z.string().min(1).max(255),
});
const targetSessionReceiptSchema = z.object({
  cookie: z.string(),
  expiresAt: z.string(),
});
const targetCleanupReceiptSchema = z.strictObject({
  removed: z.literal(true),
  principalId: targetPrincipalIdSchema,
  runId: z.string().min(1).max(255),
});

function principalPath(principalId: string): string {
  const safe = targetPrincipalIdSchema.safeParse(principalId);
  if (!safe.success) throw new Error('FIXTURE_IDENTITY_MISMATCH');
  return encodeURIComponent(safe.data);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isContractJson(headers: IncomingHttpHeaders): boolean {
  return (
    firstHeader(headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase() ===
    'application/json'
  );
}

function preventsCaching(headers: IncomingHttpHeaders): boolean {
  return Boolean(
    firstHeader(headers['cache-control'])
      ?.split(',')
      .some((directive) => directive.trim().toLowerCase() === 'no-store'),
  );
}

export class TargetContractV1Adapter {
  constructor(
    readonly transport: TargetTransport,
    private readonly token: string,
    private readonly beforeMutation?: (
      runId: string,
      kind: 'create_user' | 'link_customer' | 'session' | 'cleanup',
    ) => void,
  ) {}

  private async call(
    path: string,
    expectedStatus: number,
    method = 'GET',
    body?: unknown,
    beforeDispatch?: () => void,
  ) {
    const response = await this.transport.request(path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      beforeDispatch,
    });
    if (response.status !== expectedStatus) throw new Error(`TARGET_ADAPTER_${response.status}`);
    if (!isContractJson(response.headers)) throw new Error('TARGET_ADAPTER_MEDIA_TYPE');
    if (!preventsCaching(response.headers)) throw new Error('TARGET_ADAPTER_CACHE_POLICY');
    return response.body;
  }

  async describe() {
    return targetDescriptionSchema.parse(await this.call('/staging/describe', 200));
  }

  async createUser(input: { runId: string; operationId: string; fixtureMarker: string }) {
    const receipt = targetFixtureReceiptSchema.safeParse(
      await this.call('/staging/users', 201, 'POST', input, () =>
        this.beforeMutation?.(input.runId, 'create_user'),
      ),
    );
    if (
      !receipt.success ||
      receipt.data.runId !== input.runId ||
      receipt.data.fixtureMarker !== input.fixtureMarker
    )
      throw new Error('FIXTURE_IDENTITY_MISMATCH');
    return receipt.data;
  }

  async linkCustomer(input: { runId: string; principalId: string; customerId: string }) {
    const receipt = targetLinkReceiptSchema.safeParse(
      await this.call(
        `/staging/users/${principalPath(input.principalId)}/customer`,
        200,
        'POST',
        { runId: input.runId, customerId: input.customerId },
        () => this.beforeMutation?.(input.runId, 'link_customer'),
      ),
    );
    if (
      !receipt.success ||
      receipt.data.principalId !== input.principalId ||
      receipt.data.runId !== input.runId ||
      receipt.data.customerId !== input.customerId
    )
      throw new Error('FIXTURE_IDENTITY_MISMATCH');
    return receipt.data;
  }

  async session(input: { runId: string; principalId: string }) {
    return targetSessionReceiptSchema.parse(
      await this.call(
        `/staging/users/${principalPath(input.principalId)}/session`,
        200,
        'POST',
        { runId: input.runId },
        () => this.beforeMutation?.(input.runId, 'session'),
      ),
    );
  }

  async snapshot(input: { runId: string; principalId: string }) {
    return this.call(
      `/staging/users/${principalPath(input.principalId)}/billing?runId=${encodeURIComponent(input.runId)}`,
      200,
    );
  }

  async cleanup(input: { runId: string; principalId: string }) {
    const receipt = targetCleanupReceiptSchema.safeParse(
      await this.call(
        `/staging/users/${principalPath(input.principalId)}?runId=${encodeURIComponent(input.runId)}`,
        200,
        'DELETE',
        undefined,
        () => this.beforeMutation?.(input.runId, 'cleanup'),
      ),
    );
    if (
      !receipt.success ||
      receipt.data.principalId !== input.principalId ||
      receipt.data.runId !== input.runId
    )
      throw new Error('CLEANUP_RECEIPT_MISMATCH');
    return receipt.data;
  }

  async probe(cookie: string, feature: TargetDescription['feature']) {
    const response = await this.transport.request(feature.path, { headers: { Cookie: cookie } });
    return {
      status: response.status,
      body: response.body,
      transportError: false,
      denialStatuses: feature.denialStatuses,
    };
  }
}
