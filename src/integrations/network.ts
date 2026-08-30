import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { z } from 'zod';
import { targetDescriptionSchema, type TargetDescription } from '../adapter-doctor/report.ts';

export { targetDescriptionSchema } from '../adapter-doctor/report.ts';

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

function isContractJson(headers: http.IncomingHttpHeaders): boolean {
  return (
    firstHeader(headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase() ===
    'application/json'
  );
}

function preventsCaching(headers: http.IncomingHttpHeaders): boolean {
  return Boolean(
    firstHeader(headers['cache-control'])
      ?.split(',')
      .some((directive) => directive.trim().toLowerCase() === 'no-store'),
  );
}

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const a = octets[0] ?? 0,
      b = octets[1] ?? 0;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  // Globally routed unicast only; reject mapped/translated, local, multicast and documentation ranges.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(db8|0|10|20):/i.test(address)
  );
}
export class TargetTransport {
  readonly origin: URL;
  constructor(
    readonly config: {
      origin: string;
      allowLoopback: boolean;
      timeoutMs?: number;
      lookupHost?: (hostname: string) => Promise<{ address: string; family: number }[]>;
    },
  ) {
    this.origin = new URL(config.origin);
    if (
      this.origin.username ||
      this.origin.password ||
      this.origin.search ||
      this.origin.hash ||
      this.origin.pathname !== '/'
    )
      throw new Error('INVALID_TARGET_ORIGIN');
    if (
      this.origin.protocol !== 'https:' &&
      !(
        config.allowLoopback &&
        this.origin.protocol === 'http:' &&
        this.origin.hostname === '127.0.0.1'
      )
    )
      throw new Error('HTTPS_REQUIRED');
    if (this.origin.hostname === 'localhost') throw new Error('USE_EXPLICIT_LOOPBACK_ADDRESS');
  }
  private withDeadline(signal?: AbortSignal): AbortSignal {
    const deadline = AbortSignal.timeout(this.config.timeoutMs ?? 30_000);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
  }
  private async resolveDestination(signal: AbortSignal) {
    const hostname = this.origin.hostname.replace(/^\[|\]$/g, '');
    signal.throwIfAborted();
    if (this.config.allowLoopback && hostname === '127.0.0.1')
      return { address: hostname, family: 4 };
    const lookupResult = this.config.lookupHost
      ? this.config.lookupHost(hostname)
      : lookup(hostname, { all: true, verbatim: true });
    const addresses = await new Promise<Awaited<typeof lookupResult>>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      void lookupResult.then(
        (value) => {
          signal.removeEventListener('abort', aborted);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', aborted);
          reject(error);
        },
      );
    });
    signal.throwIfAborted();
    const first = addresses[0];
    if (!first || addresses.some((record) => !publicAddress(record.address)))
      throw new Error('NETWORK_DESTINATION_REJECTED');
    return first;
  }
  async destination(signal?: AbortSignal) {
    return this.resolveDestination(this.withDeadline(signal));
  }
  async request(
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      beforeDispatch?: () => void;
      signal?: AbortSignal;
      onResponseBytes?: (bytes: number) => void;
    } = {},
  ) {
    const signal = this.withDeadline(options.signal);
    signal.throwIfAborted();
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\'))
      throw new Error('INVALID_TARGET_PATH');
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin.origin || url.username || url.password || url.hash)
      throw new Error('TARGET_SCOPE_REJECTED');
    const destination = await this.resolveDestination(signal);
    signal.throwIfAborted();
    // Pinned Next's Webpack development entry exceeds 12 MB. Only static JS/CSS gets the larger
    // bound; evidence bodies and all mutation responses keep the original cap.
    const staticBundle =
      (options.method ?? 'GET') === 'GET' &&
      /^\/_next\/static\/[A-Za-z0-9_./%~-]+\.(js|css)$/.test(url.pathname);
    const maximumBytes = staticBundle ? 16 * 1024 * 1024 : 1_048_576;
    options.beforeDispatch?.();
    return new Promise<{
      status: number;
      body: unknown;
      rawBody: Buffer;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http;
      const request = client.request(
        url,
        {
          method: options.method ?? 'GET',
          headers: { ...options.headers, 'Accept-Encoding': 'identity' },
          signal,
          // Pin the checked address for this connection. DNS cannot change between validation and dispatch.
          lookup: (_hostname, _options, callback) =>
            callback(null, destination.address, destination.family),
          // macOS can exhaust wildcard ephemeral ports while loopback still has
          // capacity. Bind only the explicitly authorized loopback connection.
          ...(this.config.allowLoopback && destination.address === '127.0.0.1'
            ? { localAddress: '127.0.0.1' }
            : {}),
          agent: false,
        },
        (response) => {
          const status = response.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(new Error('REDIRECT_REJECTED'));
            return;
          }
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maximumBytes) {
              response.destroy(new Error('RESPONSE_LIMIT'));
              return;
            }
            try {
              options.onResponseBytes?.(chunk.length);
            } catch {
              response.destroy(new Error('RESPONSE_BUDGET_EXCEEDED'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            const rawBody = Buffer.concat(chunks);
            const text = rawBody.toString('utf8');
            let body: unknown = text;
            try {
              body = JSON.parse(text);
            } catch {
              /* Non-JSON is evidence, never an invented successful response. */
            }
            resolve({ status, body, rawBody, headers: response.headers });
          });
        },
      );
      request.on('error', reject);
      if (options.body) request.write(options.body);
      request.end();
    });
  }
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
    return z
      .object({ cookie: z.string(), expiresAt: z.string() })
      .parse(
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
