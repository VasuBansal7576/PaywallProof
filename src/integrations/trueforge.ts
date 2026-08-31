import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { z } from 'zod';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { boundedJson } from './model-protocol.ts';
import { CODEX_GATEWAY_ORIGIN, CODEX_MODEL_ID, CODEX_RUNTIME_MODEL } from './codex-subscription.ts';

export type RuntimeTurn = TrueForgeApi.Turn;
export type RuntimeEvent = TrueForgeApi.TurnStreamingEvent;
export type RuntimeApprovalDecision = Pick<
  TrueForgeApi.UserToolApprovalEvent,
  'threadId' | 'toolCallId' | 'approval'
>;
export type RuntimeApproval = {
  threadId: string;
  toolCallId: string;
  sourceEventId: string;
  tool: TrueForgeApi.ToolCall;
};
export type RuntimeCursor = { sessionId: string; turnId: string; afterSequenceNumber?: number };

/** Select by persisted creation time because SDK/server versions expose either pagination order. */
export async function newestTurn(
  turns: AsyncIterable<RuntimeTurn>,
): Promise<RuntimeTurn | undefined> {
  let newest: RuntimeTurn | undefined;
  for await (const turn of turns) {
    const createdAt = Date.parse(turn.createdAt);
    if (!Number.isFinite(createdAt)) throw new Error('Runtime turn has an invalid creation time.');
    if (!newest) {
      newest = turn;
      continue;
    }
    const newestCreatedAt = Date.parse(newest.createdAt);
    if (createdAt > newestCreatedAt || (createdAt === newestCreatedAt && turn.id > newest.id)) {
      newest = turn;
    }
  }
  return newest;
}

function localUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'The no-charge runtime requires a loopback HTTP URL without credentials or query parameters.',
    );
  }
  return url.toString().replace(/\/$/, '');
}

/** Local TrueForge with a model provider exposed only through a loopback gateway. */
export class TrueForgeAdapter {
  private readonly client: TrueForge;
  private readonly model: string;
  private readonly gatewayToken: string | undefined;

  constructor(
    options: {
      baseUrl?: string;
      model?: string;
      timeoutSeconds?: number;
      gatewayToken?: string;
    } = {},
  ) {
    this.model = options.model ?? CODEX_RUNTIME_MODEL;
    this.gatewayToken = options.gatewayToken;
    this.client = new TrueForge({
      baseUrl: localUrl(options.baseUrl ?? 'http://127.0.0.1:8790'),
      timeoutInSeconds: options.timeoutSeconds ?? 180,
      // Retrying a turn-creation POST after an ambiguous response can duplicate work.
      maxRetries: 0,
      stream: { reconnectionEnabled: true, maxReconnectionAttempts: 2 },
    });
  }

