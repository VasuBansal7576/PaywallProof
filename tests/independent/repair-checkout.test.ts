import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { collectRepairDependencies, readRepairSource } from '../../packages/repair/src/checkout.ts';

// Only temporary synthetic repositories are accessed. Git remotes are inert
// configuration strings; no fetch, push, package install or repository script runs.

const repository = 'synthetic-owner/synthetic-repair-fixture';
const sourcePath = 'src/billing/webhook.ts';
const otherPath = 'src/features/export.ts';
const source = Buffer.from('export const label = "synthetic café 🧪";\r\n', 'utf8');
let directory: string;
let repositoryRoot: string;
let baseCommit: string;

function git(args: string[], input?: Uint8Array) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repositoryRoot, ...args], {
    env: {
      ...env, NODE_ENV: 'test', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Synthetic Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function put(path: string, bytes: string | Uint8Array) {
  const absolute = join(repositoryRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
}

function commit() {
  git(['add', '--all']);
  git(['commit', '--quiet', '-m', 'Synthetic fixture']);
  return git(['rev-parse', 'HEAD']).toString('utf8').trim();
}

function collect(overrides: Record<string, unknown> = {}) {
  return readRepairSource({ repositoryRoot, baseCommit, repository, paths: [sourcePath], ...overrides });
}

async function rejected(action: () => unknown) {
  let error: unknown;
  try { await action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
}

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function treeSnapshot(root = repositoryRoot) {
  const entries: { path: string; kind: string; mode: number; content?: string }[] = [];
  function walk(path: string) {
    const stat = lstatSync(path);
    const common = { path: relative(root, path), mode: stat.mode };
    if (stat.isSymbolicLink()) entries.push({ ...common, kind: 'symlink', content: readlinkSync(path) });
    else if (stat.isDirectory()) {
      entries.push({ ...common, kind: 'directory' });
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else entries.push({ ...common, kind: 'file', content: hash(readFileSync(path)) });
  }
  walk(root);
  return entries;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'paywallproof-independent-checkout-'));
  repositoryRoot = join(directory, 'checkout');
  mkdirSync(repositoryRoot);
  git(['init', '--quiet', '--template=', '--initial-branch=main']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.filemode', 'true']);
  git(['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
  put(sourcePath, source);
  put(otherPath, 'export const syntheticExport = true;\n');
  baseCommit = commit();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('independent repair checkout: immutable committed source', () => {
  it('returns exact UTF-8 Git bytes and independently calculated bindings', async () => {
    const result = await collect();
    expect(result.baseCommit).toBe(baseCommit);
    expect(result.repository).toBe(repository);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: sourcePath, role: 'source' });
    expect(Buffer.from(result.files[0]!.bytes)).toEqual(source);
    expect(result.bindings).toEqual([{ path: sourcePath, sha256: hash(source), size: source.length }]);
  });

  it('ignores staged, unstaged and untracked working changes without overwriting them', async () => {
    put(sourcePath, 'synthetic staged source\n');
    git(['add', sourcePath]);
    put(sourcePath, 'synthetic unstaged source\n');
    put('src/untracked.ts', 'synthetic untracked source\n');
    const before = treeSnapshot();
    const status = git(['status', '--porcelain=v1']).toString();
    const result = await collect();
    expect(Buffer.from(result.files[0]!.bytes)).toEqual(source);
    expect(treeSnapshot()).toEqual(before);
    expect(git(['status', '--porcelain=v1']).toString()).toBe(status);
  });

  it('reads the selected historical commit instead of current HEAD', async () => {
    put(sourcePath, 'export const revision = "later";\n');
    const laterCommit = commit();
    expect(laterCommit).not.toBe(baseCommit);
    expect(Buffer.from((await collect()).files[0]!.bytes)).toEqual(source);
    expect(Buffer.from((await collect({ baseCommit: laterCommit })).files[0]!.bytes)).toEqual(Buffer.from('export const revision = "later";\n'));
    expect(git(['rev-parse', 'HEAD']).toString().trim()).toBe(laterCommit);
  });

  it('reads committed source even when its working file was deleted or replaced by a symlink', async () => {
    rmSync(join(repositoryRoot, sourcePath));
    expect(Buffer.from((await collect()).files[0]!.bytes)).toEqual(source);
    const outside = join(directory, 'outside.ts');
    writeFileSync(outside, 'outside synthetic data');
    symlinkSync(outside, join(repositoryRoot, sourcePath));
    const before = treeSnapshot();
    expect(Buffer.from((await collect()).files[0]!.bytes)).toEqual(source);
    expect(treeSnapshot()).toEqual(before);
    expect(readFileSync(outside, 'utf8')).toBe('outside synthetic data');
  });

  it('does not share mutable returned buffers between collections', async () => {
    const first = await collect();
    first.files[0]!.bytes[0] = 0;
    expect(Buffer.from((await collect()).files[0]!.bytes)).toEqual(source);
  });

  it('returns only explicitly selected files with bindings to their actual contents', async () => {
    const result = await collect({ paths: [otherPath, sourcePath] });
    expect(new Set(result.files.map((file) => file.path))).toEqual(new Set([sourcePath, otherPath]));
    expect(result.files).toHaveLength(2);
    for (const file of result.files) {
      expect(file.role).toBe('source');
      const expected = file.path === sourcePath ? source : Buffer.from('export const syntheticExport = true;\n');
      expect(Buffer.from(file.bytes)).toEqual(expected);
      expect(result.bindings.find((binding) => binding.path === file.path)).toEqual({ path: file.path, sha256: hash(expected), size: expected.length });
    }
    expect(result.bindings).toHaveLength(2);
  });
});

describe('independent repair checkout: exact provenance and source path policy', () => {
  it.each([
    `https://github.com/${repository}`, `https://github.com/${repository}.git`, `git@github.com:${repository}.git`,
  ])('accepts the documented exact origin form %s', async (origin) => {
    git(['remote', 'set-url', 'origin', origin]);
    expect(Buffer.from((await collect()).files[0]!.bytes)).toEqual(source);
  });

  it.each([
    'https://github.com/other-owner/synthetic-repair-fixture.git',
    'https://github.com/synthetic-owner/other-repo.git',
    'https://example.invalid/synthetic-owner/synthetic-repair-fixture.git',
    'https://github.com.example.invalid/synthetic-owner/synthetic-repair-fixture.git',
    `ssh://git@github.com/${repository}.git`, `git@github.com:${repository}`,
    `https://github.com/${repository}.git/`, `https://github.com/${repository}.git?ref=main`,
    '/tmp/synthetic-repository',
  ])('rejects unapproved origin %s without modifying the repository', async (origin) => {
    git(['remote', 'set-url', 'origin', origin]);
    const before = treeSnapshot();
    await rejected(() => collect());
    expect(treeSnapshot()).toEqual(before);
  });

  it('rejects a missing origin', async () => {
    git(['remote', 'remove', 'origin']);
    await rejected(() => collect());
  });

  it.each(['', 'HEAD', 'main', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), '0'.repeat(40)])('rejects nonexact or unavailable commit %s', async (commitId) => {
    const before = treeSnapshot();
    await rejected(() => collect({ baseCommit: commitId }));
    expect(treeSnapshot()).toEqual(before);
  });

  it('rejects a lowercase full Git blob ID when a commit is required', async () => {
    const blob = git(['rev-parse', `${baseCommit}:${sourcePath}`]).toString().trim();
    expect(blob).toMatch(/^[a-f0-9]{40}$/);
    await rejected(() => collect({ baseCommit: blob }));
    const tree = git(['rev-parse', `${baseCommit}^{tree}`]).toString().trim();
    await rejected(() => collect({ baseCommit: tree }));
  });

  it.each([
    '../outside.ts', '/tmp/outside.ts', 'src\\billing\\webhook.ts', 'src/../billing.ts', 'src/./billing.ts',
    'src/invalid\0.ts', 'src/invalid\n.ts', '.git/config',
  ])('rejects an invalid requested path %s', async (path) => {
    await rejected(() => collect({ paths: [path] }));
  });

  it.each([
    'tests/case.ts', 'src/TEST/helper.ts', 'src/__tests__/case.ts',
    'packages/core/policy.ts', 'src/oracle/access.ts', '.github/workflows/build.yml',
    'src/.env.local', 'src/auth.config.ts', 'src/oauth-config.ts', 'src/security.config.ts',
    'src/billing.test.ts', 'src/billing.spec.ts', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
    'node_modules/synthetic/index.js', 'vitest.config.ts', 'playwright.config.ts',
  ])('rejects a protected path even when a regular UTF-8 blob is committed at %s', async (path) => {
    put(path, 'synthetic protected fixture data\n');
    baseCommit = commit();
    await rejected(() => collect({ paths: [path] }));
  });

  it('rejects duplicate, case-colliding and ancestor-conflicting source paths', async () => {
    await rejected(() => collect({ paths: [sourcePath, sourcePath] }));
    await rejected(() => collect({ paths: [sourcePath, sourcePath.toUpperCase()] }));
    await rejected(() => collect({ paths: ['src', sourcePath] }));
  });

  it('rejects empty selection, missing paths and directories', async () => {
    await rejected(() => collect({ paths: [] }));
    await rejected(() => collect({ paths: ['src/missing.ts'] }));
    await rejected(() => collect({ paths: ['src/billing'] }));
  });

  it('permits a nonexecutable .sh source and an authentication implementation filename', async () => {
    put('src/migration.sh', 'synthetic nonexecutable source\n');
    put('src/authentication.ts', 'export const synthetic = true;\n');
    baseCommit = commit();
    const result = await collect({ paths: ['src/migration.sh', 'src/authentication.ts'] });
    expect(result.files).toHaveLength(2);
  });
});

describe('independent repair checkout: committed modes, encoding and size', () => {
  it('rejects a committed symlink even when its target is valid UTF-8', async () => {
    symlinkSync('webhook.ts', join(repositoryRoot, 'src/billing/link.ts'));
    baseCommit = commit();
    await rejected(() => collect({ paths: ['src/billing/link.ts'] }));
  });

  it('rejects a committed executable even after its working mode becomes ordinary', async () => {
    chmodSync(join(repositoryRoot, sourcePath), 0o755);
    baseCommit = commit();
    chmodSync(join(repositoryRoot, sourcePath), 0o644);
    await rejected(() => collect());
  });

  it('rejects a committed gitlink without accessing a submodule remote', async () => {
    git(['update-index', '--add', '--cacheinfo', `160000,${baseCommit},src/submodule`]);
    git(['commit', '--quiet', '-m', 'Synthetic gitlink fixture']);
    baseCommit = git(['rev-parse', 'HEAD']).toString().trim();
    await rejected(() => collect({ paths: ['src/submodule'] }));
  });

  it.each([
    Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x41, 0x00]),
    Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf0, 0x9f]),
    Buffer.from('valid UTF-8 surrounding\0binary marker'),
  ])('rejects an invalid UTF-8 or NUL-containing committed blob %#', async (bytes) => {
    put(sourcePath, bytes);
    baseCommit = commit();
    await rejected(() => collect());
  });

  it('accepts an empty committed UTF-8 source file', async () => {
    put(sourcePath, '');
    baseCommit = commit();
    const result = await collect();
    expect(result.files[0]!.bytes.byteLength).toBe(0);
    expect(result.bindings).toEqual([{ path: sourcePath, sha256: hash(Buffer.alloc(0)), size: 0 }]);
  });

  it('accepts exactly one MiB and rejects one byte more without changing either checkout', async () => {
    const atLimit = Buffer.alloc(1024 * 1024, 0x61);
    put(sourcePath, atLimit);
    baseCommit = commit();
    const before = treeSnapshot();
    const result = await collect();
    expect(Buffer.from(result.files[0]!.bytes)).toEqual(atLimit);
    expect(result.bindings).toEqual([{ path: sourcePath, sha256: hash(atLimit), size: atLimit.length }]);
    expect(treeSnapshot()).toEqual(before);
    put(sourcePath, Buffer.alloc(atLimit.length + 1, 0x61));
    baseCommit = commit();
    const oversized = treeSnapshot();
    await rejected(() => collect());
    expect(treeSnapshot()).toEqual(oversized);
  });
});

