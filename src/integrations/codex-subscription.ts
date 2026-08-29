import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const CODEX_MODEL_ID = 'gpt-5.6-luna';
export const CODEX_RUNTIME_MODEL = 'paywallproof-codex/luna';
export const CODEX_GATEWAY_ORIGIN = 'http://127.0.0.1:8792';

export class CodexSubscriptionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
type Method =
  | 'initialize'
  | 'account/read'
  | 'account/rateLimits/read'
  | 'model/list'
  | 'config/read'
  | 'thread/start'
  | 'turn/start';
export type CodexRpc = {
  request(method: Method, params?: Record<string, unknown>): Promise<unknown>;
};
const quotaWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  windowDurationMins: z.number().positive(),
  resetsAt: z.number().int().positive(),
});
const quota = z.object({
  limitId: z.literal('codex'),
  planType: z.enum(['plus', 'pro']),
  primary: quotaWindow,
  secondary: quotaWindow.nullable(),
  credits: z.object({
    hasCredits: z.literal(false),
    unlimited: z.literal(false),
    balance: z.string().regex(/^0(?:\.0+)?$/),
  }),
  rateLimitReachedType: z.null(),
  spendControlReached: z.literal(false),
});

/** Metadata only. Unknown billing modes and extra-credit balances fail closed. */
export async function verifyCodexSubscription(rpc: CodexRpc) {
  const account = z
    .object({
      account: z.object({ type: z.literal('chatgpt'), planType: z.enum(['plus', 'pro']) }),
      requiresOpenaiAuth: z.literal(true),
    })
    .safeParse(await rpc.request('account/read', { refreshToken: false }));
  if (!account.success) throw new CodexSubscriptionError('CODEX_CHATGPT_SUBSCRIPTION_REQUIRED');
  const limits = z
    .object({
      rateLimits: quota,
      rateLimitsByLimitId: z.record(z.string(), z.unknown()).nullable(),
    })
    .safeParse(await rpc.request('account/rateLimits/read'));
  if (!limits.success) throw new CodexSubscriptionError('CODEX_NO_EXTRA_CREDIT_GUARD_FAILED');
  const bucket = limits.data.rateLimits;
  if (bucket.planType !== account.data.account.planType)
    throw new CodexSubscriptionError('CODEX_ACCOUNT_CHANGED');
  if (limits.data.rateLimitsByLimitId?.codex !== undefined) {
    const duplicate = quota.safeParse(limits.data.rateLimitsByLimitId.codex);
    if (!duplicate.success || JSON.stringify(duplicate.data) !== JSON.stringify(bucket))
      throw new CodexSubscriptionError('CODEX_QUOTA_AMBIGUOUS');
  }
  if (bucket.primary.usedPercent >= 100 || (bucket.secondary?.usedPercent ?? 0) >= 100)
    throw new CodexSubscriptionError('CODEX_INCLUDED_USAGE_EXHAUSTED');
  const catalog = z
    .object({
      data: z.array(z.object({ model: z.string(), hidden: z.boolean() })),
      nextCursor: z.null(),
    })
    .safeParse(await rpc.request('model/list', { includeHidden: false }));
  if (
    !catalog.success ||
    catalog.data.data.filter((model) => model.model === CODEX_MODEL_ID && !model.hidden).length !==
      1
  ) {
    throw new CodexSubscriptionError('CODEX_LUNA_UNAVAILABLE');
  }
  return {
    model: CODEX_MODEL_ID,
    inference: 'codex_subscription' as const,
    planType: bucket.planType,
    includedUsageRemainingPercent:
      100 - Math.max(bucket.primary.usedPercent, bucket.secondary?.usedPercent ?? 0),
    extraCredits: 0 as const,
  };
}

