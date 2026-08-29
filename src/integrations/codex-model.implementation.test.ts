import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import {
  CODEX_MODEL_ID,
  CODEX_GATEWAY_ORIGIN,
  codexProcessArguments,
  codexProcessEnvironment,
  verifyCodexSubscription,
  withCodexClient,
  type CodexRpc,
} from './codex-subscription.ts';
import { createCodexModelGateway, type CodexBackend } from './codex-model.ts';
import { TrueForgeAdapter } from './trueforge.ts';

vi.mock('node:child_process', async () => ({
  ...(await vi.importActual('node:child_process')),
  spawn: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// Implementation-aware synthetic protocol tests, not evidence of live inference.
// The independent product oracle and its evaluator tests remain untouched.
const token = 'synthetic_codex_gateway_token_for_tests_only';
const quota = () => ({
  limitId: 'codex',
  planType: 'pro',
  primary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: 1788452789 },
  secondary: null,
  credits: { hasCredits: false, unlimited: false, balance: '0' },
  rateLimitReachedType: null,
  spendControlReached: false,
});
function metadata(patch: { account?: unknown; limits?: unknown; catalog?: unknown } = {}) {
  const request: CodexRpc['request'] = vi.fn(async (method) => {
    if (method === 'account/read')
      return (
        patch.account ?? { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true }
      );
    if (method === 'account/rateLimits/read')
      return patch.limits ?? { rateLimits: quota(), rateLimitsByLimitId: { codex: quota() } };
    if (method === 'model/list')
      return (
        patch.catalog ?? { data: [{ model: CODEX_MODEL_ID, hidden: false }], nextCursor: null }
      );
    throw new Error('Unexpected metadata method');
  });
  return { request };
}
const body = () => ({
  model: CODEX_MODEL_ID,
  messages: [{ role: 'user', content: 'Synthetic request' }],
});
function fixture(generate?: CodexBackend['generate']) {
  const model = {
    check: vi.fn(async () => ({ inference: 'codex_subscription' })),
    generate: vi.fn(
      generate ??
        (async () => ({
          text: '{"content":"Synthetic model response","tool_calls":[]}',
          threadId: 'synthetic-thread',
          turnId: 'synthetic-turn',
        })),
    ),
  };
  const app = createCodexModelGateway(token, model);
  const post = (input: unknown = body(), init: RequestInit = {}) =>
    app.request(`${CODEX_GATEWAY_ORIGIN}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      ...init,
    });
  return { app, post, model };
}
describe('Codex included subscription guard', () => {
  it('checks only metadata and accepts an available subscription with no extra credits', async () => {
    const rpc = metadata();
    expect(await verifyCodexSubscription(rpc)).toEqual({
      model: CODEX_MODEL_ID,
      inference: 'codex_subscription',
      planType: 'pro',
      includedUsageRemainingPercent: 89,
      extraCredits: 0,
    });
    expect(vi.mocked(rpc.request).mock.calls.map((call) => call[0])).toEqual([
      'account/read',
      'account/rateLimits/read',
      'model/list',
    ]);
  });
  it.each(['apiKey', 'chatgptAuthTokens', 'amazonBedrock', null])(
    'rejects non-managed subscription auth %s',
    async (type) => {
      const rpc = metadata({
        account: { account: { type, planType: 'pro' }, requiresOpenaiAuth: true },
      });
      await expect(verifyCodexSubscription(rpc)).rejects.toThrow(
        'CODEX_CHATGPT_SUBSCRIPTION_REQUIRED',
      );
      expect(rpc.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['business', 'enterprise', 'edu', 'free', 'unknown'])(
    'rejects potentially metered or unverified plan %s',
    async (planType) => {
      await expect(
        verifyCodexSubscription(
          metadata({
            account: { account: { type: 'chatgpt', planType }, requiresOpenaiAuth: true },
          }),
        ),
      ).rejects.toThrow();
    },
  );
  it.each([
    { credits: null },
    { credits: { hasCredits: true, unlimited: false, balance: '1' } },
    { credits: { hasCredits: false, unlimited: true, balance: '0' } },
    { credits: { hasCredits: false, unlimited: false, balance: null } },
    { credits: { hasCredits: false, unlimited: false, balance: '0.01' } },
    { credits: { hasCredits: false, unlimited: false, balance: 0 } },
    { credits: { hasCredits: false, unlimited: false, balance: '-1' } },
    { primary: null },
    { rateLimitReachedType: 'usage_limit' },
    { spendControlReached: true },
    { planType: 'business' },
    { primary: { usedPercent: NaN } },
    { secondary: { usedPercent: -1 } },
  ])('fails closed on missing or unsafe quota data: %j', async (patch) => {
    const rpc = metadata({
      limits: { rateLimits: { ...quota(), ...patch }, rateLimitsByLimitId: null },
    });
    await expect(verifyCodexSubscription(rpc)).rejects.toThrow();
    expect(rpc.request).toHaveBeenCalledTimes(2);
  });
  it.each(['primary', 'secondary'])('blocks exhausted %s allowance', async (key) => {
    const rpc = metadata({
      limits: {
        rateLimits: { ...quota(), [key]: { ...quota().primary, usedPercent: 100 } },
        rateLimitsByLimitId: null,
      },
    });
    await expect(verifyCodexSubscription(rpc)).rejects.toThrow('CODEX_INCLUDED_USAGE_EXHAUSTED');
  });
  it('rejects inconsistent billing snapshots', async () => {
    await expect(
      verifyCodexSubscription(
        metadata({
          limits: {
            rateLimits: quota(),
            rateLimitsByLimitId: { codex: { ...quota(), credits: null } },
          },
        }),
      ),
    ).rejects.toThrow('CODEX_QUOTA_AMBIGUOUS');
  });
  it.each([
    { data: [], nextCursor: null },
    { data: [{ model: CODEX_MODEL_ID, hidden: true }], nextCursor: null },
    {
      data: [
        { model: CODEX_MODEL_ID, hidden: false },
        { model: CODEX_MODEL_ID, hidden: false },
      ],
      nextCursor: null,
    },
    { data: [{ model: CODEX_MODEL_ID, hidden: false }], nextCursor: 'more-models' },
  ])('does not silently substitute a model or assume paginated availability', async (catalog) => {
    await expect(verifyCodexSubscription(metadata({ catalog }))).rejects.toThrow(
      'CODEX_LUNA_UNAVAILABLE',
    );
  });
  it('does not pass API keys, alternate providers or billing environment into Codex', () => {
    const env = codexProcessEnvironment({
      NODE_ENV: 'test',
      HOME: '/synthetic',
      PATH: '/bin',
      OPENAI_API_KEY: 'private',
      CODEX_API_KEY: 'private',
      OPENAI_BASE_URL: 'https://other.invalid',
      CODEX_HOME: '/other',
      OPENROUTER_API_KEY: 'private',
    });
    expect(env).toEqual({ HOME: '/synthetic', PATH: '/bin', NODE_ENV: 'production' });
    const args = codexProcessArguments();
    expect(args).toContain('forced_login_method="chatgpt"');
    expect(args).toContain('model_provider="openai"');
    for (const name of [
      'shell_tool',
      'apps',
      'plugins',
      'hooks',
      'multi_agent',
      'computer_use',
      'image_generation',
      'view_image',
    ]) {
      expect(args[args.indexOf(name) - 1]).toBe('--disable');
    }
  });
});

describe('Codex official-client protocol boundaries, synthetic subprocess', () => {
  function processFixture(
    mode:
      | 'success'
      | 'usage'
      | 'tool'
      | 'wrong-model'
      | 'failed-turn'
      | 'credential-change'
      | 'malformed'
      | 'retry-wait',
    notifications: unknown[] = [],
    onWait?: () => void,
  ) {
    const child = Object.assign(new ChildProcess(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    let stopped = false;
    child.kill = vi.fn(() => {
      if (!stopped) {
        stopped = true;
        queueMicrotask(() => {
          Object.defineProperty(child, 'exitCode', { value: 0 });
          child.emit('exit', 0);
        });
      }
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child);
    const requests: { id: number; method: string; params: Record<string, unknown> }[] = [];
    let generations = 0;
    const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
    child.stdin.on('data', (bytes: Buffer) => {
      const request = JSON.parse(bytes.toString());
      if (request.id === undefined) return;
      requests.push(request);
      let result: unknown = {};
      if (request.method === 'account/read')
        result = {
          account: {
            type: mode === 'credential-change' && generations ? 'apiKey' : 'chatgpt',
            planType: 'pro',
          },
          requiresOpenaiAuth: true,
        };
      if (request.method === 'account/rateLimits/read')
        result = { rateLimits: quota(), rateLimitsByLimitId: null };
      if (request.method === 'model/list')
        result = { data: [{ model: CODEX_MODEL_ID, hidden: false }], nextCursor: null };
      if (request.method === 'config/read')
        result = { config: { mcp_servers: { synthetic_host_access: {} } } };
      if (request.method === 'thread/start')
        result = {
          model: mode === 'wrong-model' ? 'gpt-5.6-sol' : CODEX_MODEL_ID,
          modelProvider: 'openai',
          thread: { id: 'test-thread' },
        };
      if (request.method === 'turn/start') {
        generations++;
        queueMicrotask(() => {
          if (mode === 'malformed') {
            child.stdout.write('not-json\n');
            return;
          }
          if (mode === 'tool') {
            emit({ id: 500, method: 'item/tool/call', params: {} });
            return;
          }
          for (const params of notifications) emit({ method: 'error', params });
          if (mode === 'retry-wait') {
            onWait?.();
            return;
          }
          emit({
            method: 'item/completed',
            params: {
              threadId: 'test-thread',
              turnId: 'test-turn',
              item: {
                type: 'agentMessage',
                phase: 'commentary',
                text: 'Synthetic interim commentary is not the JSON answer.',
              },
            },
          });
          emit({
            method: 'item/completed',
            params: {
              threadId: 'test-thread',
              turnId: 'test-turn',
              item: { type: 'agentMessage', phase: 'final_answer', text: '{"synthetic":true}' },
            },
          });
          if (mode === 'usage')
            emit({
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: 'test-thread',
                turnId: 'test-turn',
                tokenUsage: { last: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } },
              },
            });
          emit({
            method: 'turn/completed',
            params: {
              threadId: 'test-thread',
              turn: {
                id: 'test-turn',
                status: mode === 'failed-turn' ? 'failed' : 'completed',
                error: null,
              },
            },
          });
        });
      }
      queueMicrotask(() => emit({ id: request.id, result }));
    });
    return { child, requests };
  }
  it('disables environment access and configured MCP servers, and rechecks billing after completion', async () => {
    const f = processFixture('success');
    const result = await withCodexClient(AbortSignal.timeout(2000), (client) =>
      client.generate('Synthetic input', { type: 'object' }),
    );
    expect(result).toEqual({
      text: '{"synthetic":true}',
      threadId: 'test-thread',
      turnId: 'test-turn',
    });
    const start = f.requests.find((request) => request.method === 'thread/start');
    expect(start?.params).toMatchObject({
      model: CODEX_MODEL_ID,
      modelProvider: 'openai',
      allowProviderModelFallback: false,
      environments: [],
      selectedCapabilityRoots: [],
      runtimeWorkspaceRoots: [],
      dynamicTools: [],
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral: true,
      config: { 'mcp_servers.synthetic_host_access.enabled': false },
    });
    expect(f.requests.at(-3)?.method).toBe('account/read');
    expect(f.child.kill).toHaveBeenCalled();
  });
  it.each(['tool', 'wrong-model', 'failed-turn', 'credential-change', 'malformed'] as const)(
    'rejects %s without accepting output',
    async (mode) => {
      const f = processFixture(mode);
      await expect(
        withCodexClient(AbortSignal.timeout(2000), (client) =>
          client.generate('Synthetic input', {}),
        ),
      ).rejects.toThrow();
      expect(f.child.kill).toHaveBeenCalled();
      expect(
        f.requests.filter((request) => request.method === 'turn/start').length,
      ).toBeLessThanOrEqual(1);
    },
  );
  it('preserves reported token counts and excludes interim commentary from structured output', async () => {
    processFixture('usage');
    const result = await withCodexClient(AbortSignal.timeout(2000), (client) =>
      client.generate('Synthetic input', {}),
    );
    expect(result).toEqual({
      text: '{"synthetic":true}',
      threadId: 'test-thread',
      turnId: 'test-turn',
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
    });
  });
  const retryingStream = () => ({
    threadId: 'test-thread',
    turnId: 'test-turn',
    willRetry: true,
    error: {
      message: 'Synthetic private details must not escape.',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    },
  });
  it('lets Codex finish its own retryable stream notification without resubmitting the turn', async () => {
    const f = processFixture('usage', [retryingStream()]);
    const result = await withCodexClient(AbortSignal.timeout(2000), (client) =>
      client.generate('Synthetic input', {}),
    );
    expect(result.text).toBe('{"synthetic":true}');
    expect(result.usage?.totalTokens).toBe(13);
    expect(f.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    expect(f.requests.at(-3)?.method).toBe('account/read');
  });
  it.each([
    { ...retryingStream(), willRetry: false },
    { ...retryingStream(), threadId: 'other-thread' },
    { ...retryingStream(), willRetry: 'true' },
    { ...retryingStream(), error: { codexErrorInfo: 'usageLimitExceeded' } },
    { ...retryingStream(), error: { codexErrorInfo: 'unauthorized' } },
    { ...retryingStream(), error: { codexErrorInfo: 'unknown' } },
    {
      ...retryingStream(),
      error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } },
    },
    {
      ...retryingStream(),
      error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } } },
    },
  ])(
    'rejects terminal, unrelated, malformed and billing-related error notifications: %j',
    async (notification) => {
      const f = processFixture('success', [notification]);
      await expect(
        withCodexClient(AbortSignal.timeout(2000), (client) =>
          client.generate('Synthetic input', {}),
        ),
      ).rejects.toThrow(/CODEX_/);
      expect(f.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    },
  );
  it('lets the official client recover after four native reconnects without another turn', async () => {
    const f = processFixture('success', Array.from({ length: 4 }, retryingStream));
    await expect(
      withCodexClient(AbortSignal.timeout(2000), (client) =>
        client.generate('Synthetic input', {}),
      ),
    ).resolves.toMatchObject({ text: '{"synthetic":true}' });
    expect(f.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  });
  it('cancels a retrying stream within the original signal bound', async () => {
    const cancellation = new AbortController();
    const f = processFixture('retry-wait', Array.from({ length: 4 }, retryingStream), () =>
      cancellation.abort(),
    );
    await expect(
      withCodexClient(cancellation.signal, (client) => client.generate('Synthetic input', {})),
    ).rejects.toThrow('CODEX_INTERRUPTED');
    expect(f.child.kill).toHaveBeenCalled();
    expect(f.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  });
  it('rejects cancellation before launching a subprocess', async () => {
    const signal = AbortSignal.abort();
    await expect(
      withCodexClient(signal, (client) => client.generate('Synthetic input', {})),
    ).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('bounds cleanup when a missing executable emits error and close without exit', async () => {
    const child = Object.assign(new ChildProcess(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    child.kill = vi.fn(() => false);
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => {
        child.emit('error', new Error('ENOENT'));
        queueMicrotask(() => child.emit('close', -2));
      });
      return child;
    });
    await expect(
      withCodexClient(AbortSignal.timeout(1000), (client) => client.generate('Synthetic', {})),
    ).rejects.toThrow('CODEX_UNAVAILABLE');
  });
});

describe('Codex decision protocol gateway', () => {
  it.each([200, 401, 503, 'wrong-model', 'offline'] as const)(
    'requires authenticated live gateway preflight: %s',
    async (status) => {
      const fetcher = vi.fn(async (url: unknown, options?: RequestInit) => {
        if (String(url).endsWith('/health')) {
          expect(options?.redirect).toBe('error');
          expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${token}`);
          if (status === 'offline') throw new Error('Synthetic connection refused');
          return Response.json(
            {
              model: status === 'wrong-model' ? 'other' : CODEX_MODEL_ID,
              inference: 'codex_subscription',
              extraCredits: 0,
            },
            { status: typeof status === 'number' ? status : 200 },
          );
        }
        return Response.json({
          data: [
            {
              name: 'paywallproof-codex',
              manifest: {
                type: 'custom',
                name: 'paywallproof-codex',
                baseUrl: `${CODEX_GATEWAY_ORIGIN}/v1`,
                auth: { apiKey: token },
                models: [
                  {
                    name: 'luna',
                    modelId: CODEX_MODEL_ID,
                    properties: { contextLength: 65536, maxOutputTokens: 8192 },
                  },
                ],
              },
            },
          ],
        });
      });
      vi.stubGlobal('fetch', fetcher);
      const adapter = new TrueForgeAdapter({
        model: 'paywallproof-codex/luna',
        gatewayToken: token,
      });
      if (status === 200)
        await expect(adapter.checkConnection()).resolves.toMatchObject({
          inference: 'codex_subscription',
        });
      else await expect(adapter.checkConnection()).rejects.toThrow('gateway is unavailable');
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it('returns genuine backend text and provenance without inventing usage', async () => {
    const f = fixture();
    const response = await f.post();
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.id).toBe('codex_synthetic-thread_synthetic-turn');
    expect(data.choices[0].message.content).toBe('Synthetic model response');
    expect(data).not.toHaveProperty('usage');
    expect(f.model.generate).toHaveBeenCalledTimes(1);
  });
  it.each([
    { model: 'gpt-5.6-sol' },
    { model: 'cohere/north-mini-code:free' },
    { models: ['gpt-5.6-luna'] },
    { provider: { apiKey: 'paid' } },
    { tools: [{ type: 'web_search' }] },
    { plugins: [] },
    { max_tokens: 8193 },
    { max_tokens: 1, max_completion_tokens: 1 },
    {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///secret' } }] },
      ],
    },
  ])('blocks unsafe inputs before inference: %j', async (patch) => {
    const f = fixture();
    expect((await f.post({ ...body(), ...patch })).status).toBe(400);
    expect(f.model.generate).not.toHaveBeenCalled();
  });
  it('requires loopback host and a private capability, and denies browser-origin requests', async () => {
    const f = fixture();
    expect((await f.post(body(), { headers: { 'content-type': 'application/json' } })).status).toBe(
      401,
    );
    expect(
      (
        await f.post(body(), {
          headers: { authorization: `Bearer ${token}`, origin: 'https://other.invalid' },
        })
      ).status,
    ).toBe(403);
    expect((await f.app.request('http://evil.invalid/v1/chat/completions')).status).toBe(403);
    expect(f.model.generate).not.toHaveBeenCalled();
  });
  it('keeps health metadata-only', async () => {
    const f = fixture();
    const response = await f.app.request(`${CODEX_GATEWAY_ORIGIN}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(f.model.check).toHaveBeenCalledOnce();
    expect(f.model.generate).not.toHaveBeenCalled();
  });
  const tools = [{ type: 'function', function: { name: 'exec', parameters: { type: 'object' } } }];
  const exact = 'node uploads/pp_synthetic_stage.cjs';
  const instruction = `Execute exactly one exec tool call with command ${JSON.stringify(exact)}. Do not set cwd or env. Do not run any other tools or commands. When it returns, reply briefly.`;
  it('serializes a structured exact-command argument without changing its value', async () => {
    const f = fixture(async () => ({
      text: JSON.stringify({
        content: null,
        tool_calls: [
          { name: 'exec', arguments: { intent: 'Exact synthetic instruction', command: exact } },
        ],
      }),
      threadId: 't',
      turnId: 'u',
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
    }));
    const response = await f.post({
      ...body(),
      tools,
      messages: [{ role: 'user', content: instruction }],
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      intent: 'Exact synthetic instruction',
      command: exact,
    });
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
  });
  it('constrains exact controller commands before execution and distinguishes current from earlier history', async () => {
    const f = fixture(async (prompt, schema) => {
      expect(prompt.indexOf('CURRENT INSTRUCTION')).toBeLessThan(prompt.indexOf('EARLIER CONTEXT'));
      expect(JSON.stringify(schema)).toContain('Execute the single controller-authorized command.');
      return {
        text: JSON.stringify({
          content: null,
          tool_calls: [
            { name: 'exec', arguments: JSON.stringify({ intent: 'exact', command: exact }) },
          ],
        }),
        threadId: 't',
        turnId: 'u',
      };
    });
    const response = await f.post({
      ...body(),
      tools,
      messages: [
        { role: 'user', content: 'An older command must not be replayed.' },
        { role: 'user', content: instruction },
      ],
    });
    expect(response.status).toBe(200);
  });
  it.each(['node uploads/pp_synthetic_bundle_0.bin', 'node uploads/pp_other_stage.cjs'])(
    'blocks a guessed exact command before TrueForge can execute it: %s',
    async (command) => {
      const f = fixture(async () => ({
        text: JSON.stringify({
          content: null,
          tool_calls: [
            { name: 'exec', arguments: JSON.stringify({ intent: 'synthetic', command }) },
          ],
        }),
        threadId: 't',
        turnId: 'u',
      }));
      expect(
        (await f.post({ ...body(), tools, messages: [{ role: 'user', content: instruction }] }))
          .status,
      ).toBe(503);
    },
  );
  it('does not allow an exact command to be retried after either success or failure', async () => {
    const calls = [
      {
        id: 'synthetic-call',
        type: 'function',
        function: {
          name: 'exec',
          arguments: JSON.stringify({ intent: 'synthetic', command: exact }),
        },
      },
    ];
    const f = fixture(async () => ({
      text: JSON.stringify({
        content: null,
        tool_calls: [{ name: 'exec', arguments: calls[0]?.function.arguments }],
      }),
      threadId: 't',
      turnId: 'u',
    }));
    for (const exitCode of [0, 1]) {
      expect(
        (
          await f.post({
            ...body(),
            tools,
            messages: [
              { role: 'user', content: instruction },
              { role: 'assistant', content: null, tool_calls: calls },
              {
                role: 'tool',
                tool_call_id: 'synthetic-call',
                content: JSON.stringify({ success: true, response: { exitCode } }),
              },
            ],
          })
        ).status,
      ).toBe(503);
    }
  });
  it('requires a nonempty actual acknowledgment after an exact command, without synthesizing one', async () => {
    const f = fixture(async (_prompt, schema) => {
      expect(schema.properties).toMatchObject({ content: { type: 'string', minLength: 1 } });
      return { text: '{"content":null,"tool_calls":[]}', threadId: 't', turnId: 'u' };
    });
    const response = await f.post({
      ...body(),
      tools,
      messages: [
        { role: 'user', content: instruction },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'synthetic-call',
              type: 'function',
              function: {
                name: 'exec',
                arguments: JSON.stringify({ intent: 'synthetic', command: exact }),
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'synthetic-call',
          content: '{"success":true,"response":{"exitCode":0,"result":"synthetic"}}',
        },
      ],
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('CODEX_EMPTY_DECISION');
  });
  it('translates a proposal without executing it, including buffered SSE', async () => {
    const f = fixture(async () => ({
      text: JSON.stringify({
        content: null,
        tool_calls: [{ name: 'exec', arguments: '{"command":"synthetic-only"}' }],
      }),
      threadId: 't',
      turnId: 'u',
    }));
    const response = await f.post({ ...body(), tools, stream: true });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain('data: [DONE]');
    expect(text).toContain('synthetic-only');
    expect(text).not.toContain('"usage"');
  });
  it.each(['pp_synthetic_checkout', null])(
    'uses structured exec arguments without nested JSON escaping, cwd %s',
    async (cwd) => {
      const command = "node -e \"const fs=require('fs'); console.log('a\\nb')\"";
      const f = fixture(async () => {
        return {
          text: JSON.stringify({
            content: 'Inspect the source.',
            tool_calls: [
              { name: 'exec', arguments: { intent: 'Bounded source inspection', command, cwd } },
            ],
          }),
          threadId: 't',
          turnId: 'u',
        };
      });
      const response = await f.post({ ...body(), tools });
      expect(response.status).toBe(200);
      const generation = f.model.generate.mock.calls[0];
      expect(generation?.[0]).toContain(
        'For multi-step instructions, continue with the next necessary proposal',
      );
      expect(generation?.[0]).not.toContain(
        'If a tool has already returned for the current instruction, acknowledge its actual result; do not execute again',
      );
      expect(generation?.[1]).toMatchObject({
        properties: {
          tool_calls: {
            items: {
              properties: {
                arguments: {
                  type: 'object',
                  properties: { cwd: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
                },
              },
            },
          },
        },
      });
      const result = await response.json();
      expect(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments)).toEqual({
        intent: 'Bounded source inspection',
        command,
        ...(cwd === null ? {} : { cwd }),
      });
    },
  );
  it('keeps other tool proposals available alongside structured exec', async () => {
    const f = fixture(async (_prompt, schema) => {
      expect(JSON.stringify(schema)).toContain('read_source');
      return {
        text: '{"content":"Read source metadata.","tool_calls":[{"name":"read_source","arguments":"{\\"path\\":\\"synthetic.ts\\"}"}]}',
        threadId: 't',
        turnId: 'u',
      };
    });
    const response = await f.post({
      ...body(),
      tools: [
        ...tools,
        { type: 'function', function: { name: 'read_source', parameters: { type: 'object' } } },
      ],
    });
    expect(response.status).toBe(200);
  });
  it.each([
    { content: null, tool_calls: [{ name: 'unknown', arguments: '{}' }] },
    { content: null, tool_calls: [{ name: 'exec', arguments: '[]' }] },
    { content: null, tool_calls: [{ name: 'exec', arguments: 'null' }] },
    { content: null, tool_calls: [{ name: 'exec', arguments: 'invalid' }] },
    { content: '', tool_calls: [] },
    { content: 'fake', tool_calls: [], unexpected: true },
  ])('rejects malformed or unauthorized decisions: %j', async (decision) => {
    const f = fixture(async () => ({ text: JSON.stringify(decision), threadId: 't', turnId: 'u' }));
    expect((await f.post({ ...body(), tools })).status).toBe(503);
  });
  it('honors no-tools, required-tool and single-call restrictions', async () => {
    const calls = [{ name: 'exec', arguments: '{}' }];
    const f = fixture(async () => ({
      text: JSON.stringify({ content: null, tool_calls: calls }),
      threadId: 't',
      turnId: 'u',
    }));
    expect((await f.post({ ...body(), tools, tool_choice: 'none' })).status).toBe(503);
    calls.push({ name: 'exec', arguments: '{}' });
    expect((await f.post({ ...body(), tools, parallel_tool_calls: false })).status).toBe(503);
    calls.splice(0);
    expect((await f.post({ ...body(), tools, tool_choice: 'required' })).status).toBe(503);
  });
  it('does not retry failures or disclose backend error details', async () => {
    const f = fixture(async () => {
      throw new Error('private credential and trace');
    });
    const response = await f.post();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private credential');
    expect(f.model.generate).toHaveBeenCalledOnce();
  });
  it('requests one replacement for an empty decision and counts both actual generations', async () => {
    let calls = 0;
    const f = fixture(async (_prompt, schema) => {
      expect(schema.properties).toMatchObject({ content: { type: 'string', minLength: 1 } });
      calls++;
      return {
        text: JSON.stringify(
          calls === 1
            ? { content: null, tool_calls: [] }
            : {
                content: 'Actual replacement proposal',
                tool_calls: [{ name: 'exec', arguments: '{"command":"synthetic-only"}' }],
              },
        ),
        threadId: `t${calls}`,
        turnId: `u${calls}`,
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      };
    });
    const response = await f.post({ ...body(), tools });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.choices[0].message.content).toBe('Actual replacement proposal');
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.usage).toEqual({ prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 });
    expect(f.model.generate).toHaveBeenCalledTimes(2);
  });
  it('fails after two empty decisions without inventing an acknowledgment', async () => {
    const f = fixture(async () => ({
      text: '{"content":null,"tool_calls":[]}',
      threadId: 't',
      turnId: 'u',
    }));
    const response = await f.post();
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('CODEX_EMPTY_DECISION');
    expect(f.model.generate).toHaveBeenCalledTimes(2);
  });
  it.each(['', ' \n\t'])(
    'requests one replacement for a completed blank output %j',
    async (blank) => {
      let calls = 0;
      const f = fixture(async () => ({
        text: ++calls === 1 ? blank : '{"content":"Recorded replacement","tool_calls":[]}',
        threadId: 't',
        turnId: 'u',
      }));
      const response = await f.post();
      expect(response.status).toBe(200);
      expect(f.model.generate).toHaveBeenCalledTimes(2);
      expect((await response.json()).choices[0].message.content).toBe('Recorded replacement');
    },
  );
  it('does not retry malformed nonempty JSON', async () => {
    const f = fixture(async () => ({ text: '{"content":', threadId: 't', turnId: 'u' }));
    expect((await f.post()).status).toBe(503);
    expect(f.model.generate).toHaveBeenCalledOnce();
  });
  it('omits combined usage when one generation provides no usage receipt', async () => {
    let calls = 0;
    const f = fixture(async () =>
      ++calls === 1
        ? { text: '{"content":null,"tool_calls":[]}', threadId: 't1', turnId: 'u1' }
        : {
            text: '{"content":"Actual replacement","tool_calls":[]}',
            threadId: 't2',
            turnId: 'u2',
            usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
          },
    );
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('usage');
    expect(f.model.generate).toHaveBeenCalledTimes(2);
  });
  it('still rejects unauthorized proposals after an empty decision', async () => {
    let calls = 0;
    const f = fixture(async () => ({
      text: JSON.stringify(
        ++calls === 1
          ? { content: null, tool_calls: [] }
          : {
              content: 'Unauthorized replacement',
              tool_calls: [{ name: 'unknown', arguments: '{}' }],
            },
      ),
      threadId: 't',
      turnId: 'u',
    }));
    expect((await f.post({ ...body(), tools })).status).toBe(503);
    expect(f.model.generate).toHaveBeenCalledTimes(2);
  });
  it('never repeats a completed exact command while replacing an empty acknowledgment', async () => {
    let calls = 0;
    const f = fixture(async () => ({
      text: JSON.stringify(
        ++calls === 1
          ? { content: null, tool_calls: [] }
          : {
              content: 'Repeat rejected',
              tool_calls: [
                { name: 'exec', arguments: JSON.stringify({ intent: 'repeat', command: exact }) },
              ],
            },
      ),
      threadId: 't',
      turnId: 'u',
    }));
    const response = await f.post({
      ...body(),
      tools,
      messages: [
        { role: 'user', content: instruction },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'prior',
              type: 'function',
              function: {
                name: 'exec',
                arguments: JSON.stringify({ intent: 'completed', command: exact }),
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'prior',
          content: '{"success":true,"response":{"exitCode":1}}',
        },
      ],
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('CODEX_EXACT_EXEC_PROPOSAL_REJECTED');
    expect(f.model.generate).toHaveBeenCalledTimes(2);
  });
  it('serializes concurrent dynamic-subagent generations through a bounded queue', async () => {
    let complete: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const f = fixture(async () => {
      await gate;
      return { text: '{"content":"synthetic","tool_calls":[]}', threadId: 't', turnId: 'u' };
    });
    const first = f.post();
    await vi.waitFor(() => expect(f.model.generate).toHaveBeenCalledOnce());
    const second = f.post();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.model.generate).toHaveBeenCalledOnce();
    complete?.();
    expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([
      200, 200,
    ]);
    expect(f.model.generate).toHaveBeenCalledTimes(2);
  });
});
