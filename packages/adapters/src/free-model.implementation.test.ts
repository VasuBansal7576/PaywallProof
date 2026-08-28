import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFreeModelGateway, FREE_GATEWAY_ORIGIN, FREE_MODEL_ID, FREE_RUNTIME_MODEL, verifyFreeModel } from './free-model.ts';
import { TrueForgeAdapter } from './trueforge.ts';

// Implementation-aware synthetic transport tests. These do not establish a
// real account, free quota, successful inference or a generated repair.
const apiKey = 'synthetic_openrouter_key_for_contract_tests_only';
const gatewayToken = 'synthetic_gateway_token_for_contract_tests_only';
const key = () => ({ data: { limit: 0, limit_remaining: 0, include_byok_in_limit: true, usage: 0, byok_usage: 0 } });
const model = () => ({ id: FREE_MODEL_ID, context_length: 262144, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'tool_choice'] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const completion = () => ({ model: FREE_MODEL_ID, messages: [{ role: 'user', content: 'Synthetic tool contract' }], stream: false });
const headers = () => ({ authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json' });
afterEach(() => vi.unstubAllGlobals());
function fixture(overrides: { account?: unknown; catalog?: unknown; generation?: () => Response | Promise<Response> } = {}) {
  const calls: { url: string; options: RequestInit }[] = [];
  const transport = vi.fn(async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    if (url.endsWith('/key')) return json(overrides.account ?? key());
    if (url.endsWith('/models')) return json(overrides.catalog ?? { data: [model()] });
    return overrides.generation ? overrides.generation() : json({ id: 'synthetic', choices: [] });
  });
  const app = createFreeModelGateway({ apiKey, gatewayToken }, transport);
  const post = (body: unknown = completion(), options: RequestInit = {}) => app.request(`${FREE_GATEWAY_ORIGIN}/v1/chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify(body), ...options });
  return { calls, transport, app, post };
}

describe('free hosted model gateway, implementation-aware', () => {
  it('enforces zero price, fixed destination, privacy and no fallbacks on the actual forwarded request', async () => {
    const f = fixture();
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'synthetic', choices: [] });
    expect(f.calls.map(call => call.url)).toEqual(['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/models', 'https://openrouter.ai/api/v1/chat/completions']);
    for (const call of f.calls) expect(call.options.redirect).toBe('error');
    const generation = f.calls[2];
    expect(generation).toBeDefined();
    expect(JSON.parse(String(generation?.options.body))).toEqual({
      ...completion(), max_tokens: 4096,
      provider: { max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, allow_fallbacks: false, require_parameters: true, data_collection: 'deny' }, plugins: [],
    });
    expect(new Headers(generation?.options.headers).get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(new Headers(f.calls[1]?.options.headers).has('authorization')).toBe(false);
    expect(response.headers.has('authorization')).toBe(false);
  });

  it.each([
    { model: 'cohere/north-mini-code' }, { model: 'z-ai/glm-5.2:free' }, { model: 'google/gemma-4-31b-it:free' }, { model: 'openrouter/auto' }, { model: `${FREE_MODEL_ID}:online` },
    { models: [FREE_MODEL_ID, 'paid/model'] }, { provider: { max_price: { prompt: 1 } } },
    { plugins: [{ id: 'web' }] }, { route: 'fallback' }, { preset: 'paid-preset' }, { user: 'private-account' },
    { tools: [{ type: 'web_search' }] }, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image' } }] }] },
    { max_tokens: 8193 }, { max_tokens: -1 }, { max_tokens: 1.5 }, { max_tokens: 2, max_completion_tokens: 3 }, { temperature: 3 }, { stream_options: { include_usage: true, extra: 1 } },
  ])('rejects unsafe request fields before any external request: %j', async patch => {
    const f = fixture();
    expect((await f.post({ ...completion(), ...patch })).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it('preserves the installed TrueForge SDK assistant reasoning and tool-result continuation shape', async () => {
    const f = fixture();
    const messages = [
      { role: 'user', content: 'Run the synthetic execution probe.' },
      { role: 'assistant', content: null, reasoning_content: 'Synthetic provider reasoning fixture.',
        tool_calls: [{ id: 'exec_fixture', type: 'function', function: { name: 'exec', arguments: '{"command":"probe"}' } }] },
      { role: 'tool', tool_call_id: 'exec_fixture', content: '{"success":true}' },
    ];
    const response = await f.post({ ...completion(), messages });
    expect(response.status).toBe(200);
    await response.text();
    expect(JSON.parse(String(f.calls[2]?.options.body)).messages).toEqual(messages);
  });

  it.each([
    { role: 'user', content: 'probe', reasoning_content: 'not assistant output' },
    { role: 'assistant', content: null, reasoning_content: { provider: 'paid' } },
    { role: 'assistant', content: null, reasoning_details: [{ type: 'unknown' }] },
  ])('does not admit other metadata through reasoning compatibility: %j', async message => {
    const f = fixture();
    expect((await f.post({ ...completion(), messages: [message] })).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    { limit: null }, { limit: 1 }, { limit_remaining: null }, { limit_remaining: 1 },
    { include_byok_in_limit: false }, { usage: 0.001 }, { byok_usage: 0.001 }, { limit: '0' },
  ])('blocks a key without the required hard zero-spend settings: %j', async patch => {
    const f = fixture({ account: { data: { ...key().data, ...patch } } });
    const response = await f.post();
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('FREE_MODEL_ZERO_SPEND_KEY_REQUIRED');
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    [], [model(), model()], [{ ...model(), id: 'paid/model' }],
    [{ ...model(), pricing: { prompt: '0.1', completion: '0' } }],
    [{ ...model(), pricing: { prompt: '0', completion: '0.1' } }],
    [{ ...model(), pricing: { prompt: '0' } }],
    [{ ...model(), pricing: { prompt: 0, completion: 0 } }],
    [{ ...model(), pricing: { ...model().pricing, request: '0.01' } }],
    [{ ...model(), pricing: { ...model().pricing, overrides: [] } }],
    [{ ...model(), supported_parameters: ['tools'] }], [{ ...model(), context_length: 4096 }],
  ].map(data => ({ data })))('requires unambiguous current zero prices and tool support', async ({ data }) => {
    const f = fixture({ catalog: { data } });
    const response = await f.post();
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('FREE_MODEL_NOT_AVAILABLE_AT_ZERO_PRICE');
    expect(f.calls).toHaveLength(2);
  });

  it('rechecks account and pricing on every generation, not only startup', async () => {
    const f = fixture();
    await (await f.post()).text();
    await (await f.post()).text();
    expect(f.calls.map(call => call.url.split('/').pop())).toEqual(['key', 'models', 'completions', 'key', 'models', 'completions']);
  });

  it.each([301, 302, 307, 308, 401, 402, 403, 429, 500, 503])('never retries or leaks upstream HTTP %i content', async status => {
    const f = fixture({ generation: () => new Response(apiKey, { status, headers: { location: 'https://paid.example/' } }) });
    const response = await f.post();
    const body = await response.text();
    expect(response.status).toBe(status === 429 ? 429 : 503);
    expect(body).not.toContain(apiKey);
    expect(f.calls).toHaveLength(3);
    expect(body).toContain(status === 429 ? 'FREE_MODEL_QUOTA_EXHAUSTED' : `FREE_MODEL_HTTP_${status}`);
  });

  it.each([
    { authorization: '' }, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${apiKey}` },
    { ...headers(), origin: 'https://hostile.example' }, { ...headers(), origin: 'null' },
  ])('rejects unauthorized or browser-origin requests without calling the provider', async requestHeaders => {
    const f = fixture();
    const response = await f.post(completion(), { headers: requestHeaders });
    expect([401, 403]).toContain(response.status);
    expect(f.calls).toHaveLength(0);
  });

  it('rejects a DNS-rebound host and unknown paths before inference', async () => {
    const f = fixture();
    expect((await f.app.request('http://hostile.example:8791/v1/chat/completions', { method: 'POST', headers: headers(), body: JSON.stringify(completion()) })).status).toBe(403);
    expect((await f.app.request(`${FREE_GATEWAY_ORIGIN}/v1/responses`, { method: 'POST', headers: headers() })).status).toBe(404);
    expect(f.calls).toHaveLength(0);
  });

  it('preserves function calls and tool results instead of substituting canned model output', async () => {
    const tool = { id: 'call_synthetic', type: 'function', function: { name: 'exec', arguments: '{"command":"pwd"}' } };
    const f = fixture();
    await (await f.post({ ...completion(), messages: [
      { role: 'assistant', content: null, tool_calls: [tool] },
      { role: 'tool', tool_call_id: tool.id, content: 'synthetic path' },
    ], tools: [{ type: 'function', function: { name: 'exec', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }], tool_choice: 'auto' })).text();
    expect(JSON.parse(String(f.calls[2]?.options.body)).messages[0].tool_calls).toEqual([tool]);
  });

  it('bounds streamed request bodies without trusting Content-Length', async () => {
    const f = fixture();
    const response = await f.post({ ...completion(), messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] }, { headers: { ...headers(), 'content-length': '1' } });
    expect(await response.text()).toContain('FREE_MODEL_BODY_TOO_LARGE');
    expect(f.calls).toHaveLength(0);
  });

  it('does not expose malformed input, transport exceptions or credentials', async () => {
    const f = fixture({ generation: () => { throw new Error(apiKey); } });
    expect(await (await f.post()).text()).toContain('FREE_MODEL_UNAVAILABLE');
    expect(await (await f.post(completion(), { body: apiKey })).text()).not.toContain(apiKey);
  });

  it('passes through actual SSE bytes and keeps only one request active until consumption finishes', async () => {
    let canceled = false;
    const f = fixture({ generation: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"synthetic":true}\n\n')); },
      cancel() { canceled = true; },
    }), { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'must-not-forward', 'x-secret': apiKey } }) });
    const response = await f.post({ ...completion(), stream: true });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect((await f.post()).status).toBe(429);
    expect(f.calls).toHaveLength(3);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain('synthetic');
    await reader?.cancel();
    expect(canceled).toBe(true);
    expect(f.calls[2]?.options.signal?.aborted).toBe(true);
    const next = await f.post({ ...completion(), stream: true });
    expect(next.status).toBe(200);
    await next.body?.cancel();
  });

  it('aborts oversized output and permits recovery without retrying the failed call', async () => {
    let canceled = false;
    const f = fixture({ generation: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel() { canceled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } }) });
    const response = await f.post({ ...completion(), stream: true });
    await expect(response.text()).rejects.toThrow('FREE_MODEL_STREAM_INTERRUPTED');
    expect(canceled).toBe(true);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2]?.options.signal?.aborted).toBe(true);
  });

  it('cancels a disconnected streaming client even if it stops reading', async () => {
    let canceled = false;
    const abort = new AbortController();
    const f = fixture({ generation: () => new Response(new ReadableStream<Uint8Array>({
      cancel() { canceled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } }) });
    const response = await f.post({ ...completion(), stream: true }, { signal: abort.signal });
    abort.abort();
    await expect(response.text()).rejects.toThrow('FREE_MODEL_STREAM_INTERRUPTED');
    expect(canceled).toBe(true);
    const next = await f.post({ ...completion(), stream: true });
    expect(next.status).toBe(200);
    await next.body?.cancel();
  });

  it('cancels a stalled incoming request on disconnect and releases its single-flight lock', async () => {
    let canceled = false;
    const abort = new AbortController();
    const f = fixture();
    const request = new Request(`${FREE_GATEWAY_ORIGIN}/v1/chat/completions`, {
      method: 'POST', headers: headers(), signal: abort.signal,
      body: new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }),
      ...{ duplex: 'half' },
    });
    const pending = f.app.fetch(request);
    await Promise.resolve();
    abort.abort();
    expect((await pending).status).toBe(503);
    expect(canceled).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect((await f.post()).status).toBe(200);
  });

  it('health is authenticated, metadata-only and explicitly identifies remote inference', async () => {
    const f = fixture();
    expect((await f.app.request(`${FREE_GATEWAY_ORIGIN}/health`)).status).toBe(401);
    const response = await f.app.request(`${FREE_GATEWAY_ORIGIN}/health`, { headers: headers() });
    expect(await response.json()).toEqual({ model: FREE_MODEL_ID, contextLength: 262144, inference: 'free_hosted', maxSpendUsd: 0 });
    expect(f.calls).toHaveLength(2);
  });

  it('rejects malformed key configuration without networking', async () => {
    const transport = vi.fn();
    await expect(verifyFreeModel('bad\r\nkey', transport)).rejects.toThrow('FREE_MODEL_KEY_INVALID');
    expect(() => createFreeModelGateway({ apiKey, gatewayToken, baseUrl: 'https://paid.example' }, transport)).toThrow('FREE_MODEL_CONFIGURATION_INVALID');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { baseUrl: 'https://openrouter.ai/api/v1', modelId: FREE_MODEL_ID, allowed: false },
    { baseUrl: 'http://127.0.0.1:11434/v1', modelId: FREE_MODEL_ID, allowed: false },
    { baseUrl: `${FREE_GATEWAY_ORIGIN}/v1`, modelId: 'paid/model', allowed: false },
    { baseUrl: `${FREE_GATEWAY_ORIGIN}/v1`, modelId: FREE_MODEL_ID, allowed: true },
  ])('binds the TrueForge selection to the exact guarded connection: $baseUrl $modelId', async ({ baseUrl, modelId, allowed }) => {
    const fetcher = vi.fn(async (url: unknown) => String(url).endsWith('/health') ? json({ model: FREE_MODEL_ID, inference: 'free_hosted', maxSpendUsd: 0 }) : json({ data: [{ name: 'paywallproof-free', manifest: {
      type: 'custom', name: 'paywallproof-free', baseUrl, auth: { apiKey: gatewayToken },
      models: [{ name: 'north-mini-code', modelId, properties: { contextLength: 262144, maxOutputTokens: 8192 } }],
    } }] }));
    vi.stubGlobal('fetch', fetcher);
    const adapter = new TrueForgeAdapter({ model: FREE_RUNTIME_MODEL, gatewayToken });
    if (allowed) await expect(adapter.checkConnection()).resolves.toEqual({ model: FREE_RUNTIME_MODEL, local: true, inference: 'free_hosted' });
    else await expect(adapter.checkConnection()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(allowed ? 2 : 1);
  });
});