function installFixture(
  name: string,
  options: {
    version?: string;
    extraMetadata?: Record<string, unknown>;
    files?: Record<string, string | Uint8Array>;
    modulesRoot?: string;
  } = {},
) {
  const packageDirectory = join(options.modulesRoot ?? join(repositoryRoot, 'node_modules'), name);
  mkdirSync(packageDirectory, { recursive: true });
  const packageMetadata = { name, version: options.version ?? '1.0.0', ...options.extraMetadata };
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify(packageMetadata));
  for (const [path, bytes] of Object.entries(options.files ?? { 'index.js': 'export const synthetic = true;\n' })) {
    const destination = join(packageDirectory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  return packageDirectory;
}

function dependencyFileMap(result: Awaited<ReturnType<typeof collectRepairDependencies>>) {
  return new Map(result.files.map((file) => [file.path, Buffer.from(file.bytes)]));
}

describe('independent repair checkout: installed dependency bytes and provenance', () => {
  it('packages exact JavaScript, declarations, metadata and native bytes without writes', async () => {
    const fixtureFiles = {
      'index.js': Buffer.from('export const synthetic = "unchanged";\r\n'),
      'index.d.ts': Buffer.from('export declare const synthetic: string;\n'),
      'build/addon.node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 255, 128]),
    };
    const packageDirectory = installFixture('synthetic-package', { files: fixtureFiles });
    const before = treeSnapshot();
    const result = await collectRepairDependencies(repositoryRoot, ['synthetic-package']);
    const entries = dependencyFileMap(result);
    expect(result.files).toHaveLength(4);
    expect(result.versions).toEqual([{ name: 'synthetic-package', version: '1.0.0', destination: 'node_modules/synthetic-package' }]);
    for (const [path, bytes] of Object.entries(fixtureFiles)) expect(entries.get(`node_modules/synthetic-package/${path}`)).toEqual(bytes);
    expect(entries.get('node_modules/synthetic-package/package.json')).toEqual(readFileSync(join(packageDirectory, 'package.json')));
    expect(result.totalBytes).toBe(result.files.reduce((sum, file) => sum + file.bytes.byteLength, 0));
    for (const file of result.files) expect(file.role).toBe('dependency');
    expect(treeSnapshot()).toEqual(before);
  });

  it('excludes documented development-only directories, hidden entries, maps and Markdown', async () => {
    const files: Record<string, string> = {
      'index.js': 'synthetic runtime', 'index.d.ts': 'synthetic declarations',
      'index.js.map': 'synthetic source map', 'README.md': 'synthetic documentation',
      '.private': 'synthetic hidden file', '.hidden/index.js': 'synthetic hidden directory',
    };
    for (const name of ['tests', 'test', '__tests__', 'docs', 'examples', 'coverage', 'benchmark', 'benchmarks']) {
      files[`${name}/fixture.js`] = 'synthetic excluded file';
      files[`lib/${name}/fixture.js`] = 'synthetic excluded nested file';
    }
    installFixture('synthetic-package', { files });
    const result = await collectRepairDependencies(repositoryRoot, ['synthetic-package']);
    expect(new Set(result.files.map((file) => file.path))).toEqual(new Set([
      'node_modules/synthetic-package/package.json', 'node_modules/synthetic-package/index.js', 'node_modules/synthetic-package/index.d.ts',
    ]));
    expect(result.totalBytes).toBe(result.files.reduce((sum, file) => sum + file.bytes.byteLength, 0));
  });

  it('collects only the explicit top-level selections and their dependencies', async () => {
    installFixture('synthetic-selected');
    installFixture('synthetic-unselected');
    const result = await collectRepairDependencies(repositoryRoot, ['synthetic-selected']);
    expect(result.versions).toEqual([{ name: 'synthetic-selected', version: '1.0.0', destination: 'node_modules/synthetic-selected' }]);
    expect(result.files.every((file) => file.path.startsWith('node_modules/synthetic-selected/'))).toBe(true);
  });

  it('uses the documented default top-level package names without an install', async () => {
    const names = ['next', 'react', 'react-dom', 'hono', 'zod', 'stripe', 'better-sqlite3', 'typescript', '@types/react', '@types/node'];
    for (const name of names) installFixture(name);
    const before = treeSnapshot();
    const result = await collectRepairDependencies(repositoryRoot);
    expect(new Set(result.versions.map((entry) => entry.name))).toEqual(new Set(names));
    expect(result.versions).toHaveLength(names.length);
    for (const name of names) expect(result.versions).toContainEqual({ name, version: '1.0.0', destination: `node_modules/${name}` });
    expect(treeSnapshot()).toEqual(before);
  });

  it('preserves separately resolved nested versions instead of flattening them', async () => {
    const alpha = installFixture('synthetic-alpha', { extraMetadata: { dependencies: { 'synthetic-shared': '1.0.0' } } });
    const beta = installFixture('synthetic-beta', { extraMetadata: { dependencies: { 'synthetic-shared': '2.0.0' } } });
    installFixture('synthetic-shared', { modulesRoot: join(alpha, 'node_modules'), version: '1.0.0', files: { 'index.js': 'synthetic version one' } });
    installFixture('synthetic-shared', { modulesRoot: join(beta, 'node_modules'), version: '2.0.0', files: { 'index.js': 'synthetic version two' } });
    const result = await collectRepairDependencies(repositoryRoot, ['synthetic-alpha', 'synthetic-beta']);
    expect(result.versions).toHaveLength(4);
    expect(result.files).toHaveLength(8);
    expect(new Set(result.files.map((file) => file.path)).size).toBe(8);
    expect(result.versions).toContainEqual({ name: 'synthetic-shared', version: '1.0.0', destination: 'node_modules/synthetic-alpha/node_modules/synthetic-shared' });
    expect(result.versions).toContainEqual({ name: 'synthetic-shared', version: '2.0.0', destination: 'node_modules/synthetic-beta/node_modules/synthetic-shared' });
    const files = dependencyFileMap(result);
    expect(files.get('node_modules/synthetic-alpha/node_modules/synthetic-shared/index.js')).toEqual(Buffer.from('synthetic version one'));
    expect(files.get('node_modules/synthetic-beta/node_modules/synthetic-shared/index.js')).toEqual(Buffer.from('synthetic version two'));
  });

  it('resolves a hoisted required package but records its nested extraction destination', async () => {
    installFixture('synthetic-parent', { extraMetadata: { dependencies: { 'synthetic-child': '1.0.0' } } });
    installFixture('synthetic-child');
    const result = await collectRepairDependencies(repositoryRoot, ['synthetic-parent']);
    expect(result.versions).toContainEqual({ name: 'synthetic-child', version: '1.0.0', destination: 'node_modules/synthetic-parent/node_modules/synthetic-child' });
    expect(dependencyFileMap(result).has('node_modules/synthetic-parent/node_modules/synthetic-child/package.json')).toBe(true);
  });

  it('terminates an exact-version ancestor cycle without duplicating the ancestor', async () => {
    const alpha = installFixture('synthetic-alpha', { extraMetadata: { dependencies: { 'synthetic-beta': '1.0.0' } } });
    installFixture('synthetic-beta', { modulesRoot: join(alpha, 'node_modules'), extraMetadata: { dependencies: { 'synthetic-alpha': '1.0.0' } } });
    const result = await collectRepairDependencies(repositoryRoot, ['synthetic-alpha']);
    expect(result.versions).toHaveLength(2);
    expect(result.files).toHaveLength(4);
    expect(result.versions).toContainEqual({ name: 'synthetic-alpha', version: '1.0.0', destination: 'node_modules/synthetic-alpha' });
    expect(result.versions).toContainEqual({ name: 'synthetic-beta', version: '1.0.0', destination: 'node_modules/synthetic-alpha/node_modules/synthetic-beta' });
  });

  it('does not collapse a same-name dependency with a different version into an ancestor', async () => {
    const alpha = installFixture('synthetic-alpha', { extraMetadata: { dependencies: { 'synthetic-beta': '1.0.0' } } });
    const beta = installFixture('synthetic-beta', { modulesRoot: join(alpha, 'node_modules'), extraMetadata: { dependencies: { 'synthetic-alpha': '2.0.0' } } });
    installFixture('synthetic-alpha', { version: '2.0.0', modulesRoot: join(beta, 'node_modules') });
    const result = await collectRepairDependencies(repositoryRoot, ['synthetic-alpha']);
    expect(result.versions).toHaveLength(3);
    expect(result.versions).toContainEqual({ name: 'synthetic-alpha', version: '2.0.0', destination: 'node_modules/synthetic-alpha/node_modules/synthetic-beta/node_modules/synthetic-alpha' });
  });

  it('includes installed optional dependencies and permits absent optional dependencies', async () => {
    installFixture('synthetic-parent', { extraMetadata: { optionalDependencies: { 'synthetic-present': '1.0.0', 'synthetic-absent': '1.0.0' } } });
    installFixture('synthetic-present');
    const result = await collectRepairDependencies(repositoryRoot, ['synthetic-parent']);
    expect(result.versions).toHaveLength(2);
    expect(result.versions).toContainEqual({ name: 'synthetic-present', version: '1.0.0', destination: 'node_modules/synthetic-parent/node_modules/synthetic-present' });
  });

  it('fails for missing required packages without trying to install or changing files', async () => {
    installFixture('synthetic-parent', { extraMetadata: { dependencies: { 'synthetic-missing': '1.0.0' } } });
    const before = treeSnapshot();
    await rejected(() => collectRepairDependencies(repositoryRoot, ['synthetic-parent']));
    await rejected(() => collectRepairDependencies(repositoryRoot, ['synthetic-absent-top-level']));
    expect(treeSnapshot()).toEqual(before);
  });

  it('returns fresh dependency bytes without mutating installed files', async () => {
    installFixture('synthetic-package');
    const before = treeSnapshot();
    const first = await collectRepairDependencies(repositoryRoot, ['synthetic-package']);
    const original = Buffer.from(first.files[0]!.bytes);
    first.files[0]!.bytes[0] = (first.files[0]!.bytes[0] ?? 0) ^ 1;
    const second = await collectRepairDependencies(repositoryRoot, ['synthetic-package']);
    expect(Buffer.from(second.files.find((file) => file.path === first.files[0]!.path)!.bytes)).toEqual(original);
    expect(treeSnapshot()).toEqual(before);
  });
});

describe('independent repair checkout: package containment and bounded extraction', () => {
  it('permits a package link into a pnpm-style store within the real node_modules root', async () => {
    const modulesRoot = join(repositoryRoot, 'node_modules');
    const packageDirectory = installFixture('synthetic-package', { modulesRoot: join(modulesRoot, '.pnpm/synthetic-package@1.0.0/node_modules') });
    symlinkSync(relative(modulesRoot, packageDirectory), join(modulesRoot, 'synthetic-package'));
    const result = await collectRepairDependencies(repositoryRoot, ['synthetic-package']);
    expect(result.versions).toEqual([{ name: 'synthetic-package', version: '1.0.0', destination: 'node_modules/synthetic-package' }]);
    expect(result.files).toHaveLength(2);
    expect(result.files.every((file) => file.path.startsWith('node_modules/synthetic-package/'))).toBe(true);
  });

  it('rejects a package link escaping the real node_modules root', async () => {
    const modulesRoot = join(repositoryRoot, 'node_modules');
    mkdirSync(modulesRoot);
    const outside = installFixture('synthetic-package', { modulesRoot: join(directory, 'outside-packages') });
    symlinkSync(outside, join(modulesRoot, 'synthetic-package'));
    await rejected(() => collectRepairDependencies(repositoryRoot, ['synthetic-package']));
  });

  it('rejects an installed optional package escape instead of treating it as absent', async () => {
    installFixture('synthetic-parent', { extraMetadata: { optionalDependencies: { 'synthetic-optional': '1.0.0' } } });
    const outside = installFixture('synthetic-optional', { modulesRoot: join(directory, 'outside-packages') });
    symlinkSync(outside, join(repositoryRoot, 'node_modules/synthetic-optional'));
    await rejected(() => collectRepairDependencies(repositoryRoot, ['synthetic-parent']));
  });

  it.each(['file', 'directory'])('rejects a package-internal %s symlink even when it stays inside the package', async (kind) => {
    const packageDirectory = installFixture('synthetic-package', { files: { 'lib/index.js': 'synthetic local data' } });
    symlinkSync(kind === 'file' ? 'lib/index.js' : 'lib', join(packageDirectory, kind === 'file' ? 'alias.js' : 'alias'));
    await rejected(() => collectRepairDependencies(repositoryRoot, ['synthetic-package']));
  });

  it('rejects an internal link to private bytes outside the package', async () => {
    const packageDirectory = installFixture('synthetic-package');
    const outside = join(directory, 'private-fixture');
    writeFileSync(outside, 'SYNTHETIC_PRIVATE_DEPENDENCY_DATA');
    symlinkSync(outside, join(packageDirectory, 'leak.js'));
    await rejected(() => collectRepairDependencies(repositoryRoot, ['synthetic-package']));
  });

  it('rejects a sparse dependency file exceeding the aggregate byte cap', async () => {
    const packageDirectory = installFixture('synthetic-package', { files: { 'oversized.node': '' } });
    truncateSync(join(packageDirectory, 'oversized.node'), 512 * 1024 * 1024 + 1);
    await rejected(() => collectRepairDependencies(repositoryRoot, ['synthetic-package']));
  }, 20_000);

  it('accepts exactly 20,000 extracted files and rejects an additional file', async () => {
    const packageDirectory = installFixture('synthetic-package', { files: {} });
    for (let index = 0; index < 19_999; index += 1) writeFileSync(join(packageDirectory, `fixture-${index}.js`), 'x');
    const accepted = await collectRepairDependencies(repositoryRoot, ['synthetic-package']);
    expect(accepted.files).toHaveLength(20_000);
    expect(accepted.totalBytes).toBe(19_999 + readFileSync(join(packageDirectory, 'package.json')).byteLength);
    writeFileSync(join(packageDirectory, 'one-too-many.js'), 'x');
    await rejected(() => collectRepairDependencies(repositoryRoot, ['synthetic-package']));
  }, 20_000);
});
