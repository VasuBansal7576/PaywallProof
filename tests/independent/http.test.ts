import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createControlApp } from '../../apps/worker/src/http.ts';

// Independent HTTP tests from docs/contracts/http-contract.md and the owner's supplied
// factory/auth clarification. Only app.request and close are used.
// No preflight, run creation, provider, runtime, or target request is invoked.

type ControlApp = ReturnType<typeof createControlApp>;
const workerOrigin = 'http://127.0.0.1:8787';
const webOrigin = 'http://127.0.0.1:3000';
const operatorToken = 'SYNTHETIC_OPERATOR_TOKEN_HTTP_33881';
const adapterToken = 'SYNTHETIC_ADAPTER_TOKEN_HTTP_33881';
const replaySecret = 'whsec_SYNTHETIC_REPLAY_HTTP_33881';
const repository = 'synthetic-owner/paywallproof-test';
const defaultRef = 'main';
let directory: string;
let databasePath: string;
let artifactDirectory: string;
const applications = new Set<ControlApp>();

function open() {
  const application = createControlApp({
    databasePath,
    artifactDirectory,
    targetOrigin: 'http://127.0.0.1:39991',
    workerOrigin,
    webOrigin,
    adapterToken,
    replaySecret,
    operatorToken,
    repository,
    defaultRef,
    priceId: 'price_pro_synthetic',
    runtimeUrl: 'http://127.0.0.1:39992',
    model: 'synthetic-local-model',
  });
  applications.add(application);
  return application;
}

async function close(application: ControlApp) {
  await application.close();
  applications.delete(application);
}

async function request(
  application: ControlApp,
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return application.app.request(`${workerOrigin}${path}`, {
    method,
    headers: {
      host: new URL(workerOrigin).host,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function bearer(requestId?: string) {
  return {
    authorization: `Bearer ${operatorToken}`,
    ...(requestId === undefined ? {} : { 'x-request-id': requestId }),
  };
}

function projectInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Independent HTTP project',
    repository,
    ref: defaultRef,
    targetId: 'reference',
    ownershipConfirmed: true,
    modelConsent: true,
    ...overrides,
  };
}

function stringField(value: unknown, key: string): string {
  if (typeof value === 'object' && value !== null) {
    const result: unknown = Reflect.get(value, key);
    if (typeof result === 'string') return result;
  }
  throw new Error(`Expected string response field ${key}`);
}

async function json(response: Response) {
  const body: unknown = await response.json();
  return body;
}

async function expectError(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  const body = await json(response);
  expect(body).toMatchObject({
    error: { code: code ?? expect.any(String), message: expect.any(String) },
  });
  const serialized = JSON.stringify(body);
  for (const secret of [operatorToken, adapterToken, replaySecret])
    expect(serialized).not.toContain(secret);
}

async function login(application: ControlApp) {
  const response = await request(
    application,
    '/api/login',
    'POST',
    { token: operatorToken },
    { origin: webOrigin },
  );
  expect(response.status).toBe(200);
  const body = await json(response);
  const csrfToken = stringField(body, 'csrfToken');
  expect(csrfToken).not.toHaveLength(0);
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  expect(setCookie).toMatch(/(?:^|;)\s*httponly(?:;|$)/i);
  const cookie = setCookie?.split(';')[0];
  if (!cookie) throw new Error('Expected session cookie');
  return { cookie, csrfToken };
}

async function createProject(
  application: ControlApp,
  requestId = 'create-project-1',
  body = projectInput(),
) {
  const response = await request(application, '/api/projects', 'POST', body, bearer(requestId));
  expect(response.status).toBe(201);
  const result = await json(response);
  expect(result).toMatchObject({ ...body, id: expect.any(String) });
  return result;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'paywallproof-independent-http-'));
  databasePath = join(directory, 'control.sqlite');
  artifactDirectory = join(directory, 'artifacts');
});

afterEach(async () => {
  for (const application of applications) await close(application);
  rmSync(directory, { recursive: true, force: true });
});

