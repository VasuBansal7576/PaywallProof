import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';

export const FREE_MODEL_ID = 'cohere/north-mini-code:free';
export const FREE_RUNTIME_MODEL = 'paywallproof-free/north-mini-code';
export const FREE_GATEWAY_ORIGIN = 'http://127.0.0.1:8791';
const upstream = 'https://openrouter.ai/api/v1';
const requestLimit = 2 * 1024 * 1024;
const responseLimit = 8 * 1024 * 1024;
const secret = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);
const configSchema = z.strictObject({ apiKey: secret, gatewayToken: secret });
type Transport = (url: string, options: RequestInit) => Promise<Response>;
const systemFetch: Transport = (url, options) => fetch(url, options);

class FreeModelError extends Error {
  constructor(readonly code: string) { super(code); }
}

// Text and client-side function tools only. No server tools, web searches,
// plugins, presets, fallback model arrays, external files or routing overrides.
const functionCall = z.strictObject({ name: z.string(), arguments: z.string() });
const message = z.strictObject({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.strictObject({ type: z.literal('text'), text: z.string() })), z.null()]).optional(),
  // The installed OpenAI-compatible SDK sends prior model reasoning with an
  // assistant tool call. Preserve that text on the next turn, within the same
  // body-size budget; it cannot override request routing or pricing.
  reasoning_content: z.string().optional(),
  name: z.string().optional(), tool_call_id: z.string().optional(),
  tool_calls: z.array(z.strictObject({ id: z.string(), type: z.literal('function'), function: functionCall })).optional(),
}).refine(value => value.reasoning_content === undefined || value.role === 'assistant');
const completionSchema = z.strictObject({
  model: z.literal(FREE_MODEL_ID), messages: z.array(message).min(1).max(512),
  stream: z.boolean().optional(),
  stream_options: z.strictObject({ include_usage: z.boolean() }).optional(),
  max_tokens: z.number().int().min(1).max(8192).optional(),
  max_completion_tokens: z.number().int().min(1).max(8192).optional(),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  tools: z.array(z.strictObject({ type: z.literal('function'), function: z.strictObject({
    name: z.string(), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()), strict: z.boolean().optional(),
  }) })).max(128).optional(),
  tool_choice: z.union([z.enum(['auto', 'none', 'required']), z.strictObject({ type: z.literal('function'), function: z.strictObject({ name: z.string() }) })]).optional(),
  parallel_tool_calls: z.boolean().optional(),
}).refine(request => !(request.max_tokens !== undefined && request.max_completion_tokens !== undefined));

async function boundedJson(body: ReadableStream<Uint8Array> | null, maximum: number, signal?: AbortSignal): Promise<unknown> {
  if (!body) throw new FreeModelError('FREE_MODEL_INVALID_BODY');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new FreeModelError('FREE_MODEL_BODY_TOO_LARGE');
      chunks.push(chunk.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof FreeModelError) throw error;
    throw new FreeModelError('FREE_MODEL_INVALID_BODY');
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}

function httpError(status: number): FreeModelError {
  return new FreeModelError(status === 429 ? 'FREE_MODEL_QUOTA_EXHAUSTED' : `FREE_MODEL_HTTP_${status}`);
}

