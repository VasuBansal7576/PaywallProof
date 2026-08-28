import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { FREE_GATEWAY_ORIGIN, FREE_MODEL_ID, FREE_RUNTIME_MODEL } from './free-model.ts';

export type RuntimeTurn = TrueForgeApi.Turn;
export type RuntimeEvent = TrueForgeApi.TurnStreamingEvent;
export type RuntimeApprovalDecision = Pick<TrueForgeApi.UserToolApprovalEvent, "threadId" | "toolCallId" | "approval">;
export type RuntimeApproval = {
  threadId: string;
  toolCallId: string;
  sourceEventId: string;
  tool: TrueForgeApi.ToolCall;
};
export type RuntimeCursor = { sessionId: string; turnId: string; afterSequenceNumber?: number };

function localUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error("The no-charge runtime requires a loopback HTTP URL without credentials or query parameters.");
  }
  return url.toString().replace(/\/$/, "");
}

/** Local TrueForge only. Remote free inference goes through the policy gateway. */
export class TrueForgeAdapter {
  private readonly client: TrueForge;
  private readonly model: string;

  constructor(options: { baseUrl?: string; model?: string; timeoutSeconds?: number } = {}) {
    this.model = options.model ?? "paywallproof-local/qwen3-4b-instruct";
    this.client = new TrueForge({
      baseUrl: localUrl(options.baseUrl ?? "http://127.0.0.1:8790"),
      timeoutInSeconds: options.timeoutSeconds ?? 180,
      // Retrying a turn-creation POST after an ambiguous response can duplicate work.
      maxRetries: 0,
      stream: { reconnectionEnabled: true, maxReconnectionAttempts: 2 },
    });
  }