describe('independent control HTTP: authentication', () => {
  it('logs in with the operator token and returns the same session CSRF token', async () => {
    const application = open();
    const current = await login(application);
    const response = await request(application, '/api/session', 'GET', undefined, {
      cookie: current.cookie,
      origin: webOrigin,
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ csrfToken: current.csrfToken });
    expect(current.cookie).not.toContain(operatorToken);
  });

  it('rejects an incorrect login token without issuing a session', async () => {
    const application = open();
    const response = await request(application, '/api/login', 'POST', {
      token: 'WRONG_SYNTHETIC_OPERATOR_TOKEN',
    });
    expect(response.headers.get('set-cookie')).toBeNull();
    await expectError(response, 401, 'UNAUTHORIZED');
  });

  it('rejects unknown login fields', async () => {
    const application = open();
    await expectError(
      await request(application, '/api/login', 'POST', { token: operatorToken, role: 'admin' }),
      400,
      'INVALID_INPUT',
    );
  });

  it.each(['/api/session', '/api/config', '/api/projects', '/api/runs'])(
    'rejects unauthenticated read %s',
    async (path) => {
      const application = open();
      await expectError(await request(application, path), 401, 'UNAUTHORIZED');
    },
  );

  it('rejects an incorrect bearer token', async () => {
    const application = open();
    await expectError(
      await request(application, '/api/config', 'GET', undefined, {
        authorization: 'Bearer WRONG_SYNTHETIC_TOKEN',
      }),
      401,
      'UNAUTHORIZED',
    );
  });

  it('cannot create a project without authentication', async () => {
    const application = open();
    await expectError(
      await request(application, '/api/projects', 'POST', projectInput(), {
        'x-request-id': 'unauthenticated-action',
      }),
      401,
      'UNAUTHORIZED',
    );
    expect(
      await json(await request(application, '/api/projects', 'GET', undefined, bearer())),
    ).toEqual([]);
  });

  it('rejects an unauthenticated MCP request without dispatching a tool', async () => {
    const application = open();
    const response = await request(application, '/mcp', 'POST', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'prepare_fixture', arguments: { runId: 'not-a-run' } },
    });
    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({ error: 'Unauthorized' });
  });
});

describe('independent control HTTP: origin, host, and CSRF', () => {
  it.each([workerOrigin, webOrigin])('accepts configured Origin %s', async (origin) => {
    const application = open();
    const response = await request(application, '/api/config', 'GET', undefined, {
      ...bearer(),
      origin,
    });
    expect(response.status).toBe(200);
  });

  it.each([new URL(workerOrigin).host, new URL(webOrigin).host])(
    'accepts configured Host %s',
    async (host) => {
      const application = open();
      expect(
        (await request(application, '/api/config', 'GET', undefined, { ...bearer(), host })).status,
      ).toBe(200);
    },
  );

  it('permits nonbrowser bearer requests without Origin', async () => {
    const application = open();
    expect((await request(application, '/api/config', 'GET', undefined, bearer())).status).toBe(
      200,
    );
  });

  it.each(['https://unapproved.example.invalid', 'null', 'http://127.0.0.1:8787.attacker.invalid'])(
    'rejects unapproved Origin %s',
    async (origin) => {
      const application = open();
      await expectError(
        await request(application, '/api/config', 'GET', undefined, { ...bearer(), origin }),
        403,
        'ORIGIN_REJECTED',
      );
    },
  );

  it.each(['unapproved.example.invalid', '127.0.0.1:8787.attacker.invalid', '127.0.0.1:8788'])(
    'rejects unapproved Host %s',
    async (host) => {
      const application = open();
      await expectError(
        await request(application, '/api/config', 'GET', undefined, { ...bearer(), host }),
        403,
        'HOST_REJECTED',
      );
    },
  );

  it('requires the correct CSRF token for session-authenticated mutation', async () => {
    const application = open();
    const current = await login(application);
    const headers = {
      cookie: current.cookie,
      origin: webOrigin,
      'x-request-id': 'session-create-1',
    };
    await expectError(
      await request(application, '/api/projects', 'POST', projectInput(), headers),
      403,
      'CSRF_REJECTED',
    );
    await expectError(
      await request(application, '/api/projects', 'POST', projectInput(), {
        ...headers,
        'x-csrf-token': 'WRONG_SYNTHETIC_CSRF',
      }),
      403,
      'CSRF_REJECTED',
    );
    const accepted = await request(application, '/api/projects', 'POST', projectInput(), {
      ...headers,
      'x-csrf-token': current.csrfToken,
    });
    expect(accepted.status).toBe(201);
  });

  it('does not transfer a CSRF token from one session to another', async () => {
    const application = open();
    const first = await login(application);
    const second = await login(application);
    await expectError(
      await request(application, '/api/projects', 'POST', projectInput(), {
        cookie: second.cookie,
        origin: webOrigin,
        'x-request-id': 'cross-session-csrf',
        'x-csrf-token': first.csrfToken,
      }),
      403,
      'CSRF_REJECTED',
    );
  });

  it('allows operator bearer mutation without a CSRF token', async () => {
    const application = open();
    await createProject(application);
  });

  it('still rejects a foreign Origin even with valid bearer authorization', async () => {
    const application = open();
    await expectError(
      await request(application, '/api/projects', 'POST', projectInput(), {
        ...bearer('foreign-origin-action'),
        origin: 'https://unapproved.example.invalid',
      }),
      403,
      'ORIGIN_REJECTED',
    );
    expect(
      await json(await request(application, '/api/projects', 'GET', undefined, bearer())),
    ).toEqual([]);
  });
});

