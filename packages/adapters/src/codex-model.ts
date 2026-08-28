import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { boundedJson, textCompletionSchema } from './free-model.ts';
import { CODEX_GATEWAY_ORIGIN, CODEX_MODEL_ID, CodexSubscriptionError, verifyCodexSubscription, withCodexClient, type CodexGeneratedOutput } from './codex-subscription.ts';

const requestSchema = textCompletionSchema(CODEX_MODEL_ID);
type Completion = z.infer<typeof requestSchema>;
const decisionSchema = z.strictObject({
  content: z.string().nullable(),
  tool_calls: z.array(z.strictObject({ name: z.string().min(1), arguments: z.string() })).max(16),
});
const generatedDecisionSchema = z.strictObject({ content: z.string().nullable(), tool_calls: z.array(z.strictObject({
  name: z.string().min(1), arguments: z.union([z.string(), z.strictObject({ intent: z.string(), command: z.string(), cwd: z.string().nullable().optional() })]),
})).max(16) });
const outputSchema = z.toJSONSchema(decisionSchema.extend({content:z.string().min(1)}));
export type CodexGeneration = CodexGeneratedOutput;
export type CodexBackend = {
  check(signal: AbortSignal): Promise<unknown>;
  generate(prompt: string, schema: Record<string, unknown>, signal: AbortSignal): Promise<CodexGeneration>;
};
const backend: CodexBackend = {
  check: signal => withCodexClient(signal, verifyCodexSubscription),
  generate: (prompt, schema, signal) => withCodexClient(signal, client => client.generate(prompt, schema)),
};

const exactExecInstruction = /^Execute exactly one exec tool call with command ("(?:[^"\\]|\\.)*")\. Do not set cwd or env\. Do not run any other tools or commands\. When it returns, reply briefly\.$/;
function activeExchange(request: Completion) {
  const index = request.messages.reduce((last, message, index) => message.role === 'user' ? index : last, -1);
  const current = request.messages[index];
  const text = typeof current?.content === 'string' ? current.content : current?.content?.map(part => part.text).join('\n') ?? '';
  return { index, text, following: request.messages.slice(index + 1) };
}
/** Recognizes only the controller's complete exact-exec grammar, never text in tool results. */
function exactExecContract(request: Completion) {
  const active = activeExchange(request);
  const match = exactExecInstruction.exec(active.text);
  if (!match?.[1]) return undefined;
  const command = z.string().min(1).max(8192).parse(JSON.parse(match[1]));
  if (!request.tools?.some(tool => tool.function.name === 'exec')) throw new CodexSubscriptionError('CODEX_EXEC_TOOL_MISSING');
  const calls = active.following.flatMap(message => message.role === 'assistant' ? message.tool_calls ?? [] : []);
  if (calls.length > 1) throw new CodexSubscriptionError('CODEX_EXACT_EXEC_ALREADY_VIOLATED');
  if (calls.length === 0) return { command, completed: false };
  const call = calls[0];
  if (!call || call.function.name !== 'exec') throw new CodexSubscriptionError('CODEX_EXACT_EXEC_ALREADY_VIOLATED');
  const args = z.strictObject({ command: z.literal(command), intent: z.string() }).safeParse(JSON.parse(call.function.arguments));
  if (!args.success || !active.following.some(message => message.role === 'tool' && message.tool_call_id === call.id)) throw new CodexSubscriptionError('CODEX_EXACT_EXEC_ALREADY_VIOLATED');
  return { command, completed: true };
}
export function decisionOutputSchema(request: Completion) {
  const contract = exactExecContract(request);
  if (!contract) {
    if (!request.tools?.some(tool => tool.function.name === 'exec')) return outputSchema;
    // A command is already a string. Nesting another JSON document around it
    // requires a second escaping layer and has failed on real model responses.
    const exec = z.strictObject({ name: z.literal('exec'), arguments: z.strictObject({ intent: z.string(), command: z.string(), cwd: z.string().nullable() }) });
    const otherNames = request.tools.filter(tool => tool.function.name !== 'exec').map(tool => tool.function.name);
    const calls = otherNames.length ? z.union([exec, z.strictObject({ name: z.enum(otherNames), arguments: z.string() })]) : exec;
    return z.toJSONSchema(z.strictObject({ content: z.string().min(1), tool_calls: z.array(calls).max(16) }));
  }
  // The model still produces the decision. Constrain the trusted controller's
  // exact operation instead of accepting a guessed command and rejecting it
  // only after TrueForge has already executed it.
  return z.toJSONSchema(z.strictObject({ content: contract.completed ? z.string().min(1) : z.string().nullable(), tool_calls: contract.completed
    ? decisionSchema.shape.tool_calls.max(0)
    : z.array(z.strictObject({ name: z.literal('exec'), arguments: z.strictObject({ intent: z.literal('Execute the single controller-authorized command.'), command: z.literal(contract.command) }) })).length(1) }));
}
export function codexDecisionPrompt(request: Completion) {
  const active = activeExchange(request);
  return `Return one assistant decision as JSON: content plus tool_calls. Follow the output schema for arguments: exec uses an object, other tools use a JSON-encoded string. Set exec cwd to null only when no working directory is needed. Tools are proposals executed by TrueForge, not by you. Never invent their results. Follow the current instruction below, not an older command. For an exact single-command instruction, acknowledge its recorded result and never repeat it, including after failure. For multi-step instructions, continue with the next necessary proposal until the requested work is actually complete. Do not mistake source inspection for a completed edit. Respect tool_choice and parallel_tool_calls.\n\nCURRENT INSTRUCTION (verbatim):\n${active.text}\n\nMESSAGES SINCE THAT INSTRUCTION:\n${JSON.stringify(active.following)}\n\nEARLIER CONTEXT (completed history and system instructions):\n${JSON.stringify(request.messages.slice(0, Math.max(0, active.index)))}\n\nAVAILABLE TOOLS AND CALL POLICY:\n${JSON.stringify({ tools: request.tools ?? [], tool_choice: request.tool_choice ?? 'auto', parallel_tool_calls: request.parallel_tool_calls ?? true })}`;
}

