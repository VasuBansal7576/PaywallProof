import { Hono } from 'hono';

const maximumBodyBytes = 1024 * 1024;
const signatureHeaders = ['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const;

class WebhookBodyTooLargeError extends Error {
  constructor() {
    super('WEBHOOK_BODY_TOO_LARGE');
  }
}

/** Reads exact signature bytes while enforcing the limit during streaming. */
export async function readBoundedWebhookBody(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes = maximumBodyBytes,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WebhookBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Exposes one narrow route while the private reference target stays on loopback. */
export function createPolarWebhookRelay(forward: typeof fetch = fetch) {
  const app = new Hono();
  app.post('/api/polar/webhook', async (context) => {
    const mediaType = context.req.header('content-type')?.split(';')[0]?.trim();
    if (mediaType !== 'application/json')
      return context.json({ error: 'WEBHOOK_CONTENT_TYPE_REQUIRED' }, 415);
    const forwardedHeaders: Record<string, string> = { 'content-type': 'application/json' };
    for (const name of signatureHeaders) {
      const value = context.req.header(name);
      if (!value) return context.json({ error: 'WEBHOOK_SIGNATURE_REQUIRED' }, 400);
      forwardedHeaders[name] = value;
    }
    const declaredLength = context.req.header('content-length');
    if (
      declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBodyBytes)
    )
      return context.json({ error: 'WEBHOOK_BODY_TOO_LARGE' }, 413);
    let body: Uint8Array;
    try {
      body = await readBoundedWebhookBody(context.req.raw.body);
    } catch (error) {
      if (error instanceof WebhookBodyTooLargeError)
        return context.json({ error: 'WEBHOOK_BODY_TOO_LARGE' }, 413);
      throw error;
    }
    try {
      const response = await forward('http://127.0.0.1:3001/api/polar/webhook', {
        method: 'POST',
        headers: forwardedHeaders,
        body: Buffer.from(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': response.headers.get('content-type') ?? 'application/json',
        },
      });
    } catch {
      return context.json({ error: 'WEBHOOK_TARGET_UNAVAILABLE' }, 502);
    }
  });
  app.notFound((context) => context.json({ error: 'NOT_FOUND' }, 404));
  return app;
}