describe('independent control HTTP: configured scope and honest reads', () => {
  it('reports configured target and unavailable Stripe without exposing credentials', async () => {
    const application = open();
    const response = await request(application, '/api/config', 'GET', undefined, bearer());
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({
      target: { id: 'reference', origin: 'http://127.0.0.1:39991' },
      repository,
      defaultRef,
      polarConfigured: false,
      priceId: 'price_pro_synthetic',
      model: 'synthetic-local-model',
      limits: expect.any(Object),
      coverageLimits: expect.any(Array),
    });
    for (const secret of [operatorToken, adapterToken, replaySecret])
      expect(JSON.stringify(body)).not.toContain(secret);
  });

  it('starts with no fabricated projects or runs', async () => {
    const application = open();
    expect(
      await json(await request(application, '/api/projects', 'GET', undefined, bearer())),
    ).toEqual([]);
    expect(await json(await request(application, '/api/runs', 'GET', undefined, bearer()))).toEqual(
      [],
    );
  });

  it('persists only the explicitly approved project fields', async () => {
    const application = open();
    const project = await createProject(application);
    expect(project).toEqual({ ...projectInput(), id: expect.any(String) });
    expect(
      await json(await request(application, '/api/projects', 'GET', undefined, bearer())),
    ).toEqual([project]);
  });

  it.each<[string, string]>([
    ['repository', 'foreign-owner/foreign-repository'],
    ['ref', 'unapproved-branch'],
    ['targetId', 'foreign-target'],
  ])('rejects a project with an unconfigured %s', async (key, value) => {
    const application = open();
    await expectError(
      await request(
        application,
        '/api/projects',
        'POST',
        projectInput({ [key]: value }),
        bearer('scope-rejected'),
      ),
      403,
      'TARGET_SCOPE_REJECTED',
    );
    expect(
      await json(await request(application, '/api/projects', 'GET', undefined, bearer())),
    ).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['ownershipConfirmed', false],
    ['modelConsent', false],
    ['ownershipConfirmed', 'true'],
    ['modelConsent', 1],
    ['name', ''],
    ['name', ' padded'],
    ['repository', ' padded'],
    ['ref', 'main '],
    ['extra', true],
    ['targetOrigin', 'http://127.0.0.1:39993'],
    ['operatorToken', 'replacement-token'],
  ])('rejects malformed or unknown project field %s', async (key, value) => {
    const application = open();
    await expectError(
      await request(
        application,
        '/api/projects',
        'POST',
        projectInput({ [key]: value }),
        bearer('invalid-project'),
      ),
      400,
      'INVALID_INPUT',
    );
    expect(
      await json(await request(application, '/api/projects', 'GET', undefined, bearer())),
    ).toEqual([]);
  });

  it.each(['name', 'repository', 'ref', 'targetId', 'ownershipConfirmed', 'modelConsent'])(
    'requires project field %s',
    async (key) => {
      const application = open();
      const body: Record<string, unknown> = projectInput();
      delete body[key];
      await expectError(
        await request(application, '/api/projects', 'POST', body, bearer('missing-field')),
        400,
        'INVALID_INPUT',
      );
    },
  );

  it('rejects malformed JSON without creating a project', async () => {
    const application = open();
    const response = await application.app.request(`${workerOrigin}/api/projects`, {
      method: 'POST',
      body: '{malformed-json',
      headers: {
        host: new URL(workerOrigin).host,
        'content-type': 'application/json',
        ...bearer('malformed-json-action'),
      },
    });
    await expectError(response, 400);
    expect(
      await json(await request(application, '/api/projects', 'GET', undefined, bearer())),
    ).toEqual([]);
  });

  it.each(['json', 'markdown'])('returns an error for a nonexistent %s report', async (format) => {
    const application = open();
    await expectError(
      await request(
        application,
        `/api/runs/missing-run/report?format=${format}`,
        'GET',
        undefined,
        bearer(),
      ),
      404,
    );
  });

  it('returns no invented run detail or event history for an unknown run', async () => {
    const application = open();
    await expectError(
      await request(application, '/api/runs/missing-run', 'GET', undefined, bearer()),
      404,
    );
    await expectError(
      await request(
        application,
        '/api/runs/missing-run/events?after=0',
        'GET',
        undefined,
        bearer(),
      ),
      404,
    );
  });
});