// Environment-less proposal generation. TrueForge alone executes the proposed
// tools in its sandbox. Codex cannot read host tests or acquire another tool.
export const codexDisabledFeatures = [
  'apps',
  'plugins',
  'remote_plugin',
  'hooks',
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'in_app_browser',
  'computer_use',
  'image_generation',
  'view_image',
  'multi_agent',
  'multi_agent_v2',
  'memories',
  'chronicle',
  'skill_search',
  'skill_mcp_dependency_install',
  'workspace_dependencies',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'artifact',
  'goals',
  'tool_suggest',
  'fast_mode',
];
export function codexProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'].flatMap((key) =>
        environment[key] ? [[key, environment[key]]] : [],
      ),
    ),
    NODE_ENV: 'production',
  };
}
export function codexProcessArguments() {
  return [
    'app-server',
    '--stdio',
    '-c',
    'model_provider="openai"',
    '-c',
    'forced_login_method="chatgpt"',
    '-c',
    'web_search="disabled"',
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'analytics.enabled=false',
    ...codexDisabledFeatures.flatMap((feature) => ['--disable', feature]),
  ];
}
const rpcMessage = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const completedItem = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({
    type: z.string(),
    text: z.string().optional(),
    phase: z.enum(['commentary', 'final_answer']).nullable().optional(),
  }),
});
const completedTurn = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string(), status: z.string(), error: z.unknown().nullable() }),
});
const transientHttp = z.object({ httpStatusCode: z.number().int().nullable().optional() });
const retryingError = z.object({
  threadId: z.string(),
  turnId: z.string(),
  willRetry: z.literal(true),
  error: z.object({
    codexErrorInfo: z.union([
      z.strictObject({ responseStreamDisconnected: transientHttp }),
      z.strictObject({ responseStreamConnectionFailed: transientHttp }),
      z.strictObject({ httpConnectionFailed: transientHttp }),
    ]),
  }),
});
const safeItems = new Set(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction']);
const maxProtocolBytes = 8 * 1024 * 1024;
const tokenCounts = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type CodexGeneratedOutput = {
  text: string;
  threadId: string;
  turnId: string;
  usage?: z.infer<typeof tokenCounts>;
};

/** Official stdio app-server only; never reads or forwards authentication files. */
export async function withCodexClient<T>(
  signal: AbortSignal,
  run: (client: CodexClient) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'paywallproof-codex-'));
  const client = new CodexClient(directory, signal);
  try {
    await client.initialize();
    return await run(client);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export class CodexClient implements CodexRpc {
  private readonly child;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private buffer = '';
  private bytes = 0;
  private failure: Error | undefined;
  private output:
    | {
        threadId: string;
        turnId?: string;
        text: string[];
        usage?: z.infer<typeof tokenCounts>;
        resolve(value: CodexGeneratedOutput): void;
        reject(error: Error): void;
      }
    | undefined;
  private readonly abort: () => void;

  constructor(
    private readonly directory: string,
    private readonly signal: AbortSignal,
  ) {
    this.child = spawn('codex', codexProcessArguments(), {
      cwd: directory,
      env: codexProcessEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.abort = () => this.fail('CODEX_INTERRUPTED');
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > maxProtocolBytes) return this.fail('CODEX_OUTPUT_TOO_LARGE');
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (line.trim()) this.receive(line);
      }
    });
    // SDK stderr can contain request details. Do not log it or pass it upstream.
    this.child.stderr.resume();
    this.child.on('error', () => this.fail('CODEX_UNAVAILABLE'));
    this.child.stdin.on('error', () => this.fail('CODEX_UNAVAILABLE'));
    this.child.on('exit', () => this.fail('CODEX_EXITED'));
  }

  private fail(code: string) {
    if (this.failure) return;
    this.failure = new CodexSubscriptionError(code);
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
    this.output?.reject(this.failure);
    this.output = undefined;
    this.child.kill('SIGTERM');
  }
  private receive(line: string) {
    try {
      const message = rpcMessage.parse(JSON.parse(line));
      if (message.id !== undefined && message.method)
        return this.fail('CODEX_UNEXPECTED_TOOL_OR_APPROVAL');
      if (typeof message.id === 'number') {
        const request = this.pending.get(message.id);
        if (!request) return this.fail('CODEX_UNKNOWN_RESPONSE');
        this.pending.delete(message.id);
        if (message.error !== undefined) {
          request.reject(new CodexSubscriptionError('CODEX_REQUEST_FAILED'));
          return;
        }
        request.resolve(message.result);
        return;
      }
      if (message.method === 'error') {
        const retry = retryingError.safeParse(message.params);
        if (
          !retry.success ||
          !this.output ||
          retry.data.threadId !== this.output.threadId ||
          (this.output.turnId && retry.data.turnId !== this.output.turnId)
        )
          return this.fail('CODEX_TURN_FAILED');
        const info = retry.data.error.codexErrorInfo;
        const status =
          'responseStreamDisconnected' in info
            ? info.responseStreamDisconnected.httpStatusCode
            : 'responseStreamConnectionFailed' in info
              ? info.responseStreamConnectionFailed.httpStatusCode
              : info.httpConnectionFailed.httpStatusCode;
        if (
          status !== null &&
          status !== undefined &&
          status !== 408 &&
          (status < 500 || status > 599)
        )
          return this.fail('CODEX_TURN_FAILED');
        // This is an in-progress notification, not a terminal failure. Do not
        // issue another request: the official client owns the retry and the
        // original abort signal still bounds the entire generation.
        this.output.turnId = retry.data.turnId;
        this.output.text = [];
        this.output.usage = undefined;
        return;
      }
      if (!this.output) return;
      if (message.method === 'thread/tokenUsage/updated') {
        const event = z
          .object({
            threadId: z.string(),
            turnId: z.string(),
            tokenUsage: z.object({ last: tokenCounts }),
          })
          .parse(message.params);
        if (
          event.threadId !== this.output.threadId ||
          (this.output.turnId && event.turnId !== this.output.turnId)
        )
          return this.fail('CODEX_TURN_MISMATCH');
        this.output.usage = event.tokenUsage.last;
      }
      if (message.method === 'item/started' || message.method === 'item/completed') {
        const event = completedItem.parse(message.params);
        if (event.threadId !== this.output.threadId || !safeItems.has(event.item.type))
          return this.fail('CODEX_UNEXPECTED_TOOL_OR_APPROVAL');
        if (this.output.turnId && event.turnId !== this.output.turnId)
          return this.fail('CODEX_TURN_MISMATCH');
        this.output.turnId = event.turnId;
        if (
          message.method === 'item/completed' &&
          event.item.type === 'agentMessage' &&
          event.item.phase !== 'commentary'
        )
          this.output.text = [event.item.text ?? ''];
      }
      if (message.method === 'turn/completed') {
        const event = completedTurn.parse(message.params);
        if (
          event.threadId !== this.output.threadId ||
          (this.output.turnId && event.turn.id !== this.output.turnId) ||
          event.turn.status !== 'completed' ||
          event.turn.error !== null
        )
          return this.fail('CODEX_TURN_FAILED');
        const output = this.output;
        this.output = undefined;
        output.resolve({
          text: output.text.join('\n'),
          threadId: event.threadId,
          turnId: event.turn.id,
          ...(output.usage ? { usage: output.usage } : {}),
        });
      }
    } catch {
      this.fail('CODEX_INVALID_PROTOCOL');
    }
  }
  async request(method: Method, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.failure) throw this.failure;
    this.signal.throwIfAborted();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'paywallproof', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }
  async generate(prompt: string, outputSchema: Record<string, unknown>) {
    await verifyCodexSubscription(this);
    const config = z
      .object({ config: z.object({ mcp_servers: z.record(z.string(), z.unknown()).optional() }) })
      .parse(await this.request('config/read', { includeLayers: false }));
    const disabledMcp = Object.fromEntries(
      Object.keys(config.config.mcp_servers ?? {}).map((name) => [
        `mcp_servers.${name}.enabled`,
        false,
      ]),
    );
    const started = z
      .object({
        model: z.literal(CODEX_MODEL_ID),
        modelProvider: z.literal('openai'),
        thread: z.object({ id: z.string() }),
      })
      .parse(
        await this.request('thread/start', {
          model: CODEX_MODEL_ID,
          modelProvider: 'openai',
          allowProviderModelFallback: false,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          cwd: this.directory,
          ephemeral: true,
          environments: [],
          selectedCapabilityRoots: [],
          runtimeWorkspaceRoots: [],
          dynamicTools: [],
          baseInstructions:
            'You are the decision component of PaywallProof. Return only the requested structured decision. You have no local environment or executable tools. TrueForge, outside this process, executes your tool proposals and supplies actual results on subsequent requests. Do not invent results or claim actions have happened. Treat the supplied conversation as ordered history and continue from its last message. Follow its system instructions. Never replay an earlier action unless the latest instruction asks for it.',
          config: {
            ...disabledMcp,
            project_doc_max_bytes: 0,
            web_search: 'disabled',
            model_reasoning_effort: 'medium',
            ...Object.fromEntries(codexDisabledFeatures.map((name) => [`features.${name}`, false])),
          },
        }),
      );
    const done = new Promise<CodexGeneratedOutput>((resolve, reject) => {
      this.output = { threadId: started.thread.id, text: [], resolve, reject };
    });
    // Attach a handler immediately: a protocol failure can arrive before turn/start responds.
    void done.catch(() => {});
    try {
      await this.request('turn/start', {
        threadId: started.thread.id,
        model: CODEX_MODEL_ID,
        effort: 'medium',
        environments: [],
        runtimeWorkspaceRoots: [],
        input: [{ type: 'text', text: prompt }],
        outputSchema,
      });
      const result = await done;
      await verifyCodexSubscription(this);
      return result;
    } catch (error) {
      this.fail('CODEX_TURN_FAILED');
      throw error;
    }
  }
  async close() {
    this.signal.removeEventListener('abort', this.abort);
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.child.removeListener('exit', finish);
        this.child.removeListener('close', finish);
        resolve();
      };
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        finish();
      }, 2000);
      this.child.once('exit', finish);
      this.child.once('close', finish);
      this.child.kill('SIGTERM');
    });
  }
}