/** Checks metadata, never generates tokens. A zero-dollar key is mandatory. */
export async function verifyFreeModel(apiKey: string, transport: Transport = systemFetch, signal = AbortSignal.timeout(15_000)) {
  if (!secret.safeParse(apiKey).success) throw new FreeModelError('FREE_MODEL_KEY_INVALID');
  const metadata = async (path: string, authenticated: boolean) => {
    let response: Response;
    try {
      response = await transport(`${upstream}/${path}`, {
        method: 'GET', redirect: 'error', signal,
        headers: authenticated ? { authorization: `Bearer ${apiKey}` } : {},
      });
    } catch { throw new FreeModelError('FREE_MODEL_UNAVAILABLE'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw httpError(response.status);
    }
    if (!response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel();
      throw new FreeModelError('FREE_MODEL_INVALID_METADATA');
    }
    return boundedJson(response.body, requestLimit, signal);
  };
  const account = z.object({ data: z.object({
    limit: z.literal(0), limit_remaining: z.literal(0), include_byok_in_limit: z.literal(true),
    usage: z.literal(0), byok_usage: z.literal(0),
  }) }).safeParse(await metadata('key', true));
  if (!account.success) throw new FreeModelError('FREE_MODEL_ZERO_SPEND_KEY_REQUIRED');
  const catalog = z.object({ data: z.array(z.object({
    id: z.string(), context_length: z.number().int().positive(),
    pricing: z.record(z.string(), z.unknown()), supported_parameters: z.array(z.string()),
  })) }).safeParse(await metadata('models', false));
  if (!catalog.success) throw new FreeModelError('FREE_MODEL_INVALID_CATALOG');
  const matches = catalog.data.data.filter(model => model.id === FREE_MODEL_ID);
  const model = matches[0];
  // Reject unfamiliar pricing structures, overrides and missing prices as well
  // as nonzero prices. Do not infer that a missing price means free.
  if (matches.length !== 1 || !model || model.pricing.prompt !== '0' || model.pricing.completion !== '0'
    || Object.values(model.pricing).some(price => price !== '0')
    || !model.supported_parameters.includes('tools') || !model.supported_parameters.includes('tool_choice')
    || model.context_length < 32768) throw new FreeModelError('FREE_MODEL_NOT_AVAILABLE_AT_ZERO_PRICE');
  return { model: FREE_MODEL_ID, contextLength: model.context_length, inference: 'free_hosted' as const, maxSpendUsd: 0 as const };
}

/** A policy gateway, not an inference server. Never loads weights or retries. */
export function createFreeModelGateway(input: unknown, transport: Transport = systemFetch) {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new FreeModelError('FREE_MODEL_CONFIGURATION_INVALID');
  const config = parsed.data;
  const authorization = Buffer.from(`Bearer ${config.gatewayToken}`);
  let busy = false;
  const app = new Hono();
  app.onError((error, c) => {
    const code = error instanceof FreeModelError ? error.code : 'FREE_MODEL_UNAVAILABLE';
    return c.json({ error: { message: code, type: 'no_charge_policy' } }, code === 'FREE_MODEL_QUOTA_EXHAUSTED' ? 429 : 503);
  });
  app.use('*', async (c, next) => {
    if (new URL(c.req.url).origin !== FREE_GATEWAY_ORIGIN || c.req.header('origin')) return c.json({ error: 'FREE_MODEL_ORIGIN_REJECTED' }, 403);
    const provided = Buffer.from(c.req.header('authorization') ?? '');
    if (provided.length !== authorization.length || !timingSafeEqual(provided, authorization)) return c.json({ error: 'FREE_MODEL_UNAUTHORIZED' }, 401);
    await next();
  });
  app.get('/health', async c => c.json(await verifyFreeModel(config.apiKey, transport, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]))));
  app.post('/v1/chat/completions', async c => {
    if (busy) return c.json({ error: 'FREE_MODEL_BUSY' }, 429);
    if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') return c.json({ error: 'FREE_MODEL_JSON_REQUIRED' }, 415);
    busy = true;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, c.req.raw.signal, AbortSignal.timeout(180_000)]);
    const release = () => { busy = false; abort.abort(); };
    try {
      const request = completionSchema.safeParse(await boundedJson(c.req.raw.body, requestLimit, signal));
      if (!request.success) { release(); return c.json({ error: 'FREE_MODEL_REQUEST_REJECTED' }, 400); }
      await verifyFreeModel(config.apiKey, transport, signal);
      signal.throwIfAborted();
      const { max_completion_tokens, ...accepted } = request.data;
      const response = await transport(`${upstream}/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...accepted, max_tokens: request.data.max_tokens ?? max_completion_tokens ?? 4096,
          provider: { max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, allow_fallbacks: false, require_parameters: true, data_collection: 'deny' },
          plugins: [],
        }),
      });
      if (!response.ok) { await response.body?.cancel(); throw httpError(response.status); }
      const contentType = request.data.stream ? 'text/event-stream' : 'application/json';
      if (!response.body || !response.headers.get('content-type')?.startsWith(contentType)) {
        await response.body?.cancel(); throw new FreeModelError('FREE_MODEL_INVALID_RESPONSE');
      }
      const reader = response.body.getReader();
      let bytes = 0;
      let finished = false;
      let stopStream = () => {};
      const finish = () => { if (!finished) { finished = true; signal.removeEventListener('abort', stopStream); release(); } };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stopStream = () => {
            if (finished) return;
            finish(); void reader.cancel().catch(() => {});
            controller.error(new Error('FREE_MODEL_STREAM_INTERRUPTED'));
          };
          signal.addEventListener('abort', stopStream, { once: true });
          if (signal.aborted) stopStream();
        },
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (finished) return;
            if (chunk.done) { finish(); controller.close(); return; }
            bytes += chunk.value.byteLength;
            if (bytes > responseLimit) throw new FreeModelError('FREE_MODEL_RESPONSE_TOO_LARGE');
            controller.enqueue(chunk.value);
          } catch {
            finish(); await reader.cancel().catch(() => {});
            controller.error(new Error('FREE_MODEL_STREAM_INTERRUPTED'));
          }
        },
        async cancel() { finish(); await reader.cancel().catch(() => {}); },
      });
      return new Response(body, { headers: { 'content-type': contentType, 'cache-control': 'no-store' } });
    } catch (error) {
      release();
      if (error instanceof FreeModelError) throw error;
      throw new FreeModelError('FREE_MODEL_UNAVAILABLE');
    }
  });
  return app;
}