  private async capability() {
    const schema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);
    if (this.gatewayToken !== undefined) return schema.parse(this.gatewayToken);
    // TrueForge intentionally masks provider credentials in list responses.
    // Read only our separate local capability, never a provider/API credential.
    const directory = await lstat(resolve('.local'));
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0)
      throw new Error('Private model state required');
    const file = await open(
      resolve('.local', 'codex-model-gateway-token'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > 4096 ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.()
      )
        throw new Error('Private model capability required');
      return schema.parse((await file.readFile('utf8')).trim());
    } finally {
      await file.close();
    }
  }

  async registerMcpServer(options: {
    name: string;
    url: string;
    description: string;
    headers?: Record<string, string>;
  }) {
    return this.client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: 'remote',
        name: options.name,
        description: options.description,
        url: localUrl(options.url),
        ...(options.headers ? { auth: { type: 'header', headers: options.headers } } : {}),
      },
    });
  }

  async registerSkill(options: {
    name: string;
    description: string;
    repositoryUrl: string;
    ref: string;
    path?: string;
  }) {
    const name = z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
      .parse(options.name);
    const description = z.string().min(1).max(1024).parse(options.description);
    const ref = z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/\s/.test(value))
      .parse(options.ref);
    const path =
      options.path === undefined
        ? undefined
        : z
            .string()
            .min(1)
            .max(500)
            .refine((value) => {
              const parts = value.split('/');
              return (
                !value.startsWith('/') &&
                parts.every((part) => part && part !== '.' && part !== '..')
              );
            })
            .parse(options.path);
    const repositoryUrl = new URL(options.repositoryUrl);
    if (
      repositoryUrl.protocol !== 'https:' ||
      !['github.com', 'gitlab.com'].includes(repositoryUrl.hostname) ||
      repositoryUrl.username ||
      repositoryUrl.password ||
      repositoryUrl.search ||
      repositoryUrl.hash
    )
      throw new Error('A skill requires a public GitHub or GitLab HTTPS repository URL.');
    return this.client.settings.skills.createOrUpdate({
      manifest: {
        type: 'git',
        name,
        description,
        url: repositoryUrl.toString(),
        ref,
        ...(path === undefined ? {} : { path }),
      },
    });
  }

  private async localModel() {
    const { data: providers } = await this.client.settings.modelProviders.list();
    for (const provider of providers) {
      if (provider.manifest.type !== 'custom') continue;
      for (const model of provider.manifest.models) {
        if (`${provider.name}/${model.name}` !== this.model) continue;
        localUrl(provider.manifest.baseUrl);
        if (
          this.model === CODEX_RUNTIME_MODEL &&
          (provider.manifest.baseUrl !== `${CODEX_GATEWAY_ORIGIN}/v1` ||
            model.modelId !== CODEX_MODEL_ID)
        ) {
          throw new Error('Codex subscription inference requires the fixed local Luna bridge.');
        }
        if (/cloud/i.test(model.modelId))
          throw new Error('Cloud model IDs are disabled in the no-charge runtime.');
        if (this.model === CODEX_RUNTIME_MODEL) {
          try {
            const token = await this.capability();
            const signal = AbortSignal.timeout(30000);
            const response = await fetch(`${CODEX_GATEWAY_ORIGIN}/health`, {
              method: 'GET',
              redirect: 'error',
              signal,
              headers: { authorization: `Bearer ${token}` },
            });
            if (
              !response.ok ||
              !response.headers.get('content-type')?.startsWith('application/json')
            ) {
              await response.body?.cancel();
              throw new Error('Gateway health rejected');
            }
            const health = await boundedJson(response.body, 65536, signal);
            z.object({
              model: z.literal(CODEX_MODEL_ID),
              inference: z.literal('codex_subscription'),
              extraCredits: z.literal(0),
            }).parse(health);
          } catch {
            throw new Error(
              'The configured no-charge model gateway is unavailable or rejects its current account policy.',
            );
          }
        }
        return model;
      }
    }
    throw new Error('The configured runtime model must belong to a local custom provider.');
  }

  async checkConnection(): Promise<{
    model: string;
    local: true;
    inference?: 'codex_subscription';
  }> {
    await this.localModel();
    return {
      model: this.model,
      local: true,
      ...(this.model === CODEX_RUNTIME_MODEL ? { inference: 'codex_subscription' as const } : {}),
    };
  }

  async createSession(options: {
    instructions: string;
    mcpServerName?: string;
    enableTools?: string[];
    requireApprovalForTools?: string[];
    sandbox?: boolean;
    iterationLimit?: number;
    maxTokens?: number;
    skills?: string[];
    dynamicSubAgents?: boolean;
  }) {
    if (
      options.mcpServerName &&
      (!options.enableTools?.length || options.enableTools.some((name) => name.startsWith('@')))
    ) {
      throw new Error("A run's MCP server requires an explicit non-empty list of tool names.");
    }
    const configuredModel = await this.localModel();
    const { data } = await this.client.sessions.create({
      agent: {
        spec: {
          model: {
            name: this.model,
            params: {
              maxTokens: options.maxTokens ?? 2048,
              temperature: 0,
              ...(configuredModel.properties.reasoningEfforts?.includes('none')
                ? { reasoningEffort: 'none' }
                : {}),
            },
          },
          instructions: options.instructions,
          skills: options.skills?.map((name) => ({ name })) ?? [],
          mcpServers: options.mcpServerName
            ? [
                {
                  name: options.mcpServerName,
                  preload: true,
                  enableTools: options.enableTools ?? [],
                  requireApprovalForTools: options.requireApprovalForTools ?? [
                    'prepare_fixture',
                    'publish_repair_pr',
                  ],
                },
              ]
            : [],
          config: {
            sandbox: { enabled: options.sandbox ?? true },
            dynamicSubAgents: { enabled: options.dynamicSubAgents ?? false },
            generativeUi: { enabled: false },
            askUserQuestions: { enabled: false },
            iterationLimit: options.iterationLimit ?? 8,
          },
        },
      },
    });
    return data;
  }

  async beginTurn(options: { sessionId: string; input: string }) {
    const { data } = await this.client.sessions.createTurn(options.sessionId, {
      input: [{ type: 'user.message', content: options.input }],
    });
    return data;
  }

  async continueTurn(options: {
    sessionId: string;
    previousTurnId: string;
    input: string;
    beforeDispatch?: () => void;
  }) {
    const latest = await newestTurn(
      await this.client.sessions.listTurns(options.sessionId, { limit: 1 }),
    );
    if (
      !latest ||
      latest.id !== options.previousTurnId ||
      latest.state.status !== 'done' ||
      latest.state.requiredActions.length
    )
      throw new Error(
        'Runtime continuation requires the latest completed turn without pending approvals.',
      );
    options.beforeDispatch?.();
    const { data } = await this.client.sessions.createTurn(options.sessionId, {
      previousTurnId: options.previousTurnId,
      input: [{ type: 'user.message', content: options.input }],
    });
    return data;
  }

  async inspectTurn(options: { sessionId: string; turnId: string }): Promise<RuntimeTurn> {
    const { data } = await this.client.sessions.getTurn(options.sessionId, options.turnId);
    return data;
  }
  async findContinuation(options: {
    sessionId: string;
    previousTurnId: string;
  }): Promise<RuntimeTurn | undefined> {
    const matching: RuntimeTurn[] = [];
    for await (const turn of await this.client.sessions.listTurns(options.sessionId, { limit: 1 }))
      if (turn.previousTurnId === options.previousTurnId) matching.push(turn);
    if (matching.length > 1)
      throw new Error('Ambiguous runtime continuation; do not dispatch again.');
    return matching[0];
  }

  async listTurnEvents(options: { sessionId: string; turnId: string }) {
    const events: TrueForgeApi.SessionEvent[] = [];
    for await (const event of await this.client.sessions.listTurnEvents(
      options.sessionId,
      options.turnId,
    ))
      events.push(event);
    return events;
  }

  async inspectApprovals(options: {
    sessionId: string;
    turnId: string;
  }): Promise<RuntimeApproval[]> {
    const turn = await this.inspectTurn(options);
    if (turn.state.status !== 'done') return [];
    const pending = turn.state.requiredActions.filter(
      (action) => action.type === 'tool.approval_required',
    );
    if (pending.length === 0) return [];
    const events = new Map((await this.listTurnEvents(options)).map((event) => [event.id, event]));
    return pending.flatMap((action) =>
      action.toolCalls.map((ref) => {
        const source = events.get(ref.sourceEventId);
        const tool =
          source?.type === 'model.message'
            ? source.toolCalls?.find((call) => call.id === ref.id)
            : undefined;
        if (!tool) throw new Error('Pending runtime approval has no matching persisted tool call.');
        return {
          threadId: action.threadId,
          toolCallId: ref.id,
          sourceEventId: ref.sourceEventId,
          tool,
        };
      }),
    );
  }

  async continueApproval(options: {
    sessionId: string;
    turnId: string;
    decisions: RuntimeApprovalDecision[];
    beforeDispatch?: () => void;
  }) {
    const latest = await newestTurn(
      await this.client.sessions.listTurns(options.sessionId, { limit: 1 }),
    );
    if (latest?.id !== options.turnId)
      throw new Error('Cannot continue an approval from a superseded runtime turn.');
    const pending = await this.inspectApprovals(options);
    const key = (value: { threadId: string; toolCallId: string }) =>
      JSON.stringify([value.threadId, value.toolCallId]);
    const expected = new Set(pending.map(key));
    const actual = new Set(options.decisions.map(key));
    if (
      expected.size === 0 ||
      actual.size !== options.decisions.length ||
      actual.size !== expected.size ||
      [...actual].some((id) => !expected.has(id))
    ) {
      throw new Error(
        'Approval decisions must match every pending runtime tool call exactly once.',
      );
    }
    const input: TrueForgeApi.UserToolApprovalEvent[] = options.decisions.map((decision) => ({
      type: 'user.tool_approval',
      ...decision,
    }));
    options.beforeDispatch?.();
    const { data } = await this.client.sessions.createTurn(options.sessionId, {
      previousTurnId: options.turnId,
      input,
    });
    return data;
  }

  /** Reattaches to this turn. It never creates a turn or resends the user's input. */
  async resumeStream(options: RuntimeCursor & { signal?: AbortSignal }) {
    if (
      options.afterSequenceNumber !== undefined &&
      (!Number.isSafeInteger(options.afterSequenceNumber) || options.afterSequenceNumber < 0)
    ) {
      throw new Error('A runtime stream cursor must be a non-negative safe integer.');
    }
    return this.client.sessions.subscribeToTurn(
      options.sessionId,
      options.turnId,
      { afterSequenceNumber: options.afterSequenceNumber },
      { abortSignal: options.signal },
    );
  }

  async cancel(options: { sessionId: string }) {
    return this.client.sessions.cancel(options.sessionId);
  }
}
