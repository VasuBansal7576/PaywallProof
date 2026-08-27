import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { TrueForgeAdapter, type RuntimeTurn } from "../packages/adapters/src/trueforge.ts";

const resultSchema = z.object({ success: z.literal(true), response: z.object({ exitCode: z.literal(0), result: z.string() }) });
const baseUrl = process.env.TRUEFORGE_BASE_URL ?? "http://127.0.0.1:8790";
const model = process.env.TRUEFORGE_MODEL ?? "paywallproof-local/qwen3-4b-nothink";
let adapter: TrueForgeAdapter | undefined;
const startedAt = new Date().toISOString();
const evidence: {
  schemaVersion: 2; scope: "runtime-installation-only";
  startedAt: string; finishedAt?: string; baseUrl: string; model: string;
  status: "running" | "passed" | "failed"; sessionId?: string; turnId?: string;
  sandboxCreated: boolean; execResults: { toolCallId: string; content: string; expectedResult: boolean }[];
  terminalStatus?: RuntimeTurn["state"]["status"]; lastSequenceNumber: number; reconnected: boolean;
  eventCounts: Record<string, number>; error?: string;
  approvalTransport?: { scope: "runtime-installation-probe-only"; allowedCalls: number; deniedCalls: number; staleApprovalRejected: boolean };
} = { schemaVersion: 2, scope: "runtime-installation-only", startedAt, baseUrl, model, status: "running", sandboxCreated: false, execResults: [], lastSequenceNumber: 0, reconnected: false, eventCounts: {} };

