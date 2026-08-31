import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  Controller,
  equalSecret,
  coverageLimits,
  TOOL_NAMES,
  type ControllerConfig,
} from './controller.ts';
import { ControlError, RUN_LIMITS } from '#run';
import { hashValue, identifier } from '#domain';
import { redact } from '#evidence';
import { ArtifactError } from './artifacts.ts';
import { RepairError } from '#repair';
import {
  EVIDENCE_REVIEW_TOOLS,
  EvidenceReviewError,
  recordEvidenceReviewSchema,
} from './evidence-review.ts';

type Variables = { csrfToken: string };

/** Keeps every HTTP/MCP entry point closed until persisted safety state is recovered. */
export async function startAfterRecovery<T>(
  controller: Pick<Controller, 'recover'>,
  start: () => T,
): Promise<T> {
  await controller.recover();
  return start();
}

export function createControlApp(config: ControllerConfig) {
  const controller = new Controller(config);
  const app = new Hono<{ Variables: Variables }>();
  const secrets = [
    config.operatorToken,
    config.adapterToken,
    config.replaySecret,
    ...(config.polarToken ? [config.polarToken] : []),
  ];
  const loginAttempts: number[] = [];
  app.use(
    '*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json(
          { error: { code: 'REQUEST_TOO_LARGE', message: 'Request exceeds the allowed size.' } },
          413,
        ),
    }),
  );
  app.use('*', async (c, next) => {
    // Reject browser DNS rebinding and cross-origin requests before credentials or mutations.
    const url = new URL(c.req.url);
    const allowed = new Set([new URL(config.workerOrigin).host, new URL(config.webOrigin).host]);
    const host = c.req.header('host');
    if (!allowed.has(url.host) || (host !== undefined && !allowed.has(host)))
      return c.json({ error: { code: 'HOST_REJECTED', message: 'Unexpected control host.' } }, 403);
    const origin = c.req.header('origin');
    if (origin && origin !== config.webOrigin && origin !== config.workerOrigin)
      return c.json(
        { error: { code: 'ORIGIN_REJECTED', message: 'Unexpected request origin.' } },
        403,
      );
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ArtifactError)
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    const code =
      error instanceof ControlError ||
      error instanceof RepairError ||
      error instanceof EvidenceReviewError
        ? error.code
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 'INVALID_INPUT'
          : 'REQUEST_FAILED';
    const status =
      code === 'NOT_FOUND'
        ? 404
        : code === 'INVALID_INPUT'
          ? 400
          : code === 'TARGET_SCOPE_REJECTED'
            ? 403
            : code === 'PROJECT_CONFIG_CHANGED'
              ? 409
              : code === 'PREFLIGHT_BLOCKED'
                ? 422
                : code.includes('APPROVAL') ||
                    code.includes('CONFLICT') ||
                    code.includes('IN_FLIGHT') ||
                    code.includes('NOT_READY') ||
                    code.includes('PENDING')
                  ? 409
                  : 422;
    return c.json(
      {
        error: {
          code,
          message:
            code === 'REQUEST_FAILED'
              ? 'The request failed. No success was recorded.'
              : code.replaceAll('_', ' '),
        },
      },
      status,
    );
  });
  app.post('/api/login', async (c) => {
    const now = Date.now();
    while (loginAttempts[0] !== undefined && loginAttempts[0] < now - 60_000) loginAttempts.shift();
    if (loginAttempts.length >= 10)
      return c.json({ error: { code: 'RATE_LIMIT', message: 'Too many sign-in attempts.' } }, 429);
    loginAttempts.push(now);
    const { token } = z
      .strictObject({ token: z.string().min(1).max(500) })
      .parse(await c.req.json());
    if (!equalSecret(token, config.operatorToken))
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid operator token.' } }, 401);
    const session = randomUUID() + randomUUID(),
      csrfToken = randomUUID();
    controller.put('auth-session', hashValue(session), {
      csrfToken,
      expiresAt: now + 12 * 60 * 60 * 1000,
    });
    setCookie(c, 'pp_operator', session, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: config.webOrigin.startsWith('https:'),
      path: '/',
      maxAge: 12 * 60 * 60,
    });
    return c.json({ csrfToken });
  });
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/login') {
      await next();
      return;
    }
    const bearer = c.req.header('authorization')?.replace(/^Bearer /, '');
    if (bearer && equalSecret(bearer, config.operatorToken)) {
      c.set('csrfToken', '');
      await next();
      return;
    }
    const cookie = getCookie(c, 'pp_operator');
    const session = cookie
      ? z
          .object({ csrfToken: z.string(), expiresAt: z.number() })
          .safeParse(controller.get('auth-session', hashValue(cookie)))
      : null;
    if (!session?.success || session.data.expiresAt <= Date.now())
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Sign in with the local operator token.' } },
        401,
      );
    c.set('csrfToken', session.data.csrfToken);
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      !equalSecret(c.req.header('x-csrf-token') ?? '', session.data.csrfToken)
    )
      return c.json(
        { error: { code: 'CSRF_REJECTED', message: 'Refresh the session before submitting.' } },
        403,
      );
    await next();
  });
  app.use('/api/*', async (c, next) => {
    if (['GET', 'HEAD'].includes(c.req.method) || c.req.path === '/api/login') {
      await next();
      return;
    }
    const id = identifier.max(200).parse(c.req.header('x-request-id'));
    const text = await c.req.text();
    const hash = hashValue({ method: c.req.method, path: c.req.path, body: text });
    const existing = controller.database
      .prepare('SELECT hash,response FROM http_requests WHERE id=?')
      .get(id);
    if (existing) {
      const record = z
        .object({ hash: z.string(), response: z.string().nullable() })
        .parse(existing);
      if (record.hash !== hash) throw new ControlError('REQUEST_CONFLICT');
      if (!record.response) throw new ControlError('OPERATION_OUTCOME_UNKNOWN');
      const response = z
        .object({ status: z.number(), body: z.string() })
        .parse(JSON.parse(record.response));
      return new Response(response.body, {
        status: response.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    controller.database.prepare('INSERT INTO http_requests VALUES(?,?,NULL)').run(id, hash);
    await next();
    const body = await c.res.clone().text();
    // Retryable precondition failures cannot have dispatched provider work.
    if (
      c.res.status === 409 &&
      /RUNTIME_APPROVAL_PENDING|CHECKOUT_(?:CONTINUATION_NOT_READY|PENDING)/.test(body)
    )
      controller.database.prepare('DELETE FROM http_requests WHERE id=?').run(id);
    else
      controller.database
        .prepare('UPDATE http_requests SET response=? WHERE id=?')
        .run(JSON.stringify({ status: c.res.status, body }), id);
  });
  app.get('/api/session', (c) => c.json({ csrfToken: c.get('csrfToken') }));
  app.get('/api/config', (c) =>
    c.json({
      target: { id: config.targetId, origin: config.targetOrigin },
      repository: config.repository,
      defaultRef: config.defaultRef,
      reviewSkill: {
        repository: config.reviewSkillRepository,
        ref: config.reviewSkillRef,
      },
      polarConfigured: controller.polar !== null,
      priceId: config.priceId,
      model: config.model,
      limits: RUN_LIMITS,
      coverageLimits,
    }),
  );
  app.get('/api/projects', (c) => c.json(controller.projects()));
  app.post('/api/projects', async (c) => c.json(controller.createProject(await c.req.json()), 201));
  app.post('/api/projects/:id/preflight', async (c) => {
    const { mode } = z
      .strictObject({ mode: z.enum(['polar_sandbox', 'local_replay']) })
      .parse(await c.req.json());
    return c.json(await controller.preflight(c.req.param('id'), mode));
  });
  app.get('/api/projects/:id/policies', (c) => {
    controller.project(c.req.param('id'));
    return c.json(controller.list(`policy:${c.req.param('id')}`));
  });
  app.post('/api/projects/:id/policies', async (c) =>
    c.json(await controller.proposePolicy(c.req.param('id'), await c.req.json()), 201),
  );
  app.post('/api/runs', async (c) => c.json(await controller.createRun(await c.req.json()), 201));
  app.get('/api/runs', (c) =>
    c.json(
      controller
        .list('run-index')
        .map((value) => controller.runs.getRun(z.object({ id: identifier }).parse(value).id)),
    ),
  );
  app.post('/api/reference/reset', async (c) => {
    z.strictObject({}).parse(await c.req.json());
    const results = [];
    for (const value of controller.list('run-index')) {
      const { id } = z.object({ id: identifier }).parse(value);
      const run = controller.runs.getRun(id);
      if (['running', 'awaiting_plan_approval', 'stopping'].includes(run.status))
        results.push(await controller.cancel(id));
      else results.push(run);
    }
    return c.json({
      runs: results,
      message:
        'Only recorded run-owned fixtures are eligible for cleanup. Reports and unrelated users are preserved.',
    });
  });
  app.get('/api/runs/:id', (c) => c.json(controller.viewRun(c.req.param('id'))));
  app.get('/api/runs/:id/checkout', (c) => {
    const url = controller.checkoutUrl(c.req.param('id'));
    if (!url)
      return c.json(
        {
          error: {
            code: 'CHECKOUT_NOT_READY',
            message: 'The sandbox checkout has not been created yet.',
          },
        },
        409,
      );
    c.header('Referrer-Policy', 'no-referrer');
    return c.redirect(url, 303);
  });
  app.post('/api/runs/:id/checkout/continue', async (c) => {
    z.strictObject({}).parse(await c.req.json());
    return c.json(await controller.continueCheckout(c.req.param('id')));
  });
  app.post('/api/runs/:id/cleanup', async (c) => {
    z.strictObject({}).parse(await c.req.json());
    return c.json(await controller.retryCleanup(c.req.param('id')));
  });
  app.get('/api/runs/:id/artifacts/:artifactId', async (c) => {
    const artifact = await controller.artifact(c.req.param('id'), c.req.param('artifactId'));
    return new Response(artifact.bytes, {
      headers: {
        'Content-Type': artifact.metadata.contentType,
        'Content-Disposition': `attachment; filename="${artifact.metadata.id}"`,
        'Content-Length': String(artifact.bytes.byteLength),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  app.get('/api/runs/:id/events', (c) => {
    const after = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(c.req.query('after') ?? '0');
    const events = controller.runs.events({ runId: c.req.param('id'), after });
    return c.json({ events, cursor: events.at(-1)?.sequence ?? after });
  });
  app.post('/api/runs/:id/approvals/:approvalId', async (c) =>
    c.json(
      await controller.decidePlan(c.req.param('id'), c.req.param('approvalId'), await c.req.json()),
    ),
  );
  app.post('/api/runs/:id/cancel', async (c) => {
    z.strictObject({}).parse(await c.req.json());
    return c.json(await controller.cancel(c.req.param('id')));
  });
  app.post('/api/runs/:id/repairs', async (c) => {
    return c.json(await controller.startRepair(c.req.param('id'), await c.req.json()), 202);
  });
  app.post('/api/runs/:id/evidence-review', async (c) => {
    const input = z
      .strictObject({ retryCompleted: z.boolean().optional() })
      .parse(await c.req.json());
    return c.json(await controller.startEvidenceReview(c.req.param('id'), input), 202);
  });
  app.post('/api/runs/:id/repairs/:jobId/cancel', async (c) => {
    z.strictObject({}).parse(await c.req.json());
    return c.json(controller.repairs.cancel(c.req.param('id'), c.req.param('jobId')));
  });
  app.post('/api/runs/:id/repairs/:jobId/publication-request', async (c) => {
    z.strictObject({}).parse(await c.req.json());
    return c.json(
      await controller.repairs.requestPublication(c.req.param('id'), c.req.param('jobId')),
      202,
    );
  });
  app.post('/api/runs/:id/repairs/:jobId/approvals/:approvalId', async (c) =>
    c.json(
      await controller.repairs.decidePublication(
        c.req.param('id'),
        c.req.param('jobId'),
        c.req.param('approvalId'),
        await c.req.json(),
      ),
    ),
  );
  app.get('/api/runs/:id/report', (c) => {
    const report = controller.report(c.req.param('id'));
    if (c.req.query('format') === 'markdown') {
      const lines = [
        '# PaywallProof report',
        '',
        `Run: ${report.run.id}`,
        `Mode: ${report.run.mode}`,
        `Outcome: ${report.run.outcome ?? 'Untested'}`,
        `Build: ${report.run.targetBuild}`,
        '',
        '## Scenarios',
        '',
        ...report.scenarios.map(
          (result) =>
            `- ${result.id}: API ${result.api.verdict}, browser ${result.browser.verdict}, application state ${result.state.verdict}`,
        ),
        '',
        '## Coverage limits',
        '',
        ...report.coverageLimits.map((limit) => `- ${limit}`),
        '',
        '## Evidence and metadata',
        '',
        '```json',
        JSON.stringify(report, null, 2).replaceAll('`', '\\u0060'),
        '```',
      ];
      c.header('Content-Disposition', `attachment; filename="paywallproof-${report.run.id}.md"`);
      return c.text(lines.join('\n'));
    }
    c.header('Content-Disposition', `attachment; filename="paywallproof-${report.run.id}.json"`);
    return c.json(report);
  });
  for (const path of ['/mcp', '/mcp/:runId'])
    app.all(path, async (c) => {
      const bearer = c.req.header('authorization')?.replace(/^Bearer /, '');
      const scope = bearer
        ? z.object({ runId: identifier }).safeParse(controller.get('mcp-token', hashValue(bearer)))
        : null;
      if (!scope?.success || c.req.param('runId') !== scope.data.runId)
        return c.json({ error: 'Unauthorized' }, 401);
      const server = new McpServer({ name: 'paywallproof', version: '0.1.0' });
      for (const name of TOOL_NAMES) {
        const fields = { runId: z.literal(scope.data.runId), operationId: identifier };
        const inputSchema =
          name === 'change_test_subscription'
            ? z.strictObject({ ...fields, action: z.enum(['create', 'confirm', 'schedule']) })
            : name === 'probe_feature'
              ? z.strictObject({ ...fields, scenarioId: z.enum(['SC01', 'SC02', 'SC03', 'SC04']) })
              : name === 'observe_billing'
                ? z.strictObject({
                    ...fields,
                    scenarioId: z.enum(['SC01', 'SC02', 'SC03', 'SC04']).optional(),
                  })
                : z.strictObject(fields);
        server.registerTool(
          name,
          {
            description: `${name} for the authorized PaywallProof run. No arbitrary host, SQL, shell, merge or deployment.`,
            inputSchema,
          },
          async (input) => {
            try {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      redact(await controller.tool(scope.data.runId, name, input), secrets),
                    ),
                  },
                ],
              };
            } catch (error) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      code: error instanceof ControlError ? error.code : 'TOOL_FAILED',
                      retryable: false,
                      message: redact(
                        error instanceof Error ? error.message : 'Unknown tool failure',
                        secrets,
                      ),
                    }),
                  },
                ],
              };
            }
          },
        );
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(c.req.raw);
      } finally {
        await server.close();
      }
    });
  app.all('/mcp/reviews/:runId', async (c) => {
    const runId = c.req.param('runId');
    const bearer = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!controller.reviews.authorize(runId, bearer)) return c.json({ error: 'Unauthorized' }, 401);
    const server = new McpServer({ name: 'paywallproof-evidence-review', version: '0.1.0' });
    const invoke = async (name: (typeof EVIDENCE_REVIEW_TOOLS)[number], input: unknown) => {
      try {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                redact(await controller.reviews.tool(runId, name, input), secrets),
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                code:
                  error instanceof EvidenceReviewError ? error.code : 'EVIDENCE_REVIEW_TOOL_FAILED',
                retryable: false,
              }),
            },
          ],
        };
      }
    };
    server.registerTool(
      'read_run_report',
      {
        description: 'Read the immutable report bound to this review.',
        inputSchema: z.strictObject({ runId: z.literal(runId), operationId: identifier }),
      },
      (input) => invoke('read_run_report', input),
    );
    server.registerTool(
      'record_evidence_review',
      {
        description: 'Record two independent reviewer results and one conservative synthesis.',
        inputSchema: recordEvidenceReviewSchema,
      },
      (input) => invoke('record_evidence_review', input),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  return { app, controller, close: () => controller.close() };
}
