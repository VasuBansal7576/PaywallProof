/** Implementation-aware fake Next/SQLite modules. No Next, inference or product verification runs. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createReferenceLauncher } from './launcher.ts';
import { collectRepairDependencies } from './checkout.ts';

const execute = promisify(execFile);
const buildId = 'a'.repeat(40), priceId = 'price_fixtureOnly';
const nativeSQLitePath = `better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`;
const names = ['next', 'react', 'react-dom', 'hono', 'zod', 'standardwebhooks', 'better-sqlite3', 'typescript', '@types/react', '@types/node'];
let parent = '', root = '';
const bridge = '../uploads/pp_000000000000000000000000_bridge.cjs';
async function put(path: string, value: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
const record = "const fs=require('node:fs'),p=require('node:path').join(process.cwd(),'observed.json');function record(event){const events=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):[];events.push(event);fs.writeFileSync(p,JSON.stringify(events));}";
async function run(extra: Partial<NodeJS.ProcessEnv> = {}) {
  return execute(process.execPath, ['_trusted/reference.cjs'], { cwd: root,
    env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root,
      TARGET_ADAPTER_TOKEN: '1'.repeat(64), POLAR_WEBHOOK_SECRET: '2'.repeat(64), LOCAL_REPLAY_SECRET: '3'.repeat(64),
      PP_REPAIR_BRIDGE_MODULE: join(parent, 'uploads/pp_000000000000000000000000_bridge.cjs'), ...extra }, timeout: 5_000, maxBuffer: 10_000 });
}
beforeEach(async () => {
  parent = await realpath(await mkdtemp(join(tmpdir(), 'pp-launcher-implementation-')));
  root = join(parent, 'pp_000000000000000000000000');
  const launcher = createReferenceLauncher({ buildId, priceId });
  await put(join(root, launcher.file.path), Buffer.from(launcher.file.bytes).toString());
  for (const name of names) {
    // Read metadata only; never import installed dependency code in this test.
    const metadata: unknown = JSON.parse(await readFile(join(process.cwd(), 'node_modules', name, 'package.json'), 'utf8'));
    await put(join(root, 'node_modules', name, 'package.json'), JSON.stringify(metadata));
  }
  for (const name of ['apps/demo-saas/app/layout.tsx', 'apps/demo-saas/app/dashboard/page.tsx', 'apps/demo-saas/server.ts', 'apps/demo-saas/next.config.ts']) await put(join(root, name), '// synthetic source, never executed');
  for (const name of ['typescript/lib/typescript.js', 'typescript/bin/tsc', '@types/react/index.d.ts', '@types/node/index.d.ts', nativeSQLitePath]) await put(join(root, 'node_modules', name), 'synthetic preflight bytes');
  await put(join(root, 'node_modules/next/dist/build/swc/index.js'), record + "exports.transformSync=()=>{record({kind:'native-preflight',ci:process.env.CI,wasm:process.env.NEXT_DISABLE_SWC_WASM});return {code:'const preflight = 1;'};};exports.getBindingsSync=()=>({isWasm:false});");
  await put(join(root, 'node_modules/next/dist/server/next.js'), record + "module.exports=options=>{record({kind:'next',options,env:{nodeEnv:process.env.NODE_ENV,priceId:process.env.BILLING_PRICE_ID,buildId:process.env.TARGET_BUILD_ID,staging:process.env.STAGING_ENABLED}});return{prepare:async()=>record({kind:'prepare'}),getRequestHandler:()=>()=>{},close:async()=>record({kind:'close'})};};");
  await put(join(root, 'node_modules/better-sqlite3/lib/index.js'), record + "module.exports=class{constructor(name){record({kind:'sqlite',name});}close(){record({kind:'sqlite-close'});}};");
  await put(join(parent, 'uploads', 'pp_000000000000000000000000_bridge.cjs'), record + "exports.serve=async handler=>{if(typeof handler!=='function')throw Error('handler');record({kind:'bridge'});};");
});
afterEach(async () => { await rm(parent, { recursive: true, force: true }); });

describe('trusted reference launcher factory (synthetic implementation checks)', () => {
  it('packages runtime files but excludes colocated dependency tests and their declarations', async () => {
    const dependency = join(root, 'node_modules', 'fixture-dependency');
    await put(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0' }));
    await put(join(dependency, 'runtime.js'), 'exports.answer = 42;');
    await put(join(dependency, 'runtime-test.js'), 'exports.isRuntime = true;');
    for (const path of ['build.test.js', 'base64.test.ts', 'lib/base64.test.d.ts', 'deep/unit.SPEC.cjs', 'Tests/hidden.js', '__tests__/hidden.js']) await put(join(dependency, path), 'throw new Error("test code must stay outside the model workspace");');
    const result = await collectRepairDependencies(root, ['fixture-dependency']);
    expect(result.files.map(file => file.path).sort()).toEqual(['node_modules/fixture-dependency/package.json', 'node_modules/fixture-dependency/runtime-test.js', 'node_modules/fixture-dependency/runtime.js']);
    expect(result.totalBytes).toBe(result.files.reduce((total, file) => total + file.bytes.byteLength, 0));
  });
  it('returns deterministic trusted bytes and a fixed command', () => {
    const one = createReferenceLauncher({ buildId, priceId });
    expect(one).toEqual(createReferenceLauncher({ buildId, priceId }));
    expect(one.file.role).toBe('launcher');
    expect(one.fixedCommand).toEqual({ interpreter: 'node', script: one.file.path });
  });
  it.each([{ buildId: 'main', priceId }, { buildId: 'A'.repeat(40), priceId }, { buildId, priceId: 'price_x;curl' }, { buildId, priceId: 'sk_test_notAllowed' }])('rejects non-public or malformed identity %j', input => {
    expect(() => createReferenceLauncher(input)).toThrow('REFERENCE_LAUNCHER_INPUT_REJECTED');
  });
  it('preflights before preparing actual custom-server API shape, creates config and closes after bridge', async () => {
    await run();
    const events: { kind: string; options?: unknown; env?: unknown }[] = JSON.parse(await readFile(join(root, 'observed.json'), 'utf8'));
    expect(events.map(event => event.kind)).toEqual(['native-preflight', 'sqlite', 'sqlite-close', 'next', 'prepare', 'bridge', 'close']);
    expect(events.find(event => event.kind === 'next')).toMatchObject({ options: { dev: true, webpack: true, dir: join(root, 'apps/demo-saas'), hostname: 'sandbox.invalid', port: 3001 }, env: { nodeEnv: 'development', priceId, buildId, staging: 'true' } });
    const config: unknown = JSON.parse(await readFile(join(root, 'apps/demo-saas/tsconfig.json'), 'utf8'));
    expect(config).toMatchObject({ compilerOptions: { noEmit: true, moduleResolution: 'bundler' } });
    expect(await readFile(join(root, 'apps/demo-saas/server.ts'), 'utf8')).toBe('// synthetic source, never executed');
    await run({ NODE_ENV: 'development', PP_REPAIR_BRIDGE_MODULE: bridge }); // Exact relative compatibility form; same config is never overwritten.
  });
  it.each(['typescript/lib/typescript.js', '@types/node/index.d.ts', nativeSQLitePath])('rejects missing %s before Next/SWC executes', async missing => {
    await rm(join(root, 'node_modules', missing));
    await expect(run()).rejects.toMatchObject({ code: 1, stderr: 'REFERENCE_LAUNCHER_FAILED\nREFERENCE_LAUNCHER_STAGE=dependencies\n' });
    await expect(readFile(join(root, 'observed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a broken native binding without falling through to Next preparation', async () => {
    await put(join(root, 'node_modules/next/dist/build/swc/index.js'), "exports.transformSync=()=>{throw Error('private-native-error-must-not-leak');};");
    await expect(run()).rejects.toMatchObject({ code: 1, stderr: 'REFERENCE_LAUNCHER_FAILED\nREFERENCE_LAUNCHER_STAGE=native-swc\n' });
    await expect(readFile(join(root, 'observed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects dependency drift and foreign generated config', async () => {
    await put(join(root, 'node_modules/react/package.json'), JSON.stringify({ name: 'react', version: '0.0.0' }));
    await expect(run()).rejects.toMatchObject({ code: 1 });
    await put(join(root, 'node_modules/react/package.json'), JSON.stringify({ name: 'react', version: '19.2.8' }));
    await put(join(root, 'apps/demo-saas/tsconfig.json'), '{"extends":"/outside"}');
    await expect(run()).rejects.toMatchObject({ code: 1 });
    expect(await readFile(join(root, 'apps/demo-saas/tsconfig.json'), 'utf8')).toBe('{"extends":"/outside"}');
  });
  it('rejects symlink dependency paths and inherited provider keys before module execution', async () => {
    await expect(run({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'synthetic-forbidden' })).rejects.toMatchObject({ code: 1 });
    const file = join(root, 'node_modules/typescript/lib/typescript.js');
    await rm(file); await symlink(join(root, 'node_modules/typescript/bin/tsc'), file);
    await expect(run()).rejects.toMatchObject({ code: 1 });
    await expect(readFile(join(root, 'observed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('closes the custom server when the reverse bridge fails', async () => {
    await put(join(parent, 'uploads', 'pp_000000000000000000000000_bridge.cjs'), "exports.serve=async()=>{throw Error('synthetic bridge failure');};");
    await expect(run()).rejects.toMatchObject({ code: 1 });
    const events: { kind: string }[] = JSON.parse(await readFile(join(root, 'observed.json'), 'utf8'));
    expect(events.at(-1)?.kind).toBe('close');
  });
  it('rejects a bridge from another operation or a symlink before loading dependencies', async () => {
    await expect(run({ NODE_ENV: 'development', PP_REPAIR_BRIDGE_MODULE: '../uploads/pp_111111111111111111111111_bridge.cjs' })).rejects.toMatchObject({ code: 1 });
    const file = join(parent, 'uploads/pp_000000000000000000000000_bridge.cjs');
    await rm(file); await symlink(join(root, '_trusted/reference.cjs'), file);
    await expect(run()).rejects.toMatchObject({ code: 1 });
    await expect(readFile(join(root, 'observed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
