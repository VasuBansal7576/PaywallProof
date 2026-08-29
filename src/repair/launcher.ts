import { z } from 'zod';
import type { FixedSandboxCommand, SandboxFile } from './sandbox.ts';

const inputSchema = z.strictObject({
  buildId: z.string().regex(/^[a-f0-9]{40}$/),
  priceId: z.union([z.uuid(), z.string().regex(/^price_[A-Za-z0-9_]{1,200}$/)]),
});
// Exact versions in pnpm-lock.yaml. A dependency upgrade requires a reviewed launcher update.
const versions = {
  next: '16.3.3',
  react: '19.2.8',
  'react-dom': '19.2.8',
  hono: '4.13.5',
  zod: '4.4.3',
  standardwebhooks: '1.0.0',
  'better-sqlite3': '13.0.2',
  typescript: '5.9.3',
  '@types/react': '19.2.18',
  '@types/node': '22.20.1',
};
const swcMethods = { transform: 'transformSync', bindings: 'getBindingsSync' } satisfies Record<
  string,
  keyof typeof import('next/dist/build/swc')
>;
const tsconfig = {
  compilerOptions: {
    target: 'ES2017',
    lib: ['dom', 'dom.iterable', 'esnext'],
    allowJs: true,
    skipLibCheck: true,
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    incremental: true,
    module: 'esnext',
    esModuleInterop: true,
    moduleResolution: 'bundler',
    resolveJsonModule: true,
    isolatedModules: true,
    jsx: 'react-jsx',
    plugins: [{ name: 'next' }],
  },
  include: [
    'next-env.d.ts',
    '.next/types/**/*.ts',
    '.next/dev/types/**/*.ts',
    '**/*.mts',
    '**/*.ts',
    '**/*.tsx',
  ],
  exclude: ['node_modules'],
};

export type ReferenceLauncher = { file: SandboxFile; fixedCommand: FixedSandboxCommand };

