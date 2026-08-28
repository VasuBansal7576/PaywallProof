/** Implementation-aware tests. Synthetic SDK receipts are NOT product/provider evidence. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { isRepairStaticRequest, RepairSandboxRunner, safeRequestHeaders, type SandboxRunInput, type SandboxRuntimeState } from './sandbox.ts';
import { assertRepairDestinationCapacity, assertRepairDiskCapacity, REPAIR_MIN_FREE_BYTES } from './capacity.ts';

const mocks = vi.hoisted(() => ({ statfs: vi.fn(), get: vi.fn(), listTurns: vi.fn(), listEvents: vi.fn(), createTurn: vi.fn(), downloadSandboxFile: vi.fn(), checkConnection: vi.fn(), cancel: vi.fn(), resumeStream: vi.fn(), inspectTurn: vi.fn(), listTurnEvents: vi.fn(), syntheticRoot: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    statfs: mocks.statfs,
    lstat: async (path: string) => path === mocks.syntheticRoot ? { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o700, uid: process.getuid?.() } : actual.lstat(path),
    realpath: async (path: string) => path === mocks.syntheticRoot ? path : actual.realpath(path),
  };
});
vi.mock('@truefoundry/trueforge-sdk', () => ({ TrueForge: class { sessions = mocks; } }));
vi.mock('../../adapters/src/trueforge.ts', () => ({ TrueForgeAdapter: class {
  checkConnection = mocks.checkConnection; cancel = mocks.cancel; resumeStream = mocks.resumeStream;
  inspectTurn = mocks.inspectTurn; listTurnEvents = mocks.listTurnEvents;
} }));
const execute = promisify(execFile);
let root = '', counter = 0, latest = 'previous', lost = false, alter = false, omitReceipt = false;
let execExtras: Record<string, unknown> = {};
const children: ChildProcess[] = [], events = new Map<string, TrueForgeApi.SessionEvent[]>(), inputs = new Map<string, string>();
const done = (): TrueForgeApi.TurnStateDone => ({ status: 'done', completedAt: new Date().toISOString(), output: null, requiredActions: [] });
const turn = (id: string): TrueForgeApi.Turn => ({ id, sessionId: 'synthetic-session', previousTurnId: null, createdAt: new Date().toISOString(), state: done() });
beforeEach(async () => {
  vi.clearAllMocks(); counter = 0; latest = 'previous'; lost = false; alter = false; omitReceipt = false; execExtras = {}; events.clear(); inputs.clear();
  mocks.statfs.mockReset().mockResolvedValue({ bavail: 16n * 1024n ** 3n, bsize: 1n });
  root = await mkdtemp(join(tmpdir(), 'pp-runner-implementation-'));
  mocks.syntheticRoot = join(homedir(), 'Library', 'Application Support', 'trueforge', 'sandboxes', 'synthetic-session', '00000000000000000000000000');
  await mkdir(join(root, 'uploads'));
  mocks.checkConnection.mockResolvedValue({ model: 'local/model', local: true });
  mocks.get.mockResolvedValue({ data: { agent: { type: 'inline', spec: { model: { name: 'local/model' }, config: { sandbox: { enabled: true } } } } } });
  mocks.listTurns.mockImplementation(async function* () { yield turn(latest); });
  mocks.listEvents.mockImplementation(async function* () { yield { event: { type: 'sandbox.created', sandboxId: `v1:local:${mocks.syntheticRoot}` } }; });
  mocks.cancel.mockResolvedValue(undefined);
  mocks.inspectTurn.mockImplementation(async ({ turnId }: { turnId: string }) => turn(turnId));
  mocks.listTurnEvents.mockImplementation(async ({ turnId }: { turnId: string }) => events.get(turnId) ?? []);
  mocks.createTurn.mockImplementation(async (_sessionId: string, raw: unknown) => {
    const request = z.object({ previousTurnId: z.string(), input: z.array(z.object({ content: z.array(z.discriminatedUnion('type', [z.object({ type: z.literal('file'), name: z.string(), data: z.string() }), z.object({ type: z.literal('text'), text: z.string() })])) })) }).parse(raw);
    expect(request.previousTurnId).toBe(latest);
    for (const item of request.input.flatMap(i => i.content)) if (item.type === 'file') await writeFile(join(root, 'uploads', item.name), Buffer.from(item.data.split(',')[1] ?? '', 'base64'));
    if (lost) throw new Error('synthetic lost response');
    latest = `turn-${++counter}`;
    inputs.set(latest, request.input.flatMap(i => i.content).filter(i => i.type === 'text').map(i => i.text).join('\n'));
    return { data: turn(latest) };
  });
  mocks.downloadSandboxFile.mockImplementation(async (_sessionId: string, _turnId: string, { path }: { path: string }) => {
    expect(path.startsWith(`${mocks.syntheticRoot}/`)).toBe(true);
    const bytes = await readFile(path.replace(mocks.syntheticRoot, root));
    return { stream: () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  });
  mocks.resumeStream.mockImplementation(async function* ({ turnId }: { turnId: string }) {
    const input = inputs.get(turnId) ?? '', match = /command "(node uploads\/[^" ]+)"/.exec(input);
    const observed: TrueForgeApi.SessionEvent[] = [];
    if (match?.[1]) {
      const command = match[1], script = command.slice(5);
      const result = await execute(process.execPath, [script], { cwd: root, env: { NODE_ENV: 'development', PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, TMPDIR: root }, timeout: 10_000, maxBuffer: 100_000 });
      observed.push({ type: 'model.message', id: `${turnId}-call`, threadId: 'main', createdAt: new Date().toISOString(), toolCalls: [{ type: 'function', id: `${turnId}-tool`, function: { name: 'exec', arguments: JSON.stringify({ command, intent: 'synthetic implementation test', ...execExtras }) }, toolInfo: { type: 'truefoundry-system', name: 'exec' } }] });
      if (!omitReceipt) observed.push({ type: 'tool.response', id: `${turnId}-response`, threadId: 'main', createdAt: new Date().toISOString(), toolCallId: `${turnId}-tool`, content: JSON.stringify({ success: true, response: { exitCode: 0, result: result.stdout } }) });
    } else if (alter && input.includes('sanitized checkout')) {
      const workspace = /checkout is in (pp_[a-f0-9]+)\./.exec(input)?.[1];
      if (!workspace) throw new Error('missing fixture workspace');
      await writeFile(join(root, workspace, 'src/value.cjs'), 'module.exports=41;');
    }
    events.set(turnId, observed);
    yield { type: 'turn.done', id: `${turnId}-done`, threadId: null, createdAt: new Date().toISOString(), state: done() };
  });
});
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) { const ended = new Promise<void>(res => child.once('exit', () => res())); child.kill('SIGKILL'); await ended; } }
  await rm(root, { recursive: true, force: true });
});
function request(): SandboxRunInput {
  return { sessionId: 'synthetic-session', previousTurnId: 'previous', allowedPaths: ['src/value.cjs'], files: [
    { path: 'src/value.cjs', bytes: Buffer.from('module.exports=40;'), role: 'source' },
    { path: '_trusted/launch.cjs', bytes: Buffer.from("process.stdout.write(String(require('../src/value.cjs')+2)+'\\n');"), role: 'launcher' },
  ], fixedCommand: { interpreter: 'node', script: '_trusted/launch.cjs' } };
}

describe('repair runner implementation with synthetic SDK, no model/provider', () => {
  it('initializes a lazy sandbox with one bounded attachment before transferring application files', async () => {
    mocks.listEvents.mockImplementation(async function* () {
      if (counter > 0) yield { event: { type: 'sandbox.created', sandboxId: `v1:local:${mocks.syntheticRoot}` } };
    });
    const result = await new RepairSandboxRunner().run(request());
    const first = z.object({ input: z.array(z.object({ content: z.array(z.unknown()) })) }).parse(mocks.createTurn.mock.calls[0]?.[1]);
    expect(first.input[0]?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'file', data: 'data:application/octet-stream;base64,MA==' })]));
    expect(result.execReceipts).toHaveLength(1);
    expect(result.execReceipts[0]?.output).toContain('42');
    expect(mocks.statfs.mock.calls[0]?.[0]).toBe(join(homedir(), 'Library', 'Application Support', 'trueforge', 'sandboxes'));
  });
  it('does not loop or guess a filesystem path when sandbox initialization emits no ID', async () => {
    mocks.listEvents.mockImplementation(async function* () { /* synthetic missing event */ });
    await expect(new RepairSandboxRunner().run(request())).rejects.toMatchObject({ code: 'SANDBOX_ID_AMBIGUOUS' });
    expect(mocks.createTurn).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
  });
  it('retains private diagnostic causes without serializing them into runtime evidence', async () => {
    mocks.get.mockRejectedValueOnce(new Error('private-runtime-canary'));
    let caught:unknown;
    try { await new RepairSandboxRunner().run(request()); } catch (error) { caught=error; }
    expect(caught).toMatchObject({code:'SANDBOX_OPERATION_FAILED',cause:{message:'private-runtime-canary'}});
    expect(JSON.stringify(caught)).not.toContain('private-runtime-canary');
    expect(mocks.createTurn).not.toHaveBeenCalled();
  });
  it('rejects conflicting sandbox identities without initialization or file upload', async () => {
    mocks.listEvents.mockImplementation(async function* () {
      yield { event: { type: 'sandbox.created', sandboxId: `v1:local:${mocks.syntheticRoot}` } };
      yield { event: { type: 'sandbox.created', sandboxId: 'v1:local:another-root' } };
    });
    await expect(new RepairSandboxRunner().run(request())).rejects.toMatchObject({ code: 'SANDBOX_ID_AMBIGUOUS' });
    expect(mocks.createTurn).not.toHaveBeenCalled();
  });
  it('checks free space before even the lazy initialization attachment', async () => {
    mocks.listEvents.mockImplementation(async function* () { /* synthetic uninitialized sandbox */ });
    mocks.statfs.mockResolvedValue({ bavail: 0n, bsize: 4096n });
    await expect(new RepairSandboxRunner().run(request())).rejects.toMatchObject({ code: 'REPAIR_DISK_CAPACITY_INSUFFICIENT' });
    expect(mocks.createTurn).not.toHaveBeenCalled();
  });
  it('checks the existing destination ancestor before the first sandbox directory exists', async () => {
    const existing = await realpath(root);
    await assertRepairDestinationCapacity(join(existing, 'new-runtime', 'sandboxes'), 1024n);
    expect(mocks.statfs).toHaveBeenCalledExactlyOnceWith(existing, { bigint: true });
  });
  it('does not substitute another volume when a destination capacity probe fails', async () => {
    mocks.statfs.mockRejectedValue(Object.assign(new Error('private capacity failure'), { code: 'EACCES' }));
    await expect(assertRepairDestinationCapacity(join(await realpath(root), 'missing'), 1024n)).rejects.toThrow(/^REPAIR_DISK_CAPACITY_UNKNOWN$/);
    expect(mocks.statfs).toHaveBeenCalledTimes(1);
  });
  it('rejects a symlink ancestor and a non-directory destination before measuring capacity', async () => {
    const existing = await realpath(root);
    await symlink(join(existing, 'uploads'), join(existing, 'redirect'));
    await writeFile(join(existing, 'file'), 'fixture');
    for (const target of [join(existing, 'redirect', 'missing'), join(existing, 'file', 'missing')]) {
      await expect(assertRepairDestinationCapacity(target, 1024n)).rejects.toThrow(/^REPAIR_DISK_CAPACITY_UNKNOWN$/);
    }
    expect(mocks.statfs).not.toHaveBeenCalled();
  });
  it.each([-1n, 0n, 1n])('checks the exact free-space boundary: %s', async delta => {
    mocks.statfs.mockResolvedValue({ bavail: REPAIR_MIN_FREE_BYTES + delta, bsize: 1n });
    const result = assertRepairDiskCapacity(['/synthetic/volume']);
    if (delta < 0n) await expect(result).rejects.toMatchObject({ code: 'REPAIR_DISK_CAPACITY_INSUFFICIENT' });
    else await expect(result).resolves.toBeUndefined();
    expect(mocks.statfs).toHaveBeenCalledWith('/synthetic/volume', { bigint: true });
  });
  it('checks every destination and uses available blocks, not reserved free blocks', async () => {
    mocks.statfs.mockResolvedValueOnce({ bavail: 1024n ** 2n, bsize: 4096n }).mockResolvedValueOnce({ bavail: 0n, bfree: 1024n ** 2n, bsize: 4096n });
    await expect(assertRepairDiskCapacity(['/synthetic/source', '/synthetic/source', '/synthetic/runtime'])).rejects.toMatchObject({ code: 'REPAIR_DISK_CAPACITY_INSUFFICIENT' });
    expect(mocks.statfs.mock.calls.map(call => call[0])).toEqual(['/synthetic/source', '/synthetic/runtime']);
  });
  it.each([{ bavail: -1n, bsize: 4096n }, { bavail: 1n, bsize: 0n }, { bavail: 1n, bsize: -1n }, { bavail: Infinity, bsize: 1n }, {}])('fails closed on invalid filesystem counters, case %#', async usage => {
    mocks.statfs.mockResolvedValue(usage);
    await expect(assertRepairDiskCapacity(['/synthetic/volume'])).rejects.toMatchObject({ code: 'REPAIR_DISK_CAPACITY_UNKNOWN' });
  });
  it('fails closed without exposing a private filesystem error', async () => {
    mocks.statfs.mockRejectedValue(new Error('synthetic private filesystem path'));
    await expect(assertRepairDiskCapacity(['/synthetic/volume'])).rejects.toThrow(/^REPAIR_DISK_CAPACITY_UNKNOWN$/);
  });
  it.each(['low', 'unknown'])('stops a %s-capacity sandbox before upload or execution', async condition => {
    if (condition === 'low') mocks.statfs.mockResolvedValue({ bavail: 0n, bsize: 4096n });
    else mocks.statfs.mockRejectedValue(new Error('synthetic failure'));
    await expect(new RepairSandboxRunner().run(request())).rejects.toMatchObject({ code: condition === 'low' ? 'REPAIR_DISK_CAPACITY_INSUFFICIENT' : 'REPAIR_DISK_CAPACITY_UNKNOWN', runtime: { turnIds: [], execReceipts: [] } });
    expect(mocks.createTurn).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('forwards only the disposable token or the fixed negative-test token',()=>{
    expect(safeRequestHeaders({authorization:'Bearer disposable-only'},'disposable-only')).toEqual({authorization:'Bearer disposable-only'});
    expect(safeRequestHeaders({authorization:'Bearer invalid_synthetic_token'},'disposable-only')).toEqual({authorization:'Bearer invalid_synthetic_token'});
    expect(safeRequestHeaders({},'disposable-only')).toEqual({});
    for(const authorization of ['Bearer arbitrary-host-secret','Basic synthetic','Bearer disposable-only\r\nX-Injected: 1'])expect(()=>safeRequestHeaders({authorization},'disposable-only')).toThrow('BRIDGE_HEADERS_REJECTED');
  });
  it.each(['/_next/static/css/app/layout.css?v=1787930477649', '/_next/static/chunks/main-app.js?v=1787930477649', '/_next/static/chunks/app/dashboard/page.js'])('allows the pinned Next static asset URL %s', url => {
    expect(isRepairStaticRequest('GET', url)).toBe(true);
  });
  it.each(['/_next/static/../server.js', '/_next/static//secret', '/_next/static/%2e%2e/secret', '/_next/static/chunk.js?v=1&secret=2', '/_next/static/chunk.js?v=', '/_next/static/chunk.js?v=1#fragment', '/api/export?v=1', '//outside/_next/static/chunk.js', 'http://outside/_next/static/chunk.js'])('rejects static-route escape or arbitrary query %s', url => {
    expect(isRepairStaticRequest('GET', url)).toBe(false);
  });
  it('never admits a static asset mutation', () => {
    expect(isRepairStaticRequest('POST', '/_next/static/chunks/main-app.js?v=1787930477649')).toBe(false);
  });
  it('keeps Polar reader and replay signer outside the repair edit scope',async()=>{
    for(const path of ['packages/adapters/src/polar.ts','packages/reference/src/replay-signature.ts']){
      const input=request();input.files.push({path,bytes:Buffer.from('export {};'),role:'source'});input.allowedPaths.push(path);
      await expect(new RepairSandboxRunner().run(input)).rejects.toThrow('SANDBOX_SUPPORT_REJECTED');
    }
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('rejects Polar credential material before any sandbox transfer',async()=>{
    const input=request();input.files[0]!.bytes=Buffer.from(['polar','oat','synthetic_secret_canary_123456789'].join('_'));
    await expect(new RepairSandboxRunner().run(input)).rejects.toThrow('SANDBOX_CREDENTIAL_REJECTED');
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('hash binds uploaded and materialized bytes, keeps existing turn chain, and retains exec receipt', async () => {
    const states: SandboxRuntimeState[] = [], input = request(); input.onState = async state => { states.push(state); };
    const result = await new RepairSandboxRunner().run(input);
    expect(result.sessionId).toBe(input.sessionId); expect(result.turnIds).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(result.execReceipts).toHaveLength(1); expect(result.execReceipts[0]?.output).toContain('42\n');
    expect(result.candidateBindings[0]?.sha256).toBe(result.baselineBindings[0]?.sha256);
    expect(Buffer.from(result.files[0]?.bytes ?? []).toString()).toBe('module.exports=40;');
    expect(states.map(s => s.turnId)).toEqual([null, 'turn-1', null, 'turn-2', null, 'turn-3']);
    expect(mocks.cancel).not.toHaveBeenCalled(); expect(result.observation).toBeNull();
  });
  it('packs many files and a file above the runtime download limit into bounded archives', async () => {
    const input = request();
    for (let i = 0; i < 200; i++) input.files.push({ path: `node_modules/fixture/file-${i}.js`, bytes: Buffer.from(`module.exports=${i};`), role: 'dependency' });
    input.files.push({ path: 'node_modules/fixture/large.node', bytes: Buffer.alloc(21 * 1024 * 1024, 7), role: 'dependency' });
    const result = await new RepairSandboxRunner().run(input);
    expect(result.turnIds).toHaveLength(3); expect(result.baselineBindings).toHaveLength(203);
    expect(mocks.downloadSandboxFile).toHaveBeenCalledTimes(5);
  });
  it('retains generated build output between setup and final commands', async () => {
    const input = request();
    input.files.push({ path: '_trusted/build.cjs', bytes: Buffer.from("require('node:fs').writeFileSync('built.txt','built');"), role: 'launcher' });
    const launcher = input.files.find(f => f.role === 'launcher');
    if (!launcher) throw new Error('fixture missing');
    launcher.bytes = Buffer.from("process.stdout.write(require('node:fs').readFileSync('built.txt','utf8'));");
    input.setupCommands = [{ interpreter: 'node', script: '_trusted/build.cjs' }];
    const result = await new RepairSandboxRunner().run(input);
    expect(result.execReceipts).toHaveLength(2); expect(result.execReceipts[1]?.output).toContain('built');
  });
  it('returns untrusted changed source after prepare without claiming verification', async () => {
    alter = true;
    const result = await new RepairSandboxRunner().prepare({ ...request(), instructions: 'Synthetic fixture edit from 40 to 41.' });
    expect(Buffer.from(result.files[0]?.bytes ?? []).toString()).toBe('module.exports=41;');
    expect(result.candidateBindings[0]?.sha256).not.toBe(result.baselineBindings[0]?.sha256);
    expect(result).not.toHaveProperty('verified');
    const instructions = [...inputs.values()].find(value => value.includes('sanitized checkout'));
    expect(instructions).toContain(JSON.stringify([`${result.workspace}/src/value.cjs`]));
    expect(instructions).toContain(`Set cwd to ${JSON.stringify(result.workspace)}`);
    expect(result.execReceipts[0]?.output).toContain('module.exports=40;');
    expect(result.execReceipts[0]?.output).not.toContain('module.exports=41;');
  });
  it('bounds source previews and never includes support or dependency bytes', async () => {
    const input = request();
    input.files = input.files.filter(file => file.role !== 'source');
    input.allowedPaths = [];
    for (let index = 0; index < 10; index++) {
      const path = `src/preview-${index}.cjs`;
      input.allowedPaths.push(path);
      input.files.push({ path, role: 'source', bytes: Buffer.from('x'.repeat(6000)) });
    }
    input.files.push({ path: 'packages/reference/src/replay-signature.ts', role: 'support', bytes: Buffer.from('PRIVATE_SUPPORT_CANARY') });
    const result = await new RepairSandboxRunner().prepare({ ...input, instructions: 'Inspect only.' });
    const output = [...events.values()].flat().filter(event => event.type === 'tool.response').map(event => event.content).join('\n');
    expect(output).not.toContain('PRIVATE_SUPPORT_CANARY');
    const rows = [...events.values()].flat().flatMap(event => {
      if (event.type !== 'tool.response') return [];
      const body = z.object({ response: z.object({ result: z.string() }) }).parse(JSON.parse(event.content));
      return body.response.result.split('\n').filter(line => line.startsWith('{"sourcePath"')).map(line => z.object({ preview: z.string(), truncated: z.boolean() }).parse(JSON.parse(line)));
    });
    expect(rows.reduce((total, row) => total + Buffer.byteLength(row.preview), 0)).toBe(32768);
    expect(rows.every(row => row.truncated && Buffer.byteLength(row.preview) <= 4096)).toBe(true);
    expect(result.files).toHaveLength(10);
    expect(result.files.every(file => file.bytes.byteLength === 6000)).toBe(true);
  });
  it('does not retry an uncertain create response and retains the pending persistence record', async () => {
    lost = true; const states: SandboxRuntimeState[] = [];
    await expect(new RepairSandboxRunner().run({ ...request(), onState: async state => { states.push(state); } })).rejects.toMatchObject({ code: 'RUNTIME_TURN_CREATION_UNKNOWN', runtime: { sessionId: 'synthetic-session', turnIds: [] } });
    expect(mocks.createTurn).toHaveBeenCalledTimes(1); expect(states).toHaveLength(1); expect(states[0]?.turnId).toBeNull();
  });
  it('rejects a tampered upload before dispatching any exec command', async () => {
    mocks.downloadSandboxFile.mockImplementationOnce(async () => ({ stream: () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('tampered')); controller.close(); } }) }));
    await expect(new RepairSandboxRunner().run(request())).rejects.toMatchObject({ code: 'UPLOAD_HASH_MISMATCH' });
    expect(mocks.createTurn).toHaveBeenCalledTimes(1);
  });
  it('does not copy provider credentials or host environment into the fixed command', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'host-only-test-value');
    try {
      const input = request(), launcher = input.files.find(f => f.role === 'launcher');
      if (!launcher) throw new Error('fixture missing');
      launcher.bytes = Buffer.from("if(process.env.GITHUB_TOKEN||process.env.STRIPE_SECRET_KEY||process.env.NODE_OPTIONS)process.exit(1);process.stdout.write('clean-env');");
      const result = await new RepairSandboxRunner().run(input);
      expect(result.execReceipts[0]?.output).toContain('clean-env');
    } finally { vi.unstubAllEnvs(); }
  });
  it('rejects source changes during a fixed run and accepts bracketed Next route filenames', async () => {
    const input = request(), launcher = input.files.find(f => f.role === 'launcher');
    if (!launcher) throw new Error('fixture missing');
    input.files.push({ path: 'app/api/[...path]/route.ts', bytes: Buffer.from('export const runtime="nodejs";'), role: 'source' }); input.allowedPaths.push('app/api/[...path]/route.ts');
    launcher.bytes = Buffer.from("require('node:fs').writeFileSync('src/value.cjs','module.exports=99;');");
    await expect(new RepairSandboxRunner().run(input)).rejects.toMatchObject({ code: 'SANDBOX_INPUT_CHANGED' });
  });
  it('rejects a nonlocal existing session before creating or cancelling a turn', async () => {
    mocks.get.mockResolvedValueOnce({ data: { agent: { type: 'inline', spec: { model: { name: 'hosted/provider' }, config: { sandbox: { enabled: true } } } } } });
    await expect(new RepairSandboxRunner().run(request())).rejects.toMatchObject({ code: 'LOCAL_SESSION_REQUIRED' });
    expect(mocks.createTurn).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('rejects absent exec evidence and stale session chain without cancelling unrelated work', async () => {
    omitReceipt = true;
    await expect(new RepairSandboxRunner().run(request())).rejects.toMatchObject({ code: 'EXEC_RECEIPT_MISSING' });
    mocks.cancel.mockClear();
    await expect(new RepairSandboxRunner().run(request())).rejects.toMatchObject({ code: 'RUNTIME_PREVIOUS_TURN_REJECTED' });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('accepts only explicit empty exec defaults as equivalent to omission', async () => {
    execExtras = { cwd: '.', env: {} };
    const result = await new RepairSandboxRunner().run(request());
    expect(result.execReceipts).toHaveLength(1);
    expect(result.execReceipts[0]?.output).toContain('42\n');
  });
  it.each([{ cwd: '/tmp' }, { cwd: './' }, { cwd: '../' }, { env: { PATH: '/tmp' } }])('rejects exec scope/environment override %j', async override => {
    execExtras = override;
    await expect(new RepairSandboxRunner().run(request())).rejects.toMatchObject({ code: 'EXACT_EXEC_REQUIRED' });
  });
  it.each(['../escape', '/tmp/escape', 'src/.env', 'tests/oracle.ts', 'src/value.cjs/child'])('rejects protected or conflicting transfer path %s before runtime access', async path => {
    const input = request(); input.files.push({ path, bytes: Buffer.from('x'), role: 'source' }); input.allowedPaths.push(path);
    await expect(new RepairSandboxRunner().run(input)).rejects.toThrow(); expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('actual local Node reverse bridge, installation mechanism only', () => {
  it('handles serial HTTP bytes on sandbox-initiated accepted streams and exits after host closure', async () => {
    const source = await readFile(new URL('./sandbox.ts', import.meta.url), 'utf8');
    const hostCode = /const HOST_BRIDGE = String\.raw`([\s\S]*?)`;/m.exec(source)?.[1];
    const sandboxCode = /const SANDBOX_BRIDGE = String\.raw`([\s\S]*?)`;/m.exec(source)?.[1];
    if (!hostCode || !sandboxCode) throw new Error('implementation fixture source missing');
    await writeFile(join(root, 'bridge.cjs'), sandboxCode);
    const host = spawn(process.execPath, ['-e', hostCode], { cwd: root, env: { NODE_ENV: 'development', PP_SOCKET: 's', PP_TOKEN: 'disposable-test-only' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(host);
    const messages: unknown[] = []; host.on('message', message => messages.push(message));
    await expect.poll(() => messages.some(m => z.object({ kind: z.literal('listening') }).safeParse(m).success)).toBe(true);
    const sandbox = spawn(process.execPath, ['-e', "require('./bridge.cjs').serve((req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream'});res.end(req.url==='/large'?Buffer.alloc(12*1024*1024,42):Buffer.from([0,42,255]));}).catch(()=>{process.exitCode=1;});"], { cwd: root, env: { NODE_ENV: 'development', PP_REPAIR_BRIDGE_SOCKET: 's', PP_REPAIR_BRIDGE_TOKEN: 'disposable-test-only' }, stdio: ['ignore', 'ignore', 'pipe'] }); children.push(sandbox);
    await expect.poll(() => messages.some(m => z.object({ kind: z.literal('ready') }).safeParse(m).success)).toBe(true);
    for (const id of ['first', 'second']) {
      host.send({ kind: 'request', id, method: 'GET', path: '/', headers: {}, body: '' });
      await expect.poll(() => messages.find(m => z.object({ kind: z.literal('response'), id: z.literal(id) }).safeParse(m).success)).toMatchObject({ status: 200, body: 'ACr/' });
    }
    host.send({ kind: 'request', id: 'large-api-rejected', method: 'GET', path: '/large', headers: {}, body: '' });
    await expect.poll(() => messages.find(m => z.object({ id: z.literal('large-api-rejected') }).safeParse(m).success)).toMatchObject({ error: 'RESPONSE_TOO_LARGE' });
    host.send({ kind: 'request', id: 'large-static', method: 'GET', path: '/large', headers: {}, body: '', maximumBytes: 16 * 1024 * 1024 });
    await expect.poll(() => messages.find(m => z.object({ id: z.literal('large-static'), status: z.literal(200) }).safeParse(m).success), { timeout: 5000 }).toBeDefined();
    const large = z.object({ body: z.string() }).parse(messages.find(m => z.object({ id: z.literal('large-static') }).safeParse(m).success));
    expect(Buffer.from(large.body, 'base64').equals(Buffer.alloc(12 * 1024 * 1024, 42))).toBe(true);
    host.send({ kind: 'request', id: 'after-rejection', method: 'GET', path: '/', headers: {}, body: '' });
    await expect.poll(() => messages.find(m => z.object({ id: z.literal('after-rejection') }).safeParse(m).success)).toMatchObject({ status: 200, body: 'ACr/' });
    host.send({ kind: 'close' });
    await expect.poll(() => sandbox.exitCode).toBe(0);
    await expect.poll(() => host.exitCode).toBe(0);
  }, 20_000);
});
