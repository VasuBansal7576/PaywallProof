import { createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { z } from 'zod';
import { TrueForgeAdapter } from '../../adapters/src/trueforge.ts';
import { pathSchema, RepairError } from './model.ts';
import { REFERENCE_SUPPORT_PATHS } from './checkout.ts';
import { assertRepairDestinationCapacity, assertRepairDiskCapacity } from './capacity.ts';

const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_HTTP_BYTES = 4 * 1024 * 1024;
const MAX_STATIC_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 20_000;
const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}$/);
const commandSchema = z.strictObject({ interpreter: z.enum(['node', 'python']), script: z.string(), args: z.array(z.string().max(2000).refine(s => !s.includes('\0'))).max(50).optional() });
const routeSchema = z.strictObject({ method: z.enum(['GET', 'POST', 'DELETE']), path: z.string().min(1).max(1000).regex(/^\/[A-Za-z0-9_./-]*(?:\?runId=[A-Za-z0-9_-]{1,150})?$/).refine(s => !s.includes('..') && !s.includes('//')) });
export type FixedSandboxCommand = z.infer<typeof commandSchema>;
export type SandboxFile = { path: string; bytes: Uint8Array; role: 'source' | 'support' | 'dependency' | 'launcher' };
export type SandboxBinding = { path: string; sha256: string; size: number };
export type SandboxRuntimeState = { sessionId: string; operationId: string; phase: 'transfer' | 'execute' | 'prepare'; turnId: string | null; previousTurnId: string };
export type SandboxExecReceipt = { sessionId: string; turnId: string; toolCallId: string; eventId: string; command: string; exitCode: number; output: string };
export type SandboxTargetReady = { origin: string; adapterToken: string; replaySecret: string; webhookSecret: string; registerRoutes: (routes: z.infer<typeof routeSchema>[]) => void };
export type SandboxTarget = { routes: z.infer<typeof routeSchema>[]; allowNextStatic?: boolean; onReady: (target: SandboxTargetReady) => Promise<unknown> };
export type SandboxOperationInput = {
  sessionId: string; previousTurnId: string; files: SandboxFile[]; allowedPaths: string[];
  signal?: AbortSignal; onState?: (state: SandboxRuntimeState) => Promise<void>;
};
export type SandboxRunInput = SandboxOperationInput & { fixedCommand: FixedSandboxCommand; setupCommands?: FixedSandboxCommand[]; target?: SandboxTarget };
export type SandboxPrepareInput = SandboxOperationInput & { instructions: string };
export type SandboxResult = {
  sessionId: string; operationId: string; workspace: string; turnIds: string[]; lastTurnId: string;
  transferArchiveHash: string;
  baselineBindings: SandboxBinding[]; candidateBindings: SandboxBinding[];
  files: { path: string; bytes: Uint8Array }[]; execReceipts: SandboxExecReceipt[]; observation: unknown;
};
export class SandboxRunError extends Error {
  constructor(readonly code: string, readonly runtime: { sessionId: string; operationId: string; turnIds: string[]; execReceipts: SandboxExecReceipt[] }, cause?: unknown) { super(code, { cause }); }
}
type Operation = { input: SandboxOperationInput; id: string; workspace: string; previous: string; turns: string[]; receipts: SandboxExecReceipt[]; files: SandboxFile[]; signal: AbortSignal; redactions: string[]; dispatched: boolean; archiveHash: string; commandTimeoutMs: number; root?: string };
type Chunk = { name: string; bytes: Buffer; hash: string };
type PackedFiles = { chunks: Chunk[]; bundleHash: string; size: number; manifest: { path: string; hash: string; size: number; offset: number }[] };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const binding = (path: string, bytes: Uint8Array): SandboxBinding => ({ path, sha256: hash(bytes), size: bytes.byteLength });
function fail(operation: Operation, code: string, cause?: unknown): never { throw new SandboxRunError(code, { sessionId: operation.input.sessionId, operationId: operation.id, turnIds: [...operation.turns], execReceipts: [...operation.receipts] }, cause); }
function localUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('LOCAL_RUNTIME_REQUIRED');
  return url.toString().replace(/\/$/, '');
}
function safeTransferPath(path: string) {
  if (typeof path !== 'string' || !path.length || path.length > 500 || path.startsWith('/') || /[\\:*?<>|]/.test(path) || [...path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return false;
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.trim() !== p) || parts[0] === '.receipt') return false;
  return !parts.some(p => /^\.env/i.test(p) || ['.git', '.github', '.codex', '.agents', '.npmrc', '.yarnrc', 'tests', '__tests__', 'oracle', 'oracles'].includes(p.toLowerCase()))
    && !/\.(test|spec)\.[^/]+$/i.test(path) && !/(^|\/)(id_rsa|id_ed25519|credentials)(\.|$)/i.test(path);
}
function checkedFiles(input: SandboxOperationInput): SandboxFile[] {
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > MAX_FILES || !Array.isArray(input.allowedPaths) || !input.allowedPaths.length || input.allowedPaths.some(p => !pathSchema.safeParse(p).success)) throw new Error('SANDBOX_FILES_REJECTED');
  const seen = new Set<string>(); let total = 0;
  const files = input.files.map(file => {
    if (!safeTransferPath(file.path) || !(file.bytes instanceof Uint8Array) || !['source', 'support', 'dependency', 'launcher'].includes(file.role)) throw new Error('SANDBOX_FILES_REJECTED');
    if (file.role === 'support' && (!REFERENCE_SUPPORT_PATHS.includes(file.path) || input.allowedPaths.includes(file.path))) throw new Error('SANDBOX_SUPPORT_REJECTED');
    if (REFERENCE_SUPPORT_PATHS.includes(file.path) && file.role !== 'support') throw new Error('SANDBOX_SUPPORT_REJECTED');
    if (file.role === 'source' && (!input.allowedPaths.includes(file.path) || !pathSchema.safeParse(file.path).success)) throw new Error('SANDBOX_SOURCE_REJECTED');
    if (file.role === 'dependency' && !file.path.startsWith('node_modules/')) throw new Error('SANDBOX_DEPENDENCY_REJECTED');
    if (file.role === 'launcher' && !file.path.startsWith('_trusted/')) throw new Error('SANDBOX_LAUNCHER_REJECTED');
    const lower = file.path.toLowerCase();
    if (seen.has(lower)) throw new Error('SANDBOX_FILES_REJECTED');
    seen.add(lower); total += file.bytes.byteLength;
    if (total > MAX_BYTES || file.role === 'source' && file.bytes.byteLength > 1024 * 1024) throw new Error('SANDBOX_BYTES_EXCEEDED');
    const bytes = Buffer.from(file.bytes);
    if (/(?:polar_(?:oat|pat|cst)_[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(bytes.toString('latin1'))) throw new Error('SANDBOX_CREDENTIAL_REJECTED');
    return { path: file.path, bytes, role: file.role };
  });
  const names = [...seen].sort();
  for (let i = 1; i < names.length; i++) if (names[i]?.startsWith(`${names[i - 1]}/`)) throw new Error('SANDBOX_FILES_REJECTED');
  if (!files.some(f => f.role === 'source')) throw new Error('SANDBOX_SOURCE_REJECTED');
  return files;
}

/** Fixed source executed only in the sandbox. No host target code is imported. */
const SANDBOX_BRIDGE = String.raw`
const http = require('node:http');
const net = require('node:net');
exports.serve = async function serve(listener) {
  const server = http.createServer(listener);
  server.keepAliveTimeout = 1000;
  server.requestTimeout = 12000;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    let connected = false, stopped = false, everConnected = false;
    const duration = Number(process.env.PP_REPAIR_COMMAND_TIMEOUT_MS || '55000') - 3000;
    if (!Number.isInteger(duration) || duration < 1000 || duration > 417000) throw new Error('BRIDGE_DEADLINE_INVALID');
    const deadline = setTimeout(() => { stopped = true; socket.destroy(); reject(new Error('BRIDGE_DEADLINE')); }, duration);
    let socket;
    function connect() {
      socket = net.createConnection(process.env.PP_REPAIR_BRIDGE_SOCKET);
      socket.once('connect', () => {
        connected = true; everConnected = true;
        socket.write(process.env.PP_REPAIR_BRIDGE_TOKEN + '\n');
        server.emit('connection', socket);
      });
      socket.once('error', error => {
        // Rejecting one oversized HTTP response can reset this accepted stream.
        // Its close handler reconnects; that is not a host-shutdown signal.
        if (connected) return;
        stopped = true; clearTimeout(deadline);
        if (everConnected && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) resolve();
        else reject(new Error('BRIDGE_CONNECT_FAILED'));
      });
      socket.once('close', () => {
        if (stopped) return;
        if (!connected) { stopped = true; clearTimeout(deadline); resolve(); return; }
        connected = false;
        // A closed host listener terminates the foreground target. No daemon remains.
        setTimeout(connect, 5).unref();
      });
    }
    connect();
  });
};
`;

/** Builtins-only host child. It listens; it never dials a filesystem socket. */
const HOST_BRIDGE = String.raw`
const net = require('node:net'), http = require('node:http'), crypto = require('node:crypto');
const sockets = new Set(); let available = [], pending = [], busy = false, ready = false;
const token = Buffer.from(process.env.PP_TOKEN);
function send(value) { if (process.connected) process.send(value); }
function pump() {
  if (busy || !available.length || !pending.length) return;
  busy = true;
  const socket = available.shift(), message = pending.shift();
  const limit = message.maximumBytes === 16777216 ? 16777216 : 4194304;
  const agent = new http.Agent({ keepAlive: false }); agent.createConnection = () => socket;
  let finished = false;
  function done(value) { if (finished) return; finished = true; busy = false; agent.destroy(); socket.destroy(); send({ kind:'response', id:message.id, ...value }); pump(); }
  const request = http.request({ host:'sandbox.invalid', method:message.method, path:message.path,
    headers:{...message.headers,host:'sandbox.invalid',connection:'close'},agent,timeout:12000 }, response => {
    const chunks = []; let bytes = 0;
    response.on('data', chunk => { bytes += chunk.length; if (bytes > limit) { response.destroy(); done({error:'RESPONSE_TOO_LARGE'}); } else chunks.push(chunk); });
    response.once('end', () => done({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('base64')}));
    response.once('error', () => done({error:'RESPONSE_FAILED'}));
  });
  request.once('timeout', () => request.destroy()); request.once('error', () => done({error:'REQUEST_FAILED'}));
  request.end(Buffer.from(message.body,'base64'));
  socket.resume();
}
const server = net.createServer(socket => {
  if (sockets.size >= 2) { socket.destroy(); return; }
  sockets.add(socket); socket.once('close', () => { sockets.delete(socket); available = available.filter(s => s !== socket); });
  let bytes = Buffer.alloc(0); const timer = setTimeout(() => socket.destroy(), 3000);
  function handshake(chunk) {
    bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 128) { socket.destroy(); return; }
    const newline = bytes.indexOf(10); if (newline < 0) return;
    const supplied = bytes.subarray(0,newline);
    if (supplied.length !== token.length || !crypto.timingSafeEqual(supplied,token) || newline !== bytes.length - 1) { socket.destroy(); return; }
    clearTimeout(timer); socket.off('data',handshake); socket.pause(); available.push(socket);
    if (!ready) { ready = true; send({kind:'ready'}); }
    pump();
  }
  socket.on('data',handshake); socket.once('error', () => {}); socket.once('close', () => clearTimeout(timer));
});
server.once('error', () => { send({kind:'failed'}); process.exitCode=1; });
server.listen(process.env.PP_SOCKET, () => send({kind:'listening'}));
process.on('message', message => { if (message.kind === 'request') { if (pending.length >= 32) send({kind:'response',id:message.id,error:'QUEUE_FULL'}); else { pending.push(message); pump(); } } else if (message.kind === 'close') { for (const socket of sockets) socket.destroy(); server.close(() => process.disconnect()); } });
process.once('disconnect', () => { for (const socket of sockets) socket.destroy(); server.close(); });
const lifetime = Number(process.env.PP_LIFETIME_MS || '235000');
if (!Number.isInteger(lifetime) || lifetime < 1000 || lifetime > 600000) throw new Error('HOST_DEADLINE_INVALID');
setTimeout(() => { for (const socket of sockets) socket.destroy(); server.close(); process.exit(1); }, lifetime).unref();
`;

const bridgeResponseSchema = z.object({ kind: z.literal('response'), id: z.string(), status: z.number().int().min(100).max(599).optional(), headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(), body: z.string().max(Math.ceil(MAX_STATIC_BYTES / 3) * 4).optional(), error: z.string().optional() });
type BridgeResponse = z.infer<typeof bridgeResponseSchema>;
export function safeRequestHeaders(headers: IncomingHttpHeaders, adapterToken: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['content-type', 'accept', 'cookie', 'paywallproof-replay-signature', 'authorization']) {
    const value = headers[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) throw new Error('BRIDGE_HEADERS_REJECTED');
    // The one fixed invalid token reaches the target for negative auth controls.
    // Other bearer credentials remain forbidden, including arbitrary host secrets.
    if (name === 'authorization' && value !== `Bearer ${adapterToken}` && value !== 'Bearer invalid_synthetic_token') throw new Error('BRIDGE_HEADERS_REJECTED');
    if (name === 'cookie' && !/^pp_session=[A-Za-z0-9._~-]{1,512}$/.test(value)) throw new Error('BRIDGE_HEADERS_REJECTED');
    out[name] = value;
  }
  return out;
}
function safeResponseHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = { 'cache-control': 'no-store' };
  for (const name of ['content-type', 'set-cookie', 'content-disposition']) {
    const value = headers[name]; if (value === undefined) continue;
    const values = typeof value === 'string' ? [value] : value;
    if (values.some(v => v.length > 4096 || /[\r\n]/.test(v))) throw new Error('BRIDGE_HEADERS_REJECTED');
    if (name === 'set-cookie' && values.some(v => !/^pp_session=[A-Za-z0-9._~-]{0,512}(;[^\r\n]*)?$/.test(v) || /;\s*domain=/i.test(v))) throw new Error('BRIDGE_HEADERS_REJECTED');
    out[name] = value;
  }
  return out;
}
type Bridge = { environment: Record<string, string>; observation: Promise<unknown>; close: () => Promise<void> };
export function isRepairStaticRequest(method: string | undefined, url: string | undefined): boolean {
  // The pinned Webpack development server adds a decimal cache-busting version.
  // Admit only that suffix, never arbitrary query data or normalized traversal.
  return method === 'GET' && typeof url === 'string'
    && /^\/_next\/static\/[A-Za-z0-9_./-]+(?:\?v=[0-9]{1,16})?$/.test(url)
    && !url.includes('..') && !url.includes('//');
}
async function openBridge(input: { root: string; workspace: string; operationId: string; target: SandboxTarget; nodeExecutable: string; signal: AbortSignal; commandTimeoutMs: number }): Promise<Bridge> {
  input.signal.throwIfAborted();
  const routes = z.array(routeSchema).min(1).max(5000).parse(input.target.routes);
  const registerRoutes = (additional: z.infer<typeof routeSchema>[]) => { const parsed = z.array(routeSchema).max(100).parse(additional); if (routes.length + parsed.length > 5000) throw new Error('BRIDGE_ROUTE_LIMIT'); routes.push(...parsed); };
  const credentials = { adapterToken: randomBytes(32).toString('hex'), replaySecret: randomBytes(32).toString('hex'), webhookSecret: randomBytes(32).toString('hex') };
  const token = randomBytes(32).toString('hex'), socketName = `b${input.operationId.slice(0,12)}`;
  const child = spawn(input.nodeExecutable, ['-e', HOST_BRIDGE], { cwd: input.root, env: { NODE_ENV: 'development', PATH: '/usr/bin:/bin', PP_SOCKET: socketName, PP_TOKEN: token, PP_LIFETIME_MS: String(input.commandTimeoutMs + 180_000) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const pending = new Map<string, { resolve: (response: BridgeResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const server = createServer(); let closed = false;
  let listeningResolve: () => void = () => {}, listeningReject: (error: Error) => void = () => {};
  const listening = new Promise<void>((res, rej) => { listeningResolve = res; listeningReject = rej; });
  let readyResolve: () => void = () => {}, readyReject: (error: Error) => void = () => {};
  const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });
  let failureReject: (error: Error) => void = () => {};
  const failure = new Promise<never>((_res, rej) => { failureReject = rej; });
  // These promises can fail before their consumer is attached.
  void ready.catch(() => {}); void listening.catch(() => {}); void failure.catch(() => {});
  const failBridge = () => {
    const error = new Error('SANDBOX_BRIDGE_FAILED'); listeningReject(error); readyReject(error); failureReject(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear();
  };
  child.once('error', failBridge); child.once('exit', () => { if (!closed) failBridge(); });
  child.on('message', (message: unknown) => {
    if (z.object({ kind: z.literal('listening') }).safeParse(message).success) listeningResolve();
    else if (z.object({ kind: z.literal('ready') }).safeParse(message).success) readyResolve();
    else {
      const result = bridgeResponseSchema.safeParse(message);
      if (!result.success) { failBridge(); return; }
      const item = pending.get(result.data.id); if (!item) return;
      pending.delete(result.data.id); clearTimeout(item.timer); item.resolve(result.data);
    }
  });
  const close = async () => {
    if (closed) return; closed = true; input.signal.removeEventListener('abort', abort); clearTimeout(timer);
    failBridge(); server.closeAllConnections(); if (server.listening) await new Promise<void>(res => server.close(() => res()));
    if (child.connected) child.send({ kind: 'close' });
    await stopChild(child);
  };
  const abort = () => { void close(); }; input.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { failBridge(); void close(); }, input.commandTimeoutMs + 180_000); timer.unref();
  try { await listening; } catch (error) { clearTimeout(timer); await close(); throw error; }
  server.on('request', async (request, response) => {
    try {
      const nextStatic = input.target.allowNextStatic && isRepairStaticRequest(request.method, request.url);
      if (!nextStatic && !routes.some(r => r.path === request.url && r.method === request.method) || request.headers.upgrade || request.headers['proxy-authorization']) throw new Error('BRIDGE_ROUTE_REJECTED');
      const maximumBytes = nextStatic && /\.(js|css)(?:\?v=[0-9]{1,16})?$/.test(request.url ?? '') ? MAX_STATIC_BYTES : MAX_HTTP_BYTES;
      const headers = safeRequestHeaders(request.headers, credentials.adapterToken), chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { if (!Buffer.isBuffer(chunk)) throw new Error('BRIDGE_BODY_REJECTED'); size += chunk.length; if (size > MAX_HTTP_BYTES) throw new Error('BRIDGE_BODY_REJECTED'); chunks.push(chunk); }
      const id = randomBytes(12).toString('hex');
      const result = await new Promise<BridgeResponse>((res, rej) => {
        const requestTimer = setTimeout(() => { pending.delete(id); rej(new Error('BRIDGE_REQUEST_DEADLINE')); }, 15_000);
        pending.set(id, { resolve: res, reject: rej, timer: requestTimer });
        if (!child.connected) { clearTimeout(requestTimer); pending.delete(id); rej(new Error('BRIDGE_CLOSED')); return; }
        child.send({ kind: 'request', id, method: request.method, path: request.url, headers, body: Buffer.concat(chunks).toString('base64'), maximumBytes });
      });
      if (result.error || result.status === undefined || result.body === undefined || result.status >= 300 && result.status < 400) throw new Error('BRIDGE_RESPONSE_REJECTED');
      response.writeHead(result.status, safeResponseHeaders(result.headers ?? {})); response.end(Buffer.from(result.body, 'base64'));
    } catch { if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end('{"error":"REPAIR_BRIDGE_REJECTED"}'); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 5000;
  server.on('upgrade', (_request, socket) => socket.destroy()); server.on('connect', (_request, socket) => socket.destroy());
  try { await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); }); }
  catch (error) { await close(); throw error; }
  const address = server.address(); if (!address || typeof address === 'string') { await close(); throw new Error('BRIDGE_LISTEN_FAILED'); }
  const observation = Promise.race([ready.then(() => input.target.onReady({ origin: `http://127.0.0.1:${address.port}`, ...credentials, registerRoutes })), failure]).finally(async () => { await close(); });
  void observation.catch(() => {});
  return { environment: { TARGET_ADAPTER_TOKEN: credentials.adapterToken, LOCAL_REPLAY_SECRET: credentials.replaySecret, POLAR_WEBHOOK_SECRET: credentials.webhookSecret, PP_REPAIR_COMMAND_TIMEOUT_MS: String(input.commandTimeoutMs), PP_REPAIR_BRIDGE_SOCKET: `../${socketName}`, PP_REPAIR_BRIDGE_TOKEN: token, PP_REPAIR_BRIDGE_MODULE: `../uploads/pp_${input.operationId}_bridge.cjs` }, observation, close };
}
async function stopChild(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(res => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 500); timer.unref();
    child.once('exit', () => { clearTimeout(timer); res(); });
    if (!child.connected) child.kill('SIGTERM');
  });
}

/** Uses only an existing locally configured TrueForge session; never retries a create POST. */
export class RepairSandboxRunner {
  private readonly client: TrueForge;
  private readonly runtime: TrueForgeAdapter;
  private readonly nodeExecutable: string;
  private readonly commandTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  constructor(options: { baseUrl?: string; model?: string; nodeExecutable?: string; commandTimeoutSeconds?: number; operationTimeoutSeconds?: number } = {}) {
    const baseUrl = localUrl(options.baseUrl ?? 'http://127.0.0.1:8790');
    this.commandTimeoutMs = z.number().int().min(5).max(420).parse(options.commandTimeoutSeconds ?? 55) * 1000;
    this.operationTimeoutMs = z.number().int().min(60).max(900).parse(options.operationTimeoutSeconds ?? 600) * 1000;
    if (this.commandTimeoutMs >= this.operationTimeoutMs) throw new Error('SANDBOX_TIMEOUT_REJECTED');
    this.client = new TrueForge({ baseUrl, maxRetries: 0, timeoutInSeconds: this.operationTimeoutMs / 1000, stream: { reconnectionEnabled: true, maxReconnectionAttempts: 2 } });
    this.runtime = new TrueForgeAdapter({ baseUrl, model: options.model, timeoutSeconds: this.operationTimeoutMs / 1000 });
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    if (!this.nodeExecutable.startsWith('/')) throw new Error('TRUSTED_NODE_PATH_REQUIRED');
  }
  async run(input: SandboxRunInput): Promise<SandboxResult> {
    const command = commandSchema.parse(input.fixedCommand);
    const setupCommands = z.array(commandSchema).max(3).parse(input.setupCommands ?? []);
    if (input.target) z.array(routeSchema).min(1).max(5000).parse(input.target.routes);
    return this.operation(input, async operation => {
      if ([command, ...setupCommands].some(c => !operation.files.some(f => f.path === c.script && f.role === 'launcher'))) fail(operation, 'TRUSTED_LAUNCHER_REQUIRED');
      let bridge: Bridge | undefined;
      try {
        const packed = await this.transfer(operation, input.target ? [{ name: `pp_${operation.id}_bridge.cjs`, bytes: Buffer.from(SANDBOX_BRIDGE), hash: hash(Buffer.from(SANDBOX_BRIDGE)) }] : []);
        for (const [index, setup] of setupCommands.entries()) {
          await this.execute(operation, `setup${index}`, this.bootstrap(operation, packed, setup, {}, index === 0));
          await this.result(operation, false, null);
        }
        if (input.target) bridge = await openBridge({ root: await this.sandboxRoot(operation), workspace: operation.workspace, operationId: operation.id, target: input.target, nodeExecutable: this.nodeExecutable, signal: operation.signal, commandTimeoutMs: operation.commandTimeoutMs });
        operation.redactions.push(...Object.entries(bridge?.environment ?? {}).filter(([key]) => /TOKEN|SECRET/.test(key)).map(([, value]) => value));
        await this.execute(operation, 'exec', this.bootstrap(operation, packed, command, bridge?.environment ?? {}, setupCommands.length === 0));
        const observation = bridge ? await bridge.observation : null;
        return await this.result(operation, false, observation);
      } finally { await bridge?.close(); }
    });
  }
  async prepare(input: SandboxPrepareInput): Promise<SandboxResult> {
    if (typeof input.instructions !== 'string' || !input.instructions.trim() || input.instructions.length > 20_000) throw new Error('REPAIR_INSTRUCTIONS_REJECTED');
    return this.operation(input, async operation => {
      const packed = await this.transfer(operation, []);
      await this.execute(operation, 'stage', this.bootstrap(operation, packed, null, {}, true));
      // Read bytes before exposing the candidate editing turn.
      await this.result(operation, false, null);
      await this.turn(operation, 'prepare', `The sanitized checkout is in ${operation.workspace}. Exec starts at the sandbox session root, NOT inside the checkout. Set cwd to ${JSON.stringify(operation.workspace)} on every inspection/edit exec call, or use these exact session-root-relative source paths: ${JSON.stringify(operation.files.filter(f => f.role === 'source').map(f => `${operation.workspace}/${f.path}`))}. Bare paths such as packages/ or apps/ do not exist at the session root. Inspect and edit the actual files in this checkout; a prose suggestion does not modify them. Never change dependencies, launchers, tests, oracle, auth settings, environment files or lockfiles. Never install dependencies or use network access. Your answer is a candidate, not a verified repair.\n\n${input.instructions}`, []);
      await this.execute(operation, 'snapshot', this.bootstrap(operation, packed, null, {}, false));
      return this.result(operation, true, null);
    });
  }
  private async operation(input: SandboxOperationInput, perform: (operation: Operation) => Promise<SandboxResult>) {
    idSchema.parse(input.sessionId); idSchema.parse(input.previousTurnId);
    const files = checkedFiles(input), id = randomBytes(12).toString('hex');
    const operation: Operation = { input, id, workspace: `pp_${id}`, previous: input.previousTurnId, turns: [], receipts: [], files, redactions: [], dispatched: false, archiveHash: '', commandTimeoutMs: this.commandTimeoutMs, signal: AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(this.operationTimeoutMs)]) };
    const cancel = () => { if (operation.dispatched) void this.runtime.cancel({ sessionId: input.sessionId }).catch(() => {}); };
    operation.signal.addEventListener('abort', cancel, { once: true });
    try {
      operation.signal.throwIfAborted();
      const configured = await this.runtime.checkConnection(), { data: session } = await this.client.sessions.get(input.sessionId);
      if (session.agent.type !== 'inline' || session.agent.spec.model?.name !== configured.model || session.agent.spec.config?.sandbox?.enabled !== true) fail(operation, 'LOCAL_SESSION_REQUIRED');
      await this.assertLatest(operation);
      // Recheck the actual runtime volume before each phase uploads anything.
      const payloadBytes = files.reduce((total, file) => total + BigInt(file.bytes.byteLength), 0n);
      await assertRepairDiskCapacity([await this.sandboxRoot(operation)], 3n * payloadBytes + 128n * 1024n ** 2n);
      return await perform(operation);
    } catch (error) {
      if (operation.dispatched) await this.runtime.cancel({ sessionId: input.sessionId }).catch(() => {});
      if (error instanceof SandboxRunError) throw error;
      if (error instanceof RepairError) fail(operation, error.code);
      fail(operation, operation.signal.aborted ? 'SANDBOX_CANCELLED' : 'SANDBOX_OPERATION_FAILED', error);
    } finally { operation.signal.removeEventListener('abort', cancel); }
  }
  private async assertLatest(operation: Operation) {
    let latest: TrueForgeApi.Turn | undefined;
    // Turn inputs contain base64 attachments. Keep each response to one turn;
    // a default page can otherwise repeat hundreds of MiB of prior uploads.
    for await (const turn of await this.client.sessions.listTurns(operation.input.sessionId, { limit: 1 })) latest = turn;
    if (!latest || latest.id !== operation.previous || latest.state.status !== 'done' || latest.state.requiredActions.length) fail(operation, 'RUNTIME_PREVIOUS_TURN_REJECTED');
  }
  private async turn(operation: Operation, phase: SandboxRuntimeState['phase'], text: string, chunks: Chunk[], expectedCommand?: string) {
    operation.signal.throwIfAborted(); await this.assertLatest(operation);
    const previous = operation.previous;
    const state = (turnId: string | null): SandboxRuntimeState => ({ sessionId: operation.input.sessionId, operationId: operation.id, phase, turnId, previousTurnId: previous });
    await operation.input.onState?.(state(null));
    operation.signal.throwIfAborted(); operation.dispatched = true;
    let turn: TrueForgeApi.Turn;
    try {
      const attachments: TrueForgeApi.FileContent[] = chunks.map(chunk => ({ type: 'file', name: chunk.name, data: `data:application/octet-stream;base64,${chunk.bytes.toString('base64')}` }));
      const response = await this.client.sessions.createTurn(operation.input.sessionId, { previousTurnId: previous, input: [{ type: 'user.message', content: [...attachments, { type: 'text', text }] }] }, { abortSignal: operation.signal });
      turn = response.data;
    } catch { fail(operation, 'RUNTIME_TURN_CREATION_UNKNOWN'); }
    operation.turns.push(turn.id); operation.previous = turn.id; await operation.input.onState?.(state(turn.id));
    const stream = await this.runtime.resumeStream({ sessionId: operation.input.sessionId, turnId: turn.id, signal: operation.signal });
    for await (const event of stream) { if (event.type === 'turn.done') operation.signal.throwIfAborted(); }
    const completed = await this.runtime.inspectTurn({ sessionId: operation.input.sessionId, turnId: turn.id });
    const events = await this.runtime.listTurnEvents({ sessionId: operation.input.sessionId, turnId: turn.id });
    this.receipts(operation, turn.id, events, phase, expectedCommand);
    if (completed.state.status !== 'done' || completed.state.requiredActions.length) fail(operation, 'RUNTIME_TURN_NOT_COMPLETED');
  }
  private receipts(operation: Operation, turnId: string, events: TrueForgeApi.SessionEvent[], phase: SandboxRuntimeState['phase'], expectedCommand?: string) {
    const calls = events.flatMap(e => e.type === 'model.message' ? e.toolCalls ?? [] : []);
    if (phase === 'transfer' && calls.length) fail(operation, 'UNEXPECTED_RUNTIME_TOOL');
    if (expectedCommand && calls.length !== 1) fail(operation, 'EXACT_EXEC_REQUIRED');
    for (const call of calls) {
      if (call.toolInfo.type !== 'truefoundry-system' || call.toolInfo.name !== 'exec') { if (expectedCommand) fail(operation, 'EXACT_EXEC_REQUIRED'); continue; }
      let args: unknown; try { args = JSON.parse(call.function.arguments); } catch { fail(operation, 'EXEC_ARGUMENTS_INVALID'); }
      const parsed = z.object({ command: z.string(), cwd: z.string().optional(), env: z.record(z.string(), z.string()).optional() }).safeParse(args);
      if (!parsed.success || expectedCommand && (parsed.data.command !== expectedCommand
        || parsed.data.cwd !== undefined && parsed.data.cwd !== '.'
        || parsed.data.env !== undefined && Object.keys(parsed.data.env).length !== 0)) fail(operation, 'EXACT_EXEC_REQUIRED');
      const response = events.find(e => e.type === 'tool.response' && e.toolCallId === call.id);
      if (!response || response.type !== 'tool.response') fail(operation, 'EXEC_RECEIPT_MISSING');
      let value: unknown; try { value = JSON.parse(response.content); } catch { fail(operation, 'EXEC_RECEIPT_INVALID'); }
      const result = z.object({ success: z.literal(true), response: z.object({ exitCode: z.number().int(), result: z.string() }) }).safeParse(value);
      if (!result.success) fail(operation, 'EXEC_RECEIPT_INVALID');
      let output = result.data.response.result.slice(0, 16_384);
      for (const secret of operation.redactions) output = output.replaceAll(secret, '[REDACTED]');
      output = output.replace(/(?:sk_(?:live|test)_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,})/g, '[REDACTED]');
      operation.receipts.push({ sessionId: operation.input.sessionId, turnId, toolCallId: call.id, eventId: response.id, command: parsed.data.command, exitCode: result.data.response.exitCode, output });
      if (expectedCommand && result.data.response.exitCode !== 0) fail(operation, 'SANDBOX_EXEC_FAILED');
    }
  }
  private async execute(operation: Operation, label: string, source: string) {
    const bytes = Buffer.from(source), attachment = { name: `pp_${operation.id}_${label}.cjs`, bytes, hash: hash(bytes) };
    await this.uploadChunks(operation, [attachment]);
    const exactCommand = `node uploads/${attachment.name}`;
    await this.turn(operation, 'execute', `Execute exactly one exec tool call with command ${JSON.stringify(exactCommand)}. Do not set cwd or env. Do not run any other tools or commands. When it returns, reply briefly.`, [], exactCommand);
    const readback = await this.download(operation, `uploads/${attachment.name}`, bytes.length + 1);
    if (hash(readback) !== attachment.hash) fail(operation, 'BOOTSTRAP_CHANGED');
  }
  private async transfer(operation: Operation, extra: Chunk[]): Promise<PackedFiles> {
    let offset = 0;
    const manifest = operation.files.map(file => { const entry = { path: file.path, hash: hash(file.bytes), size: file.bytes.byteLength, offset }; offset += file.bytes.byteLength; return entry; });
    const bundle = gzipSync(Buffer.concat(operation.files.map(f => f.bytes)), { level: 6 });
    operation.archiveHash = hash(bundle);
    const chunks: Chunk[] = [];
    for (let start = 0, part = 0; start < bundle.length; start += CHUNK_BYTES, part++) {
      const bytes = bundle.subarray(start, start + CHUNK_BYTES); chunks.push({ name: `pp_${operation.id}_bundle_${part}.bin`, bytes, hash: hash(bytes) });
    }
    await this.uploadChunks(operation, [...extra, ...chunks]);
    return { chunks, bundleHash: hash(bundle), size: offset, manifest };
  }
  private async uploadChunks(operation: Operation, chunks: Chunk[]) {
    // Keep each JSON body under TrueForge's 30 MiB limit including base64 overhead.
    let batch: Chunk[] = [], size = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.turn(operation, 'transfer', 'Store the attached binary files. Do not run any tools, read, extract, execute, or edit anything. Reply only STORED.', batch);
      for (const chunk of batch) {
        const actual = await this.download(operation, `uploads/${chunk.name}`, chunk.bytes.length + 1);
        if (hash(actual) !== chunk.hash || actual.length !== chunk.bytes.length) fail(operation, 'UPLOAD_HASH_MISMATCH');
      }
      batch = []; size = 0;
    };
    for (const chunk of chunks) { if (size + chunk.bytes.length > 16 * 1024 * 1024 || batch.length >= 100) await flush(); batch.push(chunk); size += chunk.bytes.length; }
    await flush();
  }
  private bootstrap(operation: Operation, packed: PackedFiles, command: FixedSandboxCommand | null, environment: Record<string, string>, materialize: boolean) {
    return `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),zlib=require('node:zlib');
const manifest=${JSON.stringify(packed.manifest)},chunks=${JSON.stringify(packed.chunks.map(c => ({ name: c.name, hash: c.hash })))},workspace=${JSON.stringify(operation.workspace)},command=${JSON.stringify(command)},extra=${JSON.stringify(environment)};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function regular(p){let cur='.';for(const part of p.split('/')){cur=path.join(cur,part);if(fs.lstatSync(cur).isSymbolicLink())throw Error('SYMLINK');}if(!fs.lstatSync(p).isFile())throw Error('FILE_TYPE');}
if(${materialize}){
  fs.mkdirSync(workspace,{mode:448});
  const packed=Buffer.concat(chunks.map(c=>{const p=path.join('uploads',c.name);regular(p);const b=fs.readFileSync(p);if(hash(b)!==c.hash)throw Error('CHUNK_HASH');return b;}));
  if(hash(packed)!==${JSON.stringify(packed.bundleHash)})throw Error('BUNDLE_HASH');
  const bundle=zlib.gunzipSync(packed,{maxOutputLength:${Math.max(1, packed.size)}});if(bundle.length!==${packed.size})throw Error('BUNDLE_SIZE');
  for(const f of manifest){
    if(f.path.startsWith('/')||f.path.includes('\\\\')||f.path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('PATH');
    const bytes=bundle.subarray(f.offset,f.offset+f.size);if(bytes.length!==f.size||hash(bytes)!==f.hash)throw Error('FILE_HASH');
    const p=path.join(workspace,f.path);fs.mkdirSync(path.dirname(p),{recursive:true,mode:448});fs.writeFileSync(p,bytes,{flag:'wx',mode:384});
  }
}
if(command){
  if(extra.PP_REPAIR_BRIDGE_MODULE)extra.PP_REPAIR_BRIDGE_MODULE=path.resolve(extra.PP_REPAIR_BRIDGE_MODULE.replace('../',''));
  const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'test',NEXT_TELEMETRY_DISABLED:'1',STAGING_ENABLED:'true',REFERENCE_DATABASE_PATH:'./reference.sqlite',...extra};
  const result=cp.spawnSync(command.interpreter,[command.script,...(command.args||[])],{cwd:workspace,env,stdio:'inherit',timeout:${operation.commandTimeoutMs}});
  process.exitCode=result.status===null?1:result.status;
}
const receipt=path.join(workspace,'.receipt');fs.mkdirSync(receipt,{recursive:true,mode:448});if(fs.lstatSync(receipt).isSymbolicLink())throw Error('RECEIPT_LINK');
function write(name,bytes){const p=path.join(receipt,name);try{fs.unlinkSync(p);}catch(e){if(e.code!=='ENOENT')throw e;}fs.writeFileSync(p,bytes,{flag:'wx',mode:384});}
let offset=0;const data=[],entries=[];
for(const f of manifest){const p=path.join(workspace,f.path);regular(p);const stat=fs.statSync(p);if(stat.size>${MAX_BYTES}||offset+stat.size>${MAX_BYTES})throw Error('FILE_LIMIT');const bytes=fs.readFileSync(p);entries.push({path:f.path,size:bytes.length,offset,sha256:hash(bytes)});offset+=bytes.length;data.push(bytes);}
const archive=zlib.gzipSync(Buffer.concat(data),{level:6}),parts=[];
for(let start=0,part=0;start<archive.length;start+=${CHUNK_BYTES},part++){const bytes=archive.subarray(start,start+${CHUNK_BYTES}),name='bundle_'+part+'.bin';write(name,bytes);parts.push({name,size:bytes.length,sha256:hash(bytes)});}
write('manifest.json',JSON.stringify({entries,size:offset,archiveHash:hash(archive),parts}));
process.stdout.write('SANDBOX_COMMAND_FINISHED\\n');
`;
  }
  private async download(operation: Operation, path: string, limit: number): Promise<Buffer> {
    operation.signal.throwIfAborted();
    const root = await this.sandboxRoot(operation);
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) fail(operation, 'ARTIFACT_PATH_REJECTED');
    // The HTTP API requires an absolute sandbox path, even though FileContent announcements use uploads/ relative paths.
    const absolutePath = resolve(root, path);
    if (!absolutePath.startsWith(`${root}/`)) fail(operation, 'ARTIFACT_PATH_REJECTED');
    const binary = await this.client.sessions.downloadSandboxFile(operation.input.sessionId, operation.previous, { path: absolutePath }, { abortSignal: operation.signal });
    const body = binary.stream(); if (!body) fail(operation, 'ARTIFACT_BODY_MISSING');
    const reader = body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > limit) { await reader.cancel(); fail(operation, 'ARTIFACT_BYTES_EXCEEDED'); } chunks.push(item.value); } }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  private async result(operation: Operation, allowEdits: boolean, observation: unknown): Promise<SandboxResult> {
    const files: SandboxResult['files'] = [], candidateBindings: SandboxBinding[] = [];
    const digest = z.string().regex(/^[a-f0-9]{64}$/), size = z.number().int().nonnegative().max(MAX_BYTES);
    const schema = z.strictObject({ entries: z.array(z.strictObject({ path: z.string(), size, offset: size, sha256: digest })).max(MAX_FILES), size, archiveHash: digest, parts: z.array(z.strictObject({ name: z.string().regex(/^bundle_[0-9]+\.bin$/), size: z.number().int().nonnegative().max(CHUNK_BYTES), sha256: digest })).min(1).max(66) });
    const metadata = schema.parse(JSON.parse((await this.download(operation, `${operation.workspace}/.receipt/manifest.json`, 8 * 1024 * 1024)).toString('utf8')));
    if (metadata.entries.length !== operation.files.length || metadata.parts.some((part, index) => part.name !== `bundle_${index}.bin`)) fail(operation, 'SNAPSHOT_MANIFEST_INVALID');
    const parts: Buffer[] = [];
    for (const part of metadata.parts) { const bytes = await this.download(operation, `${operation.workspace}/.receipt/${part.name}`, CHUNK_BYTES + 1); if (bytes.length !== part.size || hash(bytes) !== part.sha256) fail(operation, 'SNAPSHOT_HASH_MISMATCH'); parts.push(bytes); }
    const archive = Buffer.concat(parts); if (hash(archive) !== metadata.archiveHash) fail(operation, 'SNAPSHOT_HASH_MISMATCH');
    const allBytes = gunzipSync(archive, { maxOutputLength: Math.max(1, metadata.size) });
    if (allBytes.length !== metadata.size) fail(operation, 'SNAPSHOT_HASH_MISMATCH');
    let offset = 0;
    for (const [index, file] of operation.files.entries()) {
      const entry = metadata.entries[index];
      if (!entry || entry.path !== file.path || entry.offset !== offset || entry.offset + entry.size > allBytes.length || file.role === 'source' && entry.size > 1024 * 1024) fail(operation, 'SNAPSHOT_MANIFEST_INVALID');
      const bytes = allBytes.subarray(entry.offset, entry.offset + entry.size); offset += entry.size;
      if (hash(bytes) !== entry.sha256) fail(operation, 'SNAPSHOT_HASH_MISMATCH');
      if ((!allowEdits || file.role !== 'source') && hash(bytes) !== hash(file.bytes)) fail(operation, 'SANDBOX_INPUT_CHANGED');
      if (file.role === 'source') { files.push({ path: file.path, bytes }); candidateBindings.push(binding(file.path, bytes)); }
    }
    if (offset !== allBytes.length) fail(operation, 'SNAPSHOT_MANIFEST_INVALID');
    return { sessionId: operation.input.sessionId, operationId: operation.id, workspace: operation.workspace, turnIds: [...operation.turns], lastTurnId: operation.previous, transferArchiveHash: operation.archiveHash, baselineBindings: operation.files.map(f => binding(f.path, f.bytes)), candidateBindings, files, execReceipts: [...operation.receipts], observation };
  }
  private async sandboxRoot(operation: Operation): Promise<string> {
    if (operation.root) return operation.root;
    const ids = new Set<string>(); let count = 0;
    for await (const item of await this.client.sessions.listEvents(operation.input.sessionId, { limit: 1 })) { if (++count > 20_000) fail(operation, 'RUNTIME_HISTORY_EXCEEDED'); if (item.event.type === 'sandbox.created') ids.add(item.event.sandboxId); }
    if (ids.size === 0 && operation.turns.length === 0) {
      // TrueForge creates a sandbox lazily when its first attachment arrives.
      // Check the configured volume before that one-byte initialization, then
      // require the actual event and validate its root before uploading source.
      const payloadBytes = operation.files.reduce((total, file) => total + BigInt(file.bytes.byteLength), 0n);
      await assertRepairDestinationCapacity(join(homedir(), 'Library', 'Application Support', 'trueforge', 'sandboxes'), 3n * payloadBytes + 128n * 1024n ** 2n);
      const bytes = Buffer.from('0');
      await this.turn(operation, 'transfer', 'Store this initialization attachment. Reply STORED. Do not call tools or execute anything.', [{ name: `pp_${operation.id}_init.txt`, bytes, hash: hash(bytes) }]);
      return this.sandboxRoot(operation);
    }
    if (ids.size !== 1) fail(operation, 'SANDBOX_ID_AMBIGUOUS');
    const id = [...ids][0]; if (!id?.startsWith('v1:local:')) fail(operation, 'LOCAL_SANDBOX_REQUIRED');
    const root = id.slice('v1:local:'.length);
    const parent = join(homedir(), 'Library', 'Application Support', 'trueforge', 'sandboxes', operation.input.sessionId);
    if (process.platform !== 'darwin' || dirname(root) !== parent || !/^[a-z0-9]{26}$/.test(basename(root)) || resolve(root) !== root) fail(operation, 'SANDBOX_ROOT_REJECTED');
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid() || await realpath(root) !== root) fail(operation, 'SANDBOX_ROOT_REJECTED');
    operation.root = root; return root;
  }
}