/** Produces trusted bytes only. Target/dependency code executes exclusively inside the runner. */
export function createReferenceLauncher(input: {
  buildId: string;
  priceId: string;
}): ReferenceLauncher {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error('REFERENCE_LAUNCHER_INPUT_REJECTED');
  const source = String.raw`'use strict';
const fs = require('node:fs'), path = require('node:path');
const config = ${JSON.stringify(parsed.data)}, versions = ${JSON.stringify(versions)};
const root = fs.realpathSync(process.cwd()), appDir = path.join(root, 'apps/demo-saas');
let phase = 'configuration';
function regular(name) {
  const full = path.resolve(root, name), relative = path.relative(root, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('LAUNCHER_PATH_REJECTED');
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('LAUNCHER_SYMLINK_REJECTED');
  }
  if (!fs.lstatSync(full).isFile() || fs.realpathSync(full) !== full) throw new Error('LAUNCHER_FILE_REJECTED');
  return full;
}
function generated(name, value) {
  const full = path.join(appDir, name), bytes = JSON.stringify(value, null, 2) + '\n';
  try { fs.writeFileSync(full, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    if (fs.readFileSync(regular('apps/demo-saas/' + name), 'utf8') !== bytes) throw new Error('LAUNCHER_CONFIG_CONFLICT');
  }
}
async function main() {
  if (process.env.POLAR_ACCESS_TOKEN || process.env.POLAR_REFERENCE_TOKEN || process.env.STRIPE_SECRET_KEY || process.env.GITHUB_TOKEN || process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error('LAUNCHER_ENV_REJECTED');
  for (const name of ['TARGET_ADAPTER_TOKEN', 'POLAR_WEBHOOK_SECRET', 'LOCAL_REPLAY_SECRET']) {
    if (!/^[a-f0-9]{64}$/.test(process.env[name] || '')) throw new Error('LAUNCHER_FIXTURE_CREDENTIAL_REQUIRED');
  }
  const bridge = process.env.PP_REPAIR_BRIDGE_MODULE || '';
  const operation = path.basename(root);
  if (!/^pp_[a-f0-9]{24}$/.test(operation)) throw new Error('LAUNCHER_WORKSPACE_REJECTED');
  const relativeBridge = '../uploads/' + operation + '_bridge.cjs';
  const expectedBridge = path.resolve(root, relativeBridge), uploads = path.dirname(expectedBridge);
  if (bridge !== expectedBridge && bridge !== relativeBridge) throw new Error('LAUNCHER_BRIDGE_REJECTED');
  if (fs.lstatSync(uploads).isSymbolicLink() || !fs.lstatSync(uploads).isDirectory()
    || fs.lstatSync(expectedBridge).isSymbolicLink() || !fs.lstatSync(expectedBridge).isFile()
    || fs.realpathSync(expectedBridge) !== expectedBridge) throw new Error('LAUNCHER_BRIDGE_REJECTED');
  for (const name of ['apps/demo-saas/app/layout.tsx', 'apps/demo-saas/app/dashboard/page.tsx', 'apps/demo-saas/server.ts', 'apps/demo-saas/next.config.ts']) regular(name);
  phase = 'dependencies';
  for (const [name, version] of Object.entries(versions)) {
    const metadata = JSON.parse(fs.readFileSync(regular('node_modules/' + name + '/package.json'), 'utf8'));
    if (metadata.name !== name || metadata.version !== version) throw new Error('LAUNCHER_DEPENDENCY_VERSION');
  }
  for (const file of ['typescript/lib/typescript.js', 'typescript/bin/tsc', '@types/react/index.d.ts', '@types/node/index.d.ts']) regular('node_modules/' + file);
  // Pinned better-sqlite3 13 ships platform prebuilds instead of requiring a
  // node-gyp build/Release output. This runner supports the local macOS sandbox.
  regular('node_modules/better-sqlite3/prebuilds/' + process.platform + '-' + process.arch + '.node');
  process.env.NODE_ENV = 'development';
  process.env.CI = '1';
  process.env.NEXT_TELEMETRY_DISABLED = '1';
  process.env.NEXT_DISABLE_SWC_WASM = '1';
  process.env.NEXT_IGNORE_INCORRECT_LOCKFILE = '1';
  // Fixed snapshots do not need one native watcher per file. Polling avoids
  // exhausting the sandbox's descriptor limit during Next's route discovery.
  process.env.WATCHPACK_POLLING = '1000';
  process.env.STAGING_ENABLED = 'true';
  process.env.BILLING_PRICE_ID = config.priceId;
  process.env.TARGET_BUILD_ID = config.buildId;
  process.env.REFERENCE_DATABASE_PATH = path.join(root, 'reference.sqlite');
  generated('package.json', { name: 'paywallproof-repair-reference', version: '0.0.0', private: true, dependencies: versions });
  generated('tsconfig.json', ${JSON.stringify(tsconfig)});
  // The exported sync transform initializes native bindings without a download
  // fallback. loadBindingsSync is private in Next 16.3.3, not an exported method.
  phase = 'native-swc';
  const swc = require('next/dist/build/swc');
  swc[${JSON.stringify(swcMethods.transform)}]('const preflight = 1;', { filename: 'preflight.js', jsc: { parser: { syntax: 'ecmascript' } }, swcrc: false });
  const bindings = swc[${JSON.stringify(swcMethods.bindings)}]();
  if (!bindings || bindings.isWasm !== false) throw new Error('LAUNCHER_NATIVE_SWC_REQUIRED');
  phase = 'native-sqlite';
  const Database = require('better-sqlite3'), database = new Database(':memory:');
  database.close();
  phase = 'next-prepare';
  const next = require('next');
  const app = next({ dev: true, webpack: true, dir: appDir, hostname: 'sandbox.invalid', port: 3001 });
  try {
    await app.prepare();
    phase = 'http-bridge';
    // Resolve relative to the operation workspace, not this _trusted module.
    const { serve } = require(expectedBridge);
    await serve(app.getRequestHandler());
  } finally { await app.close(); }
}
// This is a foreground command, not a reusable server. After the bridge has
// finished and app.close() has settled, idle dependency timers must not keep it
// alive until the outer command deadline. Flush the selected exit diagnostic.
main().then(
  () => process.stdout.write('', () => process.exit(0)),
  () => process.stderr.write('REFERENCE_LAUNCHER_FAILED\nREFERENCE_LAUNCHER_STAGE=' + phase + '\n', () => process.exit(1)),
);
`;
  return {
    file: { path: '_trusted/reference.cjs', bytes: Buffer.from(source), role: 'launcher' },
    fixedCommand: { interpreter: 'node', script: '_trusted/reference.cjs' },
  };
}