describe('independent control HTTP: durable action idempotency', () => {
  it('requires a request ID even for bearer-authenticated writes', async () => {
    const application = open();
    await expectError(
      await request(application, '/api/projects', 'POST', projectInput(), bearer()),
      400,
      'INVALID_INPUT',
    );
    await expectError(
      await request(application, '/api/projects', 'POST', projectInput(), {
        ...bearer(),
        'x-request-id': '',
      }),
      400,
      'INVALID_INPUT',
    );
    expect(
      await json(await request(application, '/api/projects', 'GET', undefined, bearer())),
    ).toEqual([]);
  });

  it('replays the original creation status and receipt without duplicate projects', async () => {
    const application = open();
    const first = await createProject(application, 'stable-action');
    expect(await createProject(application, 'stable-action')).toEqual(first);
    expect(
      await json(await request(application, '/api/projects', 'GET', undefined, bearer())),
    ).toEqual([first]);
  });

  it('persists exact retries and conflict detection through factory restart', async () => {
    const application = open();
    const first = await createProject(application, 'restart-action');
    await close(application);
    const reopened = open();
    expect(await createProject(reopened, 'restart-action')).toEqual(first);
    await expectError(
      await request(
        reopened,
        '/api/projects',
        'POST',
        projectInput({ name: 'different-name' }),
        bearer('restart-action'),
      ),
      409,
      'REQUEST_CONFLICT',
    );
    expect(
      await json(await request(reopened, '/api/projects', 'GET', undefined, bearer())),
    ).toEqual([first]);
  });

  it('rejects reusing an action ID for changed arguments', async () => {
    const application = open();
    const first = await createProject(application, 'bound-action');
    await expectError(
      await request(
        application,
        '/api/projects',
        'POST',
        projectInput({ name: 'different-name' }),
        bearer('bound-action'),
      ),
      409,
      'REQUEST_CONFLICT',
    );
    expect(
      await json(await request(application, '/api/projects', 'GET', undefined, bearer())),
    ).toEqual([first]);
  });

  it('does not reuse a creation receipt for a different mutation route', async () => {
    const application = open();
    await createProject(application, 'route-bound-action');
    // A nonexistent cancellation cannot contact a target/runtime even if conflict
    // handling is broken; this never starts a real run or external operation.
    await expectError(
      await request(
        application,
        '/api/runs/missing-run/cancel',
        'POST',
        {},
        bearer('route-bound-action'),
      ),
      409,
      'REQUEST_CONFLICT',
    );
  });

  it('allows a fresh action ID for a distinct approved project creation', async () => {
    const application = open();
    const first = await createProject(application, 'first-action');
    const second = await createProject(
      application,
      'second-action',
      projectInput({ name: 'Second explicit project' }),
    );
    expect(stringField(first, 'id')).not.toBe(stringField(second, 'id'));
    expect(
      await json(await request(application, '/api/projects', 'GET', undefined, bearer())),
    ).toEqual(expect.arrayContaining([first, second]));
  });

  it('keeps reads side-effect free across repeated reconnect-style polling', async () => {
    const application = open();
    const project = await createProject(application);
    for (let i = 0; i < 5; i += 1) {
      expect(
        await json(await request(application, '/api/projects', 'GET', undefined, bearer())),
      ).toEqual([project]);
      expect(
        await json(await request(application, '/api/runs', 'GET', undefined, bearer())),
      ).toEqual([]);
    }
  });
});

