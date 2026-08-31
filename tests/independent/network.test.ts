import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicAddress, TargetTransport } from '#integrations/network';
import { TargetContractV1Adapter, type TargetDescription } from '#integrations/target-contract';
import { BrowserRunner } from '#integrations/browser';
import { evaluateProbe } from '#domain';

// Independent synthetic local faults only. Servers bind ephemeral 127.0.0.1
// ports, and the browser runs only through the public BrowserRunner boundary.
// Nothing here is a provider receipt or reference-application acceptance run.

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
type BrowserResult = Awaited<ReturnType<BrowserRunner['probe']>>;
const fixtureMarker = 'SYNTHETIC_PROTECTED_MARKER_NETWORK_7143';
const ordinaryCookie = 'pp_session=SYNTHETIC_ORDINARY_USER_7143';
const defaultFeature = {
  id: 'pro_export',
  method: 'GET',
  path: '/api/export',
  denialStatuses: [403],
  browserPath: '/dashboard',
  actionTestId: 'export-button',
  resultTestId: 'export-result',
} satisfies TargetDescription['feature'];
const servers = new Set<Server>();
const intervals = new Set<ReturnType<typeof setInterval>>();
let directory: string;

async function serve(handler: Handler) {
  const server = createServer(handler);
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Expected ephemeral IPv4 server');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function pause(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
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

function verdict(result: BrowserResult, expected: 'allow' | 'deny') {
  return evaluateProbe({ expected: { kind: expected }, probe: result.probe, fixtureMarker })
    .verdict;
}

type PageOptions = {
  ui: 'allowed' | 'denied';
  networkStatus: number;
  networkBody: unknown;
  visibleMarker?: string;
  beforeExport?: string;
  exportRedirect?: string;
  extraHandler?: Handler;
  feature?: TargetDescription['feature'];
};

function htmlPage(options: PageOptions) {
  const feature = options.feature ?? defaultFeature;
  const displayed =
    options.ui === 'allowed'
      ? (options.visibleMarker ?? fixtureMarker)
      : (options.visibleMarker ?? 'Access denied');
  return `<!doctype html><html><body>
    <button type="button" data-testid=${JSON.stringify(feature.actionTestId)}>Export</button>
    <section data-testid=${JSON.stringify(feature.resultTestId)} data-status="idle"></section>
    <script>
      document.querySelector('[data-testid=${JSON.stringify(feature.actionTestId)}]').addEventListener('click', async () => {
        const output = document.querySelector('[data-testid=${JSON.stringify(feature.resultTestId)}]');
        output.dataset.status = 'loading';
        ${options.beforeExport ?? ''}
        try {
          const response = await fetch(${JSON.stringify(feature.path)}, {credentials: 'same-origin'});
          await response.text();
          const pre = document.createElement('pre');
          pre.textContent = ${JSON.stringify(displayed)};
          output.replaceChildren(pre);
          output.dataset.status = ${JSON.stringify(options.ui)};
        } catch {
          output.textContent = 'Synthetic local request unavailable';
          output.dataset.status = 'unavailable';
        }
      });
    </script></body></html>`;
}

async function browserFixture(options: PageOptions) {
  const feature = options.feature ?? defaultFeature;
  const observed: { path: string; cookie: string | undefined }[] = [];
  const local = await serve((request, response) => {
    const path = request.url ?? '/';
    observed.push({ path, cookie: request.headers.cookie });
    if (path === feature.browserPath) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(htmlPage(options));
    } else if (path === '/api/me') {
      sendJson(response, 200, {
        principalId: 'synthetic-user',
        canExport: true,
        executionMode: 'local_replay',
      });
    } else if (path === feature.path) {
      if (options.exportRedirect) {
        response.writeHead(302, { location: options.exportRedirect });
        response.end('Synthetic redirect');
      } else sendJson(response, options.networkStatus, options.networkBody);
    } else if (options.extraHandler) options.extraHandler(request, response);
    else {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  const transport = new TargetTransport({
    origin: local.origin,
    allowLoopback: true,
    timeoutMs: 4_000,
  });
  const runner = new BrowserRunner(transport, directory);
  return { ...local, runner, observed, feature };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'paywallproof-independent-network-'));
});