  async registerMcpServer(options: { name: string; url: string; description: string; headers?: Record<string, string> }) {
    return this.client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: "remote", name: options.name, description: options.description, url: localUrl(options.url),
        ...(options.headers ? { auth: { type: "header", headers: options.headers } } : {}),
      },
    });
  }

  private async localModel() {
    const { data: providers } = await this.client.settings.modelProviders.list();
    for (const provider of providers) {
      if (provider.manifest.type !== "custom") continue;
      for (const model of provider.manifest.models) {
        if (`${provider.name}/${model.name}` !== this.model) continue;
        localUrl(provider.manifest.baseUrl);
        if (this.model === FREE_RUNTIME_MODEL && (provider.manifest.baseUrl !== `${FREE_GATEWAY_ORIGIN}/v1` || model.modelId !== FREE_MODEL_ID)) {
          throw new Error('The free hosted model requires the fixed zero-price policy gateway.');
        }
        if (/cloud/i.test(model.modelId)) throw new Error("Cloud model IDs are disabled in the no-charge runtime.");
        return model;
      }
    }
    throw new Error("The configured runtime model must belong to a local custom provider.");
  }

  async checkConnection(): Promise<{ model: string; local: true; inference?: 'free_hosted' }> {
    await this.localModel();
    return { model: this.model, local: true, ...(this.model === FREE_RUNTIME_MODEL ? { inference: 'free_hosted' as const } : {}) };
  }

  async createSession(options: {
    instructions: string;
    mcpServerName?: string;
    enableTools?: string[];
    requireApprovalForTools?: string[];
    sandbox?: boolean;
    iterationLimit?: number;
    maxTokens?: number;
  }) {
    if (options.mcpServerName && (!options.enableTools?.length || options.enableTools.some((name) => name.startsWith("@")))) {
      throw new Error("A run's MCP server requires an explicit non-empty list of tool names.");
    }
    const configuredModel = await this.localModel();
    const { data } = await this.client.sessions.create({
      agent: { spec: {
        model: { name: this.model, params: {
          maxTokens: options.maxTokens ?? 2048, temperature: 0,
          ...(configuredModel.properties.reasoningEfforts?.includes("none") ? { reasoningEffort: "none" } : {}),
        } },
        instructions: options.instructions,
        mcpServers: options.mcpServerName ? [{
          name: options.mcpServerName,
          preload: true,
          enableTools: options.enableTools ?? [],
          requireApprovalForTools: options.requireApprovalForTools ?? ["prepare_fixture", "publish_repair_pr"],
        }] : [],
        config: {
          sandbox: { enabled: options.sandbox ?? true },
          dynamicSubAgents: { enabled: false },
          generativeUi: { enabled: false },
          askUserQuestions: { enabled: false },
          iterationLimit: options.iterationLimit ?? 8,
        },
      } },
    });
    return data;
  }

  async beginTurn(options: { sessionId: string; input: string }) {
    const { data } = await this.client.sessions.createTurn(options.sessionId, {
      input: [{ type: "user.message", content: options.input }],
    });
    return data;
  }

  async continueTurn(options:{sessionId:string;previousTurnId:string;input:string}) {
    let latest:RuntimeTurn|undefined;
    for await(const turn of await this.client.sessions.listTurns(options.sessionId,{limit:1}))latest=turn;
    if(!latest||latest.id!==options.previousTurnId||latest.state.status!=='done'||latest.state.requiredActions.length)throw new Error('Runtime continuation requires the latest completed turn without pending approvals.');
    const {data}=await this.client.sessions.createTurn(options.sessionId,{previousTurnId:options.previousTurnId,input:[{type:'user.message',content:options.input}]});
    return data;
  }

  async inspectTurn(options: { sessionId: string; turnId: string }): Promise<RuntimeTurn> {
    const { data } = await this.client.sessions.getTurn(options.sessionId, options.turnId);
    return data;
  }
  async findContinuation(options:{sessionId:string;previousTurnId:string}):Promise<RuntimeTurn|undefined> {
    const matching:RuntimeTurn[]=[];
    for await(const turn of await this.client.sessions.listTurns(options.sessionId,{limit:1}))if(turn.previousTurnId===options.previousTurnId)matching.push(turn);
    if(matching.length>1)throw new Error('Ambiguous runtime continuation; do not dispatch again.');
    return matching[0];
  }

  async listTurnEvents(options: { sessionId: string; turnId: string }) {
    const events: TrueForgeApi.SessionEvent[] = [];
    for await (const event of await this.client.sessions.listTurnEvents(options.sessionId, options.turnId)) events.push(event);
    return events;
  }

  async inspectApprovals(options: { sessionId: string; turnId: string }): Promise<RuntimeApproval[]> {
    const turn = await this.inspectTurn(options);
    if (turn.state.status !== "done") return [];
    const pending = turn.state.requiredActions.filter((action) => action.type === "tool.approval_required");
    if (pending.length === 0) return [];
    const events = new Map((await this.listTurnEvents(options)).map((event) => [event.id, event]));
    return pending.flatMap((action) => action.toolCalls.map((ref) => {
      const source = events.get(ref.sourceEventId);
      const tool = source?.type === "model.message" ? source.toolCalls?.find((call) => call.id === ref.id) : undefined;
      if (!tool) throw new Error("Pending runtime approval has no matching persisted tool call.");
      return { threadId: action.threadId, toolCallId: ref.id, sourceEventId: ref.sourceEventId, tool };
    }));
  }

  async continueApproval(options: { sessionId: string; turnId: string; decisions: RuntimeApprovalDecision[] }) {
    let latest: RuntimeTurn | undefined;
    for await (const turn of await this.client.sessions.listTurns(options.sessionId,{limit:1})) latest = turn;
    if (latest?.id !== options.turnId) throw new Error("Cannot continue an approval from a superseded runtime turn.");
    const pending = await this.inspectApprovals(options);
    const key = (value: { threadId: string; toolCallId: string }) => JSON.stringify([value.threadId, value.toolCallId]);
    const expected = new Set(pending.map(key));
    const actual = new Set(options.decisions.map(key));
    if (expected.size === 0 || actual.size !== options.decisions.length || actual.size !== expected.size
      || [...actual].some((id) => !expected.has(id))) {
      throw new Error("Approval decisions must match every pending runtime tool call exactly once.");
    }
    const input: TrueForgeApi.UserToolApprovalEvent[] = options.decisions.map((decision) => ({ type: "user.tool_approval", ...decision }));
    const { data } = await this.client.sessions.createTurn(options.sessionId, { previousTurnId: options.turnId, input });
    return data;
  }

  /** Reattaches to this turn. It never creates a turn or resends the user's input. */
  async resumeStream(options: RuntimeCursor & { signal?: AbortSignal }) {
    if (options.afterSequenceNumber !== undefined
      && (!Number.isSafeInteger(options.afterSequenceNumber) || options.afterSequenceNumber < 0)) {
      throw new Error("A runtime stream cursor must be a non-negative safe integer.");
    }
    return this.client.sessions.subscribeToTurn(options.sessionId, options.turnId,
      { afterSequenceNumber: options.afterSequenceNumber }, { abortSignal: options.signal });
  }

  async cancel(options: { sessionId: string }) {
    return this.client.sessions.cancel(options.sessionId);
  }
}