async function verifyApprovalTransport(runtime: TrueForgeAdapter) {
  const calls = { prepare_fixture: 0, publish_repair_pr: 0 };
  const server = createServer((request, response) => {
    const handle = async () => {
      if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
      const mcp = new McpServer({ name: "paywallproof-runtime-installation-probe", version: "1.0.0" });
      for (const name of ["prepare_fixture", "publish_repair_pr"] satisfies (keyof typeof calls)[]) {
        mcp.registerTool(name, {
          description: "Harmless runtime installation probe. Increments an in-memory counter only. No Stripe, files, or pull requests.",
          inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        }, async () => {
          calls[name] += 1;
          return { content: [{ type: "text", text: JSON.stringify({ scope: "runtime-installation-probe-only", count: calls[name] }) }] };
        });
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    };
    void handle().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let sessionId: string | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Runtime probe could not obtain its loopback port.");
    const name = "paywallproof-runtime-installation-probe";
    await runtime.registerMcpServer({ name, url: `http://127.0.0.1:${address.port}/mcp`, description: "Temporary harmless runtime approval transport probe, not product acceptance." });
    const session = await runtime.createSession({ sandbox: false, mcpServerName: name,
      enableTools: ["prepare_fixture", "publish_repair_pr"], requireApprovalForTools: ["prepare_fixture", "publish_repair_pr"],
      maxTokens: 2048, iterationLimit: 3,
      instructions: "Call the exact tool requested by the user once with empty arguments. These are harmless runtime installation counters. After tool success or denial, reply only done. Do not ask questions, explain, or retry a denied call.",
    });
    sessionId = session.id;
    const wait = async (turn: RuntimeTurn) => {
      const stream = await runtime.resumeStream({ sessionId: session.id, turnId: turn.id, signal: AbortSignal.timeout(120_000) });
      for await (const event of stream) { if (event.type === "turn.done" && event.state.status === "error") throw new Error(event.state.message); }
      return runtime.inspectTurn({ sessionId: session.id, turnId: turn.id });
    };
    const gated = await wait(await runtime.beginTurn({ sessionId: session.id, input: "Call prepare_fixture once with empty arguments." }));
    const approvals = await runtime.inspectApprovals({ sessionId: session.id, turnId: gated.id });
    const approval = approvals[0];
    if (approvals.length !== 1 || !approval || approval.tool.toolInfo.name !== "prepare_fixture" || calls.prepare_fixture !== 0) {
      throw new Error("Runtime did not gate the harmless prepare_fixture probe before execution.");
    }
    const decision = { threadId: approval.threadId, toolCallId: approval.toolCallId, approval: { status: "allow" } } satisfies Parameters<TrueForgeAdapter["continueApproval"]>[0]["decisions"][number];
    const resumed = await wait(await runtime.continueApproval({ sessionId: session.id, turnId: gated.id, decisions: [decision] }));
    if (resumed.state.status !== "done" || resumed.state.requiredActions.length || Number(calls.prepare_fixture) !== 1) throw new Error("Approved installation probe did not execute exactly once.");
    let staleApprovalRejected = false;
    try { await runtime.continueApproval({ sessionId: session.id, turnId: gated.id, decisions: [decision] }); }
    catch (error) { staleApprovalRejected = error instanceof Error && error.message === "Cannot continue an approval from a superseded runtime turn."; }
    if (!staleApprovalRejected) throw new Error("A stale runtime approval was accepted.");
    const deniedGate = await wait(await runtime.beginTurn({ sessionId: session.id, input: "Call publish_repair_pr once with empty arguments." }));
    const deniedApprovals = await runtime.inspectApprovals({ sessionId: session.id, turnId: deniedGate.id });
    const denied = deniedApprovals[0];
    if (deniedApprovals.length !== 1 || !denied || denied.tool.toolInfo.name !== "publish_repair_pr") throw new Error("Runtime did not gate the harmless publish probe.");
    const deniedResult = await wait(await runtime.continueApproval({ sessionId: session.id, turnId: deniedGate.id,
      decisions: [{ threadId: denied.threadId, toolCallId: denied.toolCallId, approval: { status: "deny", reason: "Installation probe deliberately denied." } }],
    }));
    if (deniedResult.state.status !== "done" || deniedResult.state.requiredActions.length || calls.publish_repair_pr !== 0) {
      throw new Error("Denied installation probe executed or failed to finish.");
    }
    return { scope: "runtime-installation-probe-only", allowedCalls: calls.prepare_fixture, deniedCalls: calls.publish_repair_pr, staleApprovalRejected } satisfies NonNullable<typeof evidence.approvalTransport>;
  } finally {
    if (sessionId) { try { await runtime.cancel({ sessionId }); } catch { /* Preserve the original probe error. */ } }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

try {
  adapter = new TrueForgeAdapter({ baseUrl, model, timeoutSeconds: 180 });
  const session = await adapter.createSession({
    instructions: "You verify code execution. Immediately call the exec tool with command python -c 'print(6 * 7)'. Do not answer from memory. After the tool succeeds, reply only with its numeric output. Do not call any other tools or inspect files.",
    sandbox: true, iterationLimit: 3, maxTokens: 2048,
  });
  evidence.sessionId = session.id;
  const turn = await adapter.beginTurn({ sessionId: session.id, input: "Execute python -c 'print(6 * 7)' with exec now, then return the result." });
  evidence.turnId = turn.id;
  // Disconnect only the subscriber, then resume the same turn from its last cursor.
  const firstConnection = new AbortController();
  const firstStream = await adapter.resumeStream({ sessionId: session.id, turnId: turn.id, signal: firstConnection.signal });
  try {
    for await (const { id } of firstStream.withMetadata()) {
      if (id === undefined) continue;
      evidence.lastSequenceNumber = z.coerce.number().int().nonnegative().parse(id);
      firstConnection.abort();
      break;
    }
  } catch (error) {
    if (!firstConnection.signal.aborted) throw error;
  }
  const stream = await adapter.resumeStream({ sessionId: session.id, turnId: turn.id,
    afterSequenceNumber: evidence.lastSequenceNumber, signal: AbortSignal.timeout(180_000) });
  evidence.reconnected = true;
  for await (const { data: event, id } of stream.withMetadata()) {
    evidence.eventCounts[event.type] = (evidence.eventCounts[event.type] ?? 0) + 1;
    if (id !== undefined) evidence.lastSequenceNumber = z.coerce.number().int().nonnegative().parse(id);
    if (event.type === "sandbox.created") evidence.sandboxCreated = true;
  }
  const completed = await adapter.inspectTurn({ sessionId: session.id, turnId: turn.id });
  evidence.terminalStatus = completed.state.status;
  const events = await adapter.listTurnEvents({ sessionId: session.id, turnId: turn.id });
  const execIds = new Set(events.flatMap((event) => event.type === "model.message"
    ? (event.toolCalls ?? []).filter((tool) => tool.toolInfo.type === "truefoundry-system" && tool.toolInfo.name === "exec").map((tool) => tool.id)
    : []));
  for (const event of events) {
    if (event.type !== "tool.response" || !execIds.has(event.toolCallId)) continue;
    let expectedResult = false;
    try {
      const parsed = resultSchema.safeParse(JSON.parse(event.content));
      expectedResult = parsed.success && parsed.data.response.result.trim() === "42";
    } catch { /* A textual error is evidence of failure, never successful execution. */ }
    evidence.execResults.push({ toolCallId: event.toolCallId, content: event.content.slice(0,4000), expectedResult });
  }
  if (completed.state.status === "error") throw new Error(completed.state.message);
  if (completed.state.status !== "done" || completed.state.requiredActions.length !== 0) throw new Error("Runtime did not complete without pending actions.");
  if (!evidence.sandboxCreated) throw new Error("No actual sandbox.created event was observed.");
  if (!evidence.execResults.some((result) => result.expectedResult)) throw new Error("No successful exec tool result produced 42.");
  evidence.approvalTransport = await verifyApprovalTransport(adapter);
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = error instanceof Error ? error.message.slice(0,4000) : "Unknown runtime verification error";
  if (evidence.sessionId && adapter) {
    try { await adapter.cancel({ sessionId: evidence.sessionId }); }
    catch { evidence.error += " Cancellation request also failed."; }
  }
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  const directory = resolve(".local");
  await mkdir(directory, { recursive: true });
  const serialized = JSON.stringify(evidence, null, 2) + "\n";
  await writeFile(resolve(directory, "runtime-verification.json"), serialized, { mode: 0o600 });
  await writeFile(resolve(directory, `runtime-verification-${startedAt.replace(/[:.]/g,"-")}.json`), serialized, { mode: 0o600 });
  process.stdout.write(serialized);
}