afterEach(async () => {
  for (const interval of intervals) clearInterval(interval);
  intervals.clear();
  for (const server of servers) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
  servers.clear();
  rmSync(directory, { recursive: true, force: true });
});

describe('independent network: pure address classification', () => {
  it.each([
    '',
    'localhost',
    'example.invalid',
    '127.0.0.1.evil.invalid',
    '127.1',
    '2130706433',
    '0x7f000001',
    '0177.0.0.1',
    'http://127.0.0.1',
    '127.0.0.1:80',
    ' 8.8.8.8',
    '999.1.1.1',
  ])('does not authorize malformed or non-IP text %s', (address) => {
    expect(publicAddress(address)).toBe(false);
  });

  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.254',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.0.1',
    '192.168.255.254',
    '198.18.0.1',
    '198.19.255.254',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.254',
    '240.0.0.1',
    '255.255.255.255',
  ])('rejects forbidden IPv4 range member %s without connecting', (address) => {
    expect(publicAddress(address)).toBe(false);
  });

  it.each([
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    '::ffff:a00:1',
  ])('rejects forbidden IPv6 or mapped-private address %s without connecting', (address) => {
    expect(publicAddress(address)).toBe(false);
  });
});

describe('independent network: checked target transport', () => {
  // Implementation-aware deadline regressions added after transport hardening.
  it('applies its default request deadline while DNS resolution is still pending', async () => {
    const transport = new TargetTransport({
      origin: 'https://example.com',
      allowLoopback: false,
      timeoutMs: 10,
      lookupHost: () => new Promise(() => {}),
    });

    await expect(transport.request('/probe')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('preserves an already-aborted caller signal without starting DNS resolution', async () => {
    let lookups = 0;
    const transport = new TargetTransport({
      origin: 'https://example.com',
      allowLoopback: false,
      timeoutMs: 1_000,
      lookupHost: () => {
        lookups += 1;
        return new Promise(() => {});
      },
    });
    const caller = new AbortController();
    const reason = new Error('CALLER_ABORTED');
    caller.abort(reason);

    await expect(transport.request('/probe', { signal: caller.signal })).rejects.toBe(reason);
    expect(lookups).toBe(0);
  });

  it('bounds DNS resolution with the caller deadline before any request dispatch', async () => {
    const transport = new TargetTransport({
      origin: 'https://example.com',
      allowLoopback: false,
      lookupHost: () => new Promise(() => {}),
    });

    await expect(transport.destination(AbortSignal.timeout(10))).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('returns the actual JSON, raw JSON, and plain-text response bodies', async () => {
    const local = await serve((request, response) => {
      if (request.url === '/json')
        sendJson(response, 200, { observed: 'synthetic-value', count: 7 });
      else {
        response.writeHead(418, { 'content-type': 'text/plain' });
        response.end('actual synthetic response text');
      }
    });
    const transport = new TargetTransport({
      origin: local.origin,
      allowLoopback: true,
      timeoutMs: 1_000,
    });
    const structured = await transport.request('/json');
    expect(structured.status).toBe(200);
    expect(structured.body).toEqual({ observed: 'synthetic-value', count: 7 });
    expect(new TextDecoder().decode(structured.rawBody)).toBe(
      '{"observed":"synthetic-value","count":7}',
    );
    const text = await transport.request('/text');
    expect(text.status).toBe(418);
    expect(text.body).toBe('actual synthetic response text');
    expect(new TextDecoder().decode(text.rawBody)).toBe('actual synthetic response text');
  }, 5_000);

  it('does not invent parsed data when the body is malformed JSON', async () => {
    const local = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{not-json');
    });
    const transport = new TargetTransport({
      origin: local.origin,
      allowLoopback: true,
      timeoutMs: 1_000,
    });
    const response = await transport.request('/malformed');
    expect(response.body).toBe('{not-json');
    expect(new TextDecoder().decode(response.rawBody)).toBe('{not-json');
  }, 5_000);

  it('requires the explicit loopback exception before contacting an exact local target', async () => {
    let hits = 0;
    const local = await serve((_request, response) => {
      hits += 1;
      sendJson(response, 200, {});
    });
    await expectRejected(async () => {
      const transport = new TargetTransport({
        origin: local.origin,
        allowLoopback: false,
        timeoutMs: 300,
      });
      await transport.request('/probe');
    });
    await pause(30);
    expect(hits).toBe(0);
  }, 5_000);

  it('rejects origin userinfo, path, query, fragment, and localhost substitutions', async () => {
    const local = await serve((_request, response) => {
      response.end('should not connect');
    });
    const port = new URL(local.origin).port;
    for (const origin of [
      `${local.origin}/forbidden`,
      `${local.origin}?query=1`,
      `${local.origin}#fragment`,
      `http://user:password@127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ])
      expect(() => new TargetTransport({ origin, allowLoopback: true, timeoutMs: 300 })).toThrow();
  }, 5_000);

  it.each([
    '',
    'relative/path',
    '//127.0.0.1/escape',
    'http://127.0.0.1/escape',
    '/\\escape',
    '/api\\export',
    '\\escape',
  ])(
    'rejects noncanonical request path %s without dispatch',
    async (path) => {
      let hits = 0;
      const local = await serve((_request, response) => {
        hits += 1;
        response.end('unexpected');
      });
      const transport = new TargetTransport({
        origin: local.origin,
        allowLoopback: true,
        timeoutMs: 300,
      });
      await expectRejected(() => transport.request(path));
      await pause(30);
      expect(hits).toBe(0);
    },
    5_000,
  );

  it('never follows a redirect or sends credentials to its second local destination', async () => {
    let destinationHits = 0;
    let firstHits = 0;
    const destination = await serve((_request, response) => {
      destinationHits += 1;
      sendJson(response, 200, { fixtureMarker });
    });
    const local = await serve((_request, response) => {
      firstHits += 1;
      response.writeHead(302, { location: `${destination.origin}/credential-capture` });
      response.end('redirect');
    });
    const transport = new TargetTransport({
      origin: local.origin,
      allowLoopback: true,
      timeoutMs: 1_000,
    });
    let redirectedResponse: Awaited<ReturnType<TargetTransport['request']>> | undefined;
    try {
      redirectedResponse = await transport.request('/redirect', {
        headers: { cookie: ordinaryCookie, authorization: 'Bearer SYNTHETIC_DO_NOT_FORWARD' },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    if (redirectedResponse !== undefined) expect(redirectedResponse.status).toBe(302);
    await pause(50);
    expect(firstHits).toBe(1);
    expect(destinationHits).toBe(0);
  }, 5_000);

  it('runs the synchronous beforeDispatch gate before the target sees a request', async () => {
    const order: string[] = [];
    const local = await serve((_request, response) => {
      order.push('server');
      sendJson(response, 200, { ok: true });
    });
    const transport = new TargetTransport({
      origin: local.origin,
      allowLoopback: true,
      timeoutMs: 1_000,
    });
    await transport.request('/probe', {
      beforeDispatch: () => {
        expect(order).toEqual([]);
        order.push('gate');
      },
    });
    expect(order).toEqual(['gate', 'server']);
  }, 5_000);

  it('dispatches zero target requests when beforeDispatch throws', async () => {
    let hits = 0;
    let gateCalls = 0;
    const local = await serve((_request, response) => {
      hits += 1;
      sendJson(response, 200, {});
    });
    const transport = new TargetTransport({
      origin: local.origin,
      allowLoopback: true,
      timeoutMs: 1_000,
    });
    await expectRejected(() =>
      transport.request('/mutating-endpoint', {
        method: 'POST',
        body: '{}',
        beforeDispatch: () => {
          gateCalls += 1;
          throw new Error('Synthetic authorization revoked');
        },
      }),
    );
    await pause(50);
    expect(gateCalls).toBe(1);
    expect(hits).toBe(0);
  }, 5_000);

  it.each(['ascii', 'multibyte'])(
    'rejects a response over one MiB counted as bytes: %s',
    async (encoding) => {
      const payload =
        encoding === 'ascii'
          ? 'x'.repeat(1024 * 1024 + 1)
          : '€'.repeat(Math.floor((1024 * 1024) / 3) + 1);
      const local = await serve((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(payload);
      });
      const transport = new TargetTransport({
        origin: local.origin,
        allowLoopback: true,
        timeoutMs: 1_000,
      });
      await expectRejected(() => transport.request('/oversized'));
    },
    5_000,
  );

  it('enforces an overall deadline while response chunks keep arriving', async () => {
    const local = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('first');
      const interval = setInterval(() => response.write('still-streaming'), 30);
      intervals.add(interval);
      response.on('close', () => {
        clearInterval(interval);
        intervals.delete(interval);
      });
    });
    const transport = new TargetTransport({
      origin: local.origin,
      allowLoopback: true,
      timeoutMs: 200,
    });
    const started = Date.now();
    await expectRejected(() => transport.request('/never-completes'));
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 5_000);
});

// Implementation-aware regressions added after the contract-v1 adapter was extracted.
describe('independent network: contract-v1 mutation receipts', () => {
  function adapter(origin: string) {
    return new TargetContractV1Adapter(
      new TargetTransport({ origin, allowLoopback: true, timeoutMs: 1_000 }),
      'synthetic-adapter-token',
    );
  }

  it('rejects a create receipt whose principal is not a safe opaque path segment', async () => {
    const requests: string[] = [];
    const local = await serve((request, response) => {
      requests.push(request.url ?? '/');
      sendJson(response, 201, {
        principalId: '..',
        runId: 'run-receipt',
        fixtureMarker,
      });
    });

    await expect(
      adapter(local.origin).createUser({
        runId: 'run-receipt',
        operationId: 'create-receipt',
        fixtureMarker,
      }),
    ).rejects.toThrow('FIXTURE_IDENTITY_MISMATCH');
    expect(requests).toEqual(['/staging/users']);
  });

  it('rejects unsafe principals before dispatching any user-scoped request', async () => {
    let requests = 0;
    const local = await serve((_request, response) => {
      requests += 1;
      sendJson(response, 200, {});
    });
    const target = adapter(local.origin);
    const principalId = '../victim';

    await expect(
      target.linkCustomer({ runId: 'run-safe-path', principalId, customerId: 'cus_safe' }),
    ).rejects.toThrow('FIXTURE_IDENTITY_MISMATCH');
    await expect(target.session({ runId: 'run-safe-path', principalId })).rejects.toThrow(
      'FIXTURE_IDENTITY_MISMATCH',
    );
    await expect(target.snapshot({ runId: 'run-safe-path', principalId })).rejects.toThrow(
      'FIXTURE_IDENTITY_MISMATCH',
    );
    await expect(target.cleanup({ runId: 'run-safe-path', principalId })).rejects.toThrow(
      'FIXTURE_IDENTITY_MISMATCH',
    );
    expect(requests).toBe(0);
  });

  it('requires the link response to echo the exact owned identities', async () => {
    const local = await serve((_request, response) => {
      sendJson(response, 200, {
        principalId: 'usr_owned',
        runId: 'another-run',
        customerId: 'cus_owned',
      });
    });

    await expect(
      adapter(local.origin).linkCustomer({
        runId: 'run-owned',
        principalId: 'usr_owned',
        customerId: 'cus_owned',
      }),
    ).rejects.toThrow('FIXTURE_IDENTITY_MISMATCH');
  });

  it('treats a successful HTTP cleanup without an exact removal receipt as unconfirmed', async () => {
    const local = await serve((_request, response) => {
      sendJson(response, 200, {
        removed: false,
        principalId: 'usr_owned',
        runId: 'run-owned',
      });
    });

    await expect(
      adapter(local.origin).cleanup({ runId: 'run-owned', principalId: 'usr_owned' }),
    ).rejects.toThrow('CLEANUP_RECEIPT_MISMATCH');
  });

  it('does not treat an accepted-but-incomplete cleanup as deletion', async () => {
    const local = await serve((_request, response) => {
      sendJson(response, 202, {
        removed: true,
        principalId: 'usr_owned',
        runId: 'run-owned',
      });
    });

    await expect(
      adapter(local.origin).cleanup({ runId: 'run-owned', principalId: 'usr_owned' }),
    ).rejects.toThrow('TARGET_ADAPTER_202');
  });

  it('rejects a JSON-looking lifecycle response with the wrong media type', async () => {
    const local = await serve((_request, response) => {
      response.writeHead(201, {
        'content-type': 'text/plain',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify({ principalId: 'usr_owned', runId: 'run-owned', fixtureMarker }));
    });

    await expect(
      adapter(local.origin).createUser({
        runId: 'run-owned',
        operationId: 'create-owned',
        fixtureMarker,
      }),
    ).rejects.toThrow('TARGET_ADAPTER_MEDIA_TYPE');
  });
});

describe('independent network: real browser against synthetic local HTML', () => {
  // Implementation-aware regression added when feature descriptors became portable.
  it('uses the validated feature paths and test ids instead of reference-app constants', async () => {
    const feature = {
      id: 'pipeline_export',
      method: 'GET',
      path: '/api/paywallproof/export',
      denialStatuses: [403],
      browserPath: '/admin',
      actionTestId: 'pipeline-export-button',
      resultTestId: 'pipeline-export-result',
    } satisfies TargetDescription['feature'];
    const local = await browserFixture({
      feature,
      ui: 'allowed',
      networkStatus: 200,
      networkBody: { fixtureMarker },
    });

    const result = await local.runner.probe(ordinaryCookie, feature);

    expect(verdict(result, 'allow')).toBe('pass');
    expect(local.observed.some((entry) => entry.path === '/admin')).toBe(true);
    expect(local.observed.some((entry) => entry.path === '/api/paywallproof/export')).toBe(true);
    expect(local.observed.some((entry) => entry.path === '/dashboard')).toBe(false);
  }, 20_000);

  it('requires matching visible and network allowance using an ordinary session', async () => {
    const local = await browserFixture({
      ui: 'allowed',
      networkStatus: 200,
      networkBody: { fixtureMarker },
    });
    const result = await local.runner.probe(ordinaryCookie, local.feature);
    expect(verdict(result, 'allow')).toBe('pass');
    expect(result).toHaveProperty('artifact');
    expect(local.observed.some((entry) => entry.path === '/dashboard')).toBe(true);
    expect(
      local.observed.some(
        (entry) => entry.path === '/api/export' && entry.cookie?.includes(ordinaryCookie),
      ),
    ).toBe(true);
  }, 20_000);

  it('accepts visible denial backed by the real network denial contract', async () => {
    const local = await browserFixture({
      ui: 'denied',
      networkStatus: 403,
      networkBody: { error: 'ACCESS_DENIED' },
    });
    expect(verdict(await local.runner.probe(ordinaryCookie, local.feature), 'deny')).toBe('pass');
  }, 20_000);

  it('does not discard leaked network data because the UI claims denial', async () => {
    const local = await browserFixture({
      ui: 'denied',
      networkStatus: 403,
      networkBody: { error: 'ACCESS_DENIED', nested: { leaked: fixtureMarker } },
    });
    const result = await local.runner.probe(ordinaryCookie, local.feature);
    expect(JSON.stringify(result.probe.body)).toContain(fixtureMarker);
    expect(verdict(result, 'deny')).toBe('fail');
  }, 20_000);

  it('does not pass visible denial backed by malformed network denial', async () => {
    const local = await browserFixture({
      ui: 'denied',
      networkStatus: 403,
      networkBody: { error: 'UNRELATED_ERROR' },
    });
    expect(verdict(await local.runner.probe(ordinaryCookie, local.feature), 'deny')).toBe(
      'inconclusive',
    );
  }, 20_000);

  it('cannot pass allowance when UI renders a marker but the network denied it', async () => {
    const local = await browserFixture({
      ui: 'allowed',
      networkStatus: 403,
      networkBody: { error: 'ACCESS_DENIED' },
    });
    const result = await local.runner.probe(ordinaryCookie, local.feature);
    expect(verdict(result, 'allow')).not.toBe('pass');
    expect(verdict(result, 'deny')).toBe('fail');
  }, 20_000);

  it('does not ignore a visible protected marker inside a denied result', async () => {
    const local = await browserFixture({
      ui: 'denied',
      visibleMarker: `Access denied ${fixtureMarker}`,
      networkStatus: 403,
      networkBody: { error: 'ACCESS_DENIED' },
    });
    expect(verdict(await local.runner.probe(ordinaryCookie, local.feature), 'deny')).toBe('fail');
  }, 20_000);

  it('does not pass when the visible marker disagrees with a successful network marker', async () => {
    const local = await browserFixture({
      ui: 'allowed',
      visibleMarker: 'WRONG_VISIBLE_MARKER',
      networkStatus: 200,
      networkBody: { fixtureMarker },
    });
    expect(verdict(await local.runner.probe(ordinaryCookie, local.feature), 'allow')).not.toBe(
      'pass',
    );
  }, 20_000);

  it('blocks a permitted export endpoint redirect before reaching another local port', async () => {
    let redirectedHits = 0;
    const destination = await serve((_request, response) => {
      redirectedHits += 1;
      sendJson(response, 200, { fixtureMarker });
    });
    const local = await browserFixture({
      ui: 'allowed',
      networkStatus: 200,
      networkBody: { fixtureMarker },
      exportRedirect: `${destination.origin}/api/export`,
    });
    const result = await local.runner.probe(ordinaryCookie, local.feature);
    await pause(50);
    expect(local.observed.some((entry) => entry.path === '/api/export')).toBe(true);
    expect(redirectedHits).toBe(0);
    expect(verdict(result, 'allow')).not.toBe('pass');
  }, 20_000);

  it('blocks an unapproved same-origin path before any server request', async () => {
    let forbiddenHits = 0;
    const local = await browserFixture({
      ui: 'allowed',
      networkStatus: 200,
      networkBody: { fixtureMarker },
      beforeExport: "await fetch('/admin/private').catch(() => undefined);",
      extraHandler: (_request, response) => {
        forbiddenHits += 1;
        sendJson(response, 200, { forbidden: true });
      },
    });
    await local.runner.probe(ordinaryCookie, local.feature);
    expect(forbiddenHits).toBe(0);
  }, 20_000);

  it('blocks a direct fetch to another local origin', async () => {
    let foreignHits = 0;
    const destination = await serve((_request, response) => {
      foreignHits += 1;
      response.end('forbidden');
    });
    const local = await browserFixture({
      ui: 'allowed',
      networkStatus: 200,
      networkBody: { fixtureMarker },
      beforeExport: `await fetch(${JSON.stringify(`${destination.origin}/private`)}).catch(() => undefined);`,
    });
    await local.runner.probe(ordinaryCookie, local.feature);
    expect(foreignHits).toBe(0);
  }, 20_000);

  it('does not allow a WebSocket handshake to bypass origin restrictions', async () => {
    let ordinaryHits = 0;
    let upgrades = 0;
    const destination = await serve((_request, response) => {
      ordinaryHits += 1;
      response.end('forbidden');
    });
    destination.server.on('upgrade', (_request, socket) => {
      upgrades += 1;
      socket.destroy();
    });
    const socketUrl = `${destination.origin.replace('http:', 'ws:')}/socket`;
    const local = await browserFixture({
      ui: 'allowed',
      networkStatus: 200,
      networkBody: { fixtureMarker },
      beforeExport: `const socket = new WebSocket(${JSON.stringify(socketUrl)}); socket.onerror = () => {}; await new Promise(resolve => setTimeout(resolve, 100));`,
    });
    await local.runner.probe(ordinaryCookie, local.feature);
    expect(ordinaryHits).toBe(0);
    expect(upgrades).toBe(0);
  }, 20_000);

  it('disables service-worker registration even under an allowed asset prefix', async () => {
    let workerScriptHits = 0;
    const local = await browserFixture({
      ui: 'allowed',
      networkStatus: 200,
      networkBody: { fixtureMarker },
      beforeExport:
        "if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/_next/synthetic-sw.js').catch(() => undefined);",
      extraHandler: (_request, response) => {
        workerScriptHits += 1;
        response.writeHead(200, { 'content-type': 'application/javascript' });
        response.end("self.addEventListener('fetch', () => {});");
      },
    });
    await local.runner.probe(ordinaryCookie, local.feature);
    expect(workerScriptHits).toBe(0);
  }, 20_000);
});