export function parseCodexDecision(result: CodexGeneration, request: Completion) {
  if (Buffer.byteLength(result.text) > 256 * 1024) throw new CodexSubscriptionError('CODEX_DECISION_TOO_LARGE');
  if (!result.text.trim()) throw new CodexSubscriptionError('CODEX_EMPTY_DECISION');
  const generated = generatedDecisionSchema.parse(JSON.parse(result.text));
  const parsed = decisionSchema.safeParse({ ...generated, tool_calls: generated.tool_calls.map(call => {
    if (typeof call.arguments === 'string') return call;
    if (call.name !== 'exec') throw new CodexSubscriptionError('CODEX_INVALID_TOOL_ARGUMENTS');
    const { cwd, ...args } = call.arguments;
    return { ...call, arguments: JSON.stringify({ ...args, ...(cwd === null || cwd === undefined ? {} : { cwd }) }) };
  }) });
  if (!parsed.success) throw new CodexSubscriptionError('CODEX_INVALID_DECISION');
  const decision = parsed.data;
  const contract = exactExecContract(request);
  if (contract && (contract.completed ? decision.tool_calls.length !== 0 : decision.tool_calls.length !== 1
    || decision.tool_calls[0]?.name !== 'exec'
    || !z.strictObject({ intent: z.string(), command: z.literal(contract.command) }).safeParse(JSON.parse(decision.tool_calls[0]?.arguments ?? 'null')).success)) {
    throw new CodexSubscriptionError('CODEX_EXACT_EXEC_PROPOSAL_REJECTED');
  }
  const known = new Set(request.tools?.map(tool => tool.function.name) ?? []);
  if (decision.tool_calls.some(call => !known.has(call.name))) throw new CodexSubscriptionError('CODEX_UNKNOWN_TOOL_PROPOSAL');
  if ((request.tool_choice === 'none' && decision.tool_calls.length)
    || (request.tool_choice === 'required' && !decision.tool_calls.length)
    || (request.parallel_tool_calls === false && decision.tool_calls.length > 1)
    || (typeof request.tool_choice === 'object' && (decision.tool_calls.length !== 1 || decision.tool_calls[0]?.name !== request.tool_choice.function.name))) {
    throw new CodexSubscriptionError('CODEX_TOOL_CHOICE_VIOLATION');
  }
  for (const call of decision.tool_calls) {
    const args: unknown = JSON.parse(call.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CodexSubscriptionError('CODEX_INVALID_TOOL_ARGUMENTS');
  }
  if (!decision.tool_calls.length && !decision.content?.trim()) throw new CodexSubscriptionError('CODEX_EMPTY_DECISION');
  return { role: 'assistant' as const, content: decision.content, ...(decision.tool_calls.length ? { tool_calls: decision.tool_calls.map(call => ({
    id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function' as const, function: call,
  })) } : {}) };
}

/** Local protocol translation over the official Codex harness; no token proxy. */
export function createCodexModelGateway(gatewayToken: string, model: CodexBackend = backend) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(gatewayToken)) throw new CodexSubscriptionError('CODEX_GATEWAY_TOKEN_INVALID');
  const authorization = Buffer.from(`Bearer ${gatewayToken}`);
  let busy = false;
  const app = new Hono();
  app.onError((error, c) => c.json({ error: { message: error instanceof CodexSubscriptionError ? error.code : 'CODEX_SUBSCRIPTION_UNAVAILABLE', type: 'subscription_policy' } }, 503));
  app.use('*', async (c, next) => {
    if (new URL(c.req.url).origin !== CODEX_GATEWAY_ORIGIN || c.req.header('origin')) return c.json({ error: 'CODEX_ORIGIN_REJECTED' }, 403);
    const provided = Buffer.from(c.req.header('authorization') ?? '');
    if (provided.length !== authorization.length || !timingSafeEqual(provided, authorization)) return c.json({ error: 'CODEX_UNAUTHORIZED' }, 401);
    await next();
  });
  app.get('/health', async c => c.json(await model.check(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]))));
  app.post('/v1/chat/completions', async c => {
    if (busy) return c.json({ error: 'CODEX_BUSY' }, 429);
    if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') return c.json({ error: 'CODEX_JSON_REQUIRED' }, 415);
    busy = true;
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(180000)]);
    try {
      const parsed = requestSchema.safeParse(await boundedJson(c.req.raw.body, 2 * 1024 * 1024, signal));
      if (!parsed.success) return c.json({ error: 'CODEX_REQUEST_REJECTED' }, 400);
      const request = parsed.data;
      const prompt=codexDecisionPrompt(request),schema=decisionOutputSchema(request);
      let result=await model.generate(prompt,schema,signal);
      signal.throwIfAborted();
      let message:ReturnType<typeof parseCodexDecision>;
      try {message=parseCodexDecision(result,request);}
      catch(error){
        // A completed but empty proposal dispatched no tool. One replacement
        // generation is safe; transport, billing and authorization errors are
        // never retried. The same deadline and exact-command guards still apply.
        if(!(error instanceof CodexSubscriptionError)||error.code!=='CODEX_EMPTY_DECISION')throw error;
        const first=result;
        result=await model.generate(`${prompt}\n\nYour previous structured decision was empty and no proposed tool was forwarded. Return a nonempty decision that follows the current instruction and the unchanged schema. Do not claim an action happened without a recorded tool result.`,schema,signal);
        signal.throwIfAborted();
        message=parseCodexDecision(result,request);
        result={...result,usage:first.usage&&result.usage?{inputTokens:first.usage.inputTokens+result.usage.inputTokens,outputTokens:first.usage.outputTokens+result.usage.outputTokens,totalTokens:first.usage.totalTokens+result.usage.totalTokens}:undefined};
      }
      const id = `codex_${result.threadId}_${result.turnId}`;
      const common = { id, model: CODEX_MODEL_ID, created: Math.floor(Date.now() / 1000) };
      const usage = result.usage ? { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens, total_tokens: result.usage.totalTokens } : undefined;
      const finishReason = message.tool_calls?.length ? 'tool_calls' : 'stop';
      if (!request.stream) return c.json({ ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finishReason }], ...(usage ? { usage } : {}) });
      // Codex's structured final answer is buffered. Emit a valid completed SSE
      // response; do not fabricate token counts or simulated streaming progress.
      const chunks = [
        { ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) }, finish_reason: null }] },
        { ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
      ];
      const usageEvent = usage && request.stream_options?.include_usage ? `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [], usage })}\n\n` : '';
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + usageEvent + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
    } finally { busy = false; }
  });
  return app;
}
