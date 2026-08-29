import { z } from 'zod';

const functionCall = z.strictObject({ name: z.string(), arguments: z.string() });
const message = z
  .strictObject({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z
      .union([
        z.string(),
        z.array(z.strictObject({ type: z.literal('text'), text: z.string() })),
        z.null(),
      ])
      .optional(),
    reasoning_content: z.string().optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z
      .array(
        z.strictObject({
          id: z.string(),
          type: z.literal('function'),
          function: functionCall,
        }),
      )
      .optional(),
  })
  .refine((value) => value.reasoning_content === undefined || value.role === 'assistant');

/** Text and client-side function tools only. */
export function textCompletionSchema(modelId: string) {
  return z
    .strictObject({
      model: z.literal(modelId),
      messages: z.array(message).min(1).max(512),
      stream: z.boolean().optional(),
      stream_options: z.strictObject({ include_usage: z.boolean() }).optional(),
      max_tokens: z.number().int().min(1).max(8192).optional(),
      max_completion_tokens: z.number().int().min(1).max(8192).optional(),
      temperature: z.number().min(0).max(2).optional(),
      top_p: z.number().min(0).max(1).optional(),
      stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
      tools: z
        .array(
          z.strictObject({
            type: z.literal('function'),
            function: z.strictObject({
              name: z.string(),
              description: z.string().optional(),
              parameters: z.record(z.string(), z.unknown()),
              strict: z.boolean().optional(),
            }),
          }),
        )
        .max(128)
        .optional(),
      tool_choice: z
        .union([
          z.enum(['auto', 'none', 'required']),
          z.strictObject({
            type: z.literal('function'),
            function: z.strictObject({ name: z.string() }),
          }),
        ])
        .optional(),
      parallel_tool_calls: z.boolean().optional(),
    })
    .refine(
      (request) =>
        !(request.max_tokens !== undefined && request.max_completion_tokens !== undefined),
    );
}

export async function boundedJson(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!body) throw new Error('MODEL_PROTOCOL_INVALID_BODY');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new Error('MODEL_PROTOCOL_BODY_TOO_LARGE');
      chunks.push(chunk.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof Error && error.message === 'MODEL_PROTOCOL_BODY_TOO_LARGE') throw error;
    throw new Error('MODEL_PROTOCOL_INVALID_BODY', { cause: error });
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