describe('independent control HTTP: authenticated screenshot route without seeded runs', () => {
  const screenshotId = '01234567-89ab-4def-8abc-0123456789ab.png';
  const screenshotPath = `/api/runs/missing-run/artifacts/${screenshotId}`;

  it.each([screenshotId, 'not-an-artifact.png'])(
    'requires authentication before artifact or run lookup for %s',
    async (id) => {
      const application = open();
      await expectError(
        await request(application, `/api/runs/missing-run/artifacts/${id}`),
        401,
        'UNAUTHORIZED',
      );
    },
  );

  it('rejects an incorrect bearer token without returning screenshot bytes', async () => {
    const application = open();
    const response = await request(application, screenshotPath, 'GET', undefined, {
      authorization: 'Bearer WRONG_SYNTHETIC_ARTIFACT_TOKEN',
    });
    expect(response.headers.get('content-type') ?? '').not.toMatch(/^image\/png(?:;|$)/i);
    await expectError(response, 401, 'UNAUTHORIZED');
  });

  it('rejects an invalid session cookie', async () => {
    const application = open();
    const current = await login(application);
    const separator = current.cookie.indexOf('=');
    const forgedCookie = `${current.cookie.slice(0, separator + 1)}SYNTHETIC_INVALID_SESSION`;
    await expectError(
      await request(application, screenshotPath, 'GET', undefined, {
        cookie: forgedCookie,
        origin: webOrigin,
      }),
      401,
      'UNAUTHORIZED',
    );
  });

  it('accepts session authentication for a read without requiring mutation tokens, then rejects the unknown run', async () => {
    const application = open();
    const current = await login(application);
    const response = await request(application, screenshotPath, 'GET', undefined, {
      cookie: current.cookie,
      origin: webOrigin,
    });
    await expectError(response, 404);
  });

  it('requires an existing run before any artifact file can be returned', async () => {
    mkdirSync(artifactDirectory, { recursive: true });
    const syntheticPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZfkAAAAASUVORK5CYII=',
      'base64',
    );
    writeFileSync(join(artifactDirectory, screenshotId), syntheticPng);
    const application = open();
    const response = await request(application, screenshotPath, 'GET', undefined, bearer());
    expect(response.headers.get('content-type') ?? '').not.toMatch(/^image\/png(?:;|$)/i);
    expect(response.headers.get('content-disposition') ?? '').not.toContain(screenshotId);
    const body = await response.clone().text();
    expect(body).not.toContain(artifactDirectory);
    expect(body).not.toContain(syntheticPng.toString('base64'));
    await expectError(response, 404);
  });

  it('applies the configured Origin restriction to screenshot reads', async () => {
    const application = open();
    await expectError(
      await request(application, screenshotPath, 'GET', undefined, {
        ...bearer(),
        origin: 'https://unapproved.example.invalid',
      }),
      403,
      'ORIGIN_REJECTED',
    );
  });

  it('applies the configured Host restriction to screenshot reads', async () => {
    const application = open();
    await expectError(
      await request(application, screenshotPath, 'GET', undefined, {
        ...bearer(),
        host: 'unapproved.example.invalid',
      }),
      403,
      'HOST_REJECTED',
    );
  });
});
