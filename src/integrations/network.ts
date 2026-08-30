import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

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
