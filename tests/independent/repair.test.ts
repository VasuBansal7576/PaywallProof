import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { openRepairStore, patchHash, repairBranch, validateRepairPaths } from '#repair';
import { createRepairReplayPlan, replayPayload } from '#repair/oracle';
import { createPolicy } from '#domain';
import { EvidenceStore } from '#evidence';

// Independent store/filesystem tests. Verification receipts are synthetic inputs,
// not proof of a sandbox execution. No provider, push, PR, or test runner is called.

type RepairStore = Awaited<ReturnType<typeof openRepairStore>>;
type RepairRecord = Awaited<ReturnType<RepairStore['get']>>;
const repository = 'synthetic-owner/paywallproof';
const webhookPath = 'src/billing/webhook.ts';
const exportPath = 'src/features/export.ts';
const editablePaths = [webhookPath, exportPath];
const baseCommit = 'a'.repeat(40);
const policyHash = 'b'.repeat(64);
const oracleHash = 'c'.repeat(64);
const failureCode = 'CANCELED_USER_RETAINS_ACCESS';
const initialTime = 1_800_000_000_000;
const expiryInterval = 15 * 60 * 1_000;
let now: number;
let directory: string;
let databasePath: string;
const stores = new Set<RepairStore>();

async function open(overrides: Record<string, unknown> = {}) {
  const store = await openRepairStore({
    path: databasePath,
    repository,
    allowedPaths: editablePaths,
    clock: () => now,
    ...overrides,
  });
  stores.add(store);
  return store;
}

async function close(store: RepairStore) {
  await store.close();
  stores.delete(store);
}

function changes() {
  return [{ path: webhookPath, content: 'export const syntheticRepair = true;\n' }];
}

function proposalInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run_owned',
    findingId: 'finding_owned',
    attempt: 1,
    baseCommit,
    baseBranch: 'main',
    repository,
    branch: repairBranch('run_owned', 'finding_owned', 1),
    policyHash,
    oracleHash,
    allowedPaths: editablePaths,
    changes: changes(),
    diffHash: patchHash(changes()),
    verificationMode: 'local_replay',
    failureCode,
    summary: 'Synthetic cancellation repair candidate',
    reportUrl: 'https://reports.example.invalid/run_owned',
    ...overrides,
  };
}

async function expectRejected(action: () => unknown, code?: string) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code: code ?? expect.stringMatching(/\S/) });
}

function mutate(record: unknown, changes: object) {
  if (typeof record === 'object' && record !== null) {
    try {
      Object.assign(record, changes);
    } catch {
      /* Frozen output also prevents mutation. */
    }
  }
}

function receipt(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    executionId: `synthetic_execution_${id}`,
    checkId: 'SC04',
    oracleHash,
    policyHash,
    baseCommit,
    diffHash: patchHash(changes()),
    artifactHash: 'd'.repeat(64),
    observedAt: now,
    exitCode: 0,
    outcome: 'pass',
    failureCode: null,
    ...overrides,
  };
}

function verification(proposalId: string) {
  return {
    proposalId,
    before: receipt(`${proposalId}_before`, {
      outcome: 'fail',
      exitCode: 1,
      failureCode,
      diffHash: null,
      observedAt: now - 50,
    }),
    after: receipt(`${proposalId}_after`, { observedAt: now - 25 }),
    regressions: ['SC01', 'SC02', 'SC03', 'SC04'].map((checkId) =>
      receipt(`${proposalId}_regression_${checkId}`, { checkId }),
    ),
  };
}

async function proposedForVerification(
  store: RepairStore,
  overrides: Record<string, unknown> = {},
) {
  const proposal = await store.propose(proposalInput(overrides));
  now += 100;
  return proposal;
}

async function verified(store: RepairStore, overrides: Record<string, unknown> = {}) {
  const proposal = await proposedForVerification(store, overrides);
  await store.recordVerification(verification(proposal.id));
  return store.get(proposal.id);
}

function publicationDecision(record: RepairRecord, overrides: Record<string, unknown> = {}) {
  if (!record.approval) throw new Error('Expected publication approval in public record');
  return {
    proposalId: record.id,
    approvalId: record.approval.id,
    bindingHash: record.approval.bindingHash,
    decision: 'allow',
    ...overrides,
  };
}

async function publicationRequested(store: RepairStore) {
  const record = await verified(store);
  return store.requestPublication({
    proposalId: record.id,
    title: 'Synthetic repair',
    body: 'Synthetic publication preamble.',
  });
}

beforeEach(() => {
  now = initialTime;
  directory = mkdtempSync(join(tmpdir(), 'paywallproof-independent-repair-'));
  databasePath = join(directory, 'repair.sqlite');
});

afterEach(async () => {
  for (const store of stores) await close(store);
  rmSync(directory, { recursive: true, force: true });
});

describe('independent repair: canonical changes and strict proposals', () => {
  it('hashes changes by canonical path order and binds their content', () => {
    const first = { path: webhookPath, content: 'first\n' };
    const second = { path: exportPath, content: 'second\n' };
    expect(patchHash([first, second])).toMatch(/^[a-f0-9]{64}$/);
    expect(patchHash([first, second])).toBe(patchHash([second, first]));
    expect(patchHash([first, second])).not.toBe(
      patchHash([first, { ...second, content: 'changed\n' }]),
    );
    expect(patchHash([first])).not.toBe(patchHash([{ ...first, content: null }]));
  });

  it('creates deterministic repair branches that distinguish attempts', () => {
    expect(repairBranch('run_owned', 'finding_owned', 1)).toBe(
      repairBranch('run_owned', 'finding_owned', 1),
    );
    expect(repairBranch('run_owned', 'finding_owned', 1)).not.toBe(
      repairBranch('run_owned', 'finding_owned', 2),
    );
    expect(repairBranch('run_owned', 'finding_owned', 1)).not.toBe(
      repairBranch('run_other', 'finding_owned', 1),
    );
  });

  it('starts proposed without claiming supplied changes were executed', async () => {
    const store = await open();
    const proposal = await store.propose(proposalInput());
    expect(proposal).toMatchObject({ id: expect.any(String), state: 'proposed' });
    await expectRejected(() =>
      store.requestPublication({
        proposalId: proposal.id,
        title: 'Synthetic repair',
        body: 'No verification yet.',
      }),
    );
    expect((await store.get(proposal.id)).state).toBe('proposed');
  });

  it('retains identical proposals and detached state across restart', async () => {
    const store = await open();
    const input = proposalInput();
    const first = await store.propose(input);
    expect(await store.propose(input)).toEqual(first);
    const persisted = JSON.stringify(await store.get(first.id));
    mutate(first, { state: 'published', diffHash: '0'.repeat(64) });
    expect(JSON.stringify(await store.get(first.id))).toBe(persisted);
    await close(store);
    const reopened = await open();
    expect(JSON.stringify(await reopened.propose(input))).toBe(persisted);
  });

  it('rejects any changed input for the same run/finding attempt', async () => {
    const store = await open();
    await store.propose(proposalInput());
    await expectRejected(
      () => store.propose(proposalInput({ summary: 'Changed summary' })),
      'REPAIR_CONFLICT',
    );
  });

  it('requires attempt one before attempt two and rejects a third attempt', async () => {
    const store = await open();
    const secondInput = proposalInput({
      attempt: 2,
      branch: repairBranch('run_owned', 'finding_owned', 2),
    });
    await expectRejected(() => store.propose(secondInput));
    const first = await store.propose(proposalInput());
    const second = await store.propose(secondInput);
    expect(second.id).not.toBe(first.id);
    await expectRejected(() => store.propose(proposalInput({ attempt: 3 })));
  });

  it('isolates list results by run', async () => {
    const store = await open();
    const owned = await store.propose(proposalInput());
    await store.propose(
      proposalInput({ runId: 'run_other', branch: repairBranch('run_other', 'finding_owned', 1) }),
    );
    expect((await store.list('run_owned')).map((proposal) => proposal.id)).toEqual([owned.id]);
  });

  it.each<[string, unknown]>([
    ['attempt', 0],
    ['attempt', 1.5],
    ['attempt', '1'],
    ['baseCommit', 'A'.repeat(40)],
    ['baseCommit', 'a'.repeat(39)],
    ['policyHash', 'B'.repeat(64)],
    ['oracleHash', 'not-a-hash'],
    ['diffHash', '0'.repeat(64)],
    ['branch', 'unapproved-branch'],
    ['repository', 'foreign-owner/repo'],
    ['verificationMode', 'production'],
    ['extra', true],
  ])('rejects invalid or unbound proposal field %s', async (field, value) => {
    const store = await open();
    await expectRejected(() => store.propose(proposalInput({ [field]: value })));
    expect(await store.list('run_owned')).toEqual([]);
  });

  it('rejects changes outside either exact allowlist', async () => {
    const store = await open();
    const outside = [{ path: 'src/other.ts', content: 'unapproved' }];
    await expectRejected(() =>
      store.propose(
        proposalInput({
          allowedPaths: [...editablePaths, 'src/other.ts'],
          changes: outside,
          diffHash: patchHash(outside),
        }),
      ),
    );
    await expectRejected(() => store.propose(proposalInput({ allowedPaths: [exportPath] })));
  });

  it('rejects unknown change fields and duplicate paths', async () => {
    const store = await open();
    await expectRejected(() =>
      store.propose(proposalInput({ changes: [{ ...changes()[0], executable: true }] })),
    );
    await expectRejected(() =>
      store.propose(proposalInput({ changes: [...changes(), ...changes()] })),
    );
  });

  it('rejects case-colliding and file/descendant change sets', async () => {
    await expectRejected(() =>
      patchHash([
        { path: 'src/file.ts', content: 'one' },
        { path: 'SRC/FILE.ts', content: 'two' },
      ]),
    );
    await expectRejected(() =>
      patchHash([
        { path: 'src/file', content: 'one' },
        { path: 'src/file/child.ts', content: 'two' },
      ]),
    );
  });

  it.each([
    '',
    '../escape.ts',
    '/absolute.ts',
    'src/../escape.ts',
    'src\\escape.ts',
    'src/file\n.ts',
    'src/file\0.ts',
  ])('rejects unsafe change path %s', async (path) => {
    const store = await open();
    await expectRejected(() =>
      store.propose(proposalInput({ changes: [{ path, content: 'untrusted' }] })),
    );
    await expectRejected(() =>
      validateRepairPaths({ checkoutRoot: directory, paths: [path], allowedPaths: [path] }),
    );
  });
});

describe('independent repair: actual filesystem path safety', () => {
  it('accepts an exact regular file and a missing final file for addition', async () => {
    const checkoutRoot = join(directory, 'checkout');
    mkdirSync(join(checkoutRoot, 'src', 'billing'), { recursive: true });
    writeFileSync(join(checkoutRoot, 'src', 'billing', 'webhook.ts'), 'original');
    await validateRepairPaths({
      checkoutRoot,
      paths: ['src/billing/webhook.ts', 'src/billing/new.ts'],
      allowedPaths: ['src/billing/webhook.ts', 'src/billing/new.ts'],
    });
  });

  it('rejects a final symlink even when its path is allowlisted', async () => {
    const checkoutRoot = join(directory, 'checkout');
    const outside = join(directory, 'outside.ts');
    mkdirSync(join(checkoutRoot, 'src'), { recursive: true });
    writeFileSync(outside, 'outside fixture');
    symlinkSync(outside, join(checkoutRoot, 'src', 'linked.ts'));
    await expectRejected(() =>
      validateRepairPaths({
        checkoutRoot,
        paths: ['src/linked.ts'],
        allowedPaths: ['src/linked.ts'],
      }),
    );
  });

  it('rejects an intermediate symlink before reaching a missing final file', async () => {
    const checkoutRoot = join(directory, 'checkout');
    const outside = join(directory, 'outside');
    mkdirSync(checkoutRoot);
    mkdirSync(outside);
    symlinkSync(outside, join(checkoutRoot, 'src'));
    await expectRejected(() =>
      validateRepairPaths({ checkoutRoot, paths: ['src/new.ts'], allowedPaths: ['src/new.ts'] }),
    );
  });

  it('rejects a symlink used as the checkout root', async () => {
    const realRoot = join(directory, 'real-checkout');
    const checkoutRoot = join(directory, 'linked-checkout');
    mkdirSync(join(realRoot, 'src'), { recursive: true });
    writeFileSync(join(realRoot, 'src', 'file.ts'), 'synthetic');
    symlinkSync(realRoot, checkoutRoot);
    await expectRejected(() =>
      validateRepairPaths({ checkoutRoot, paths: ['src/file.ts'], allowedPaths: ['src/file.ts'] }),
    );
  });

  it('rejects a nondirectory parent component', async () => {
    const checkoutRoot = join(directory, 'checkout');
    mkdirSync(checkoutRoot);
    writeFileSync(join(checkoutRoot, 'src'), 'not a directory');
    await expectRejected(() =>
      validateRepairPaths({ checkoutRoot, paths: ['src/file.ts'], allowedPaths: ['src/file.ts'] }),
    );
  });

  it('rejects a directory as a file change', async () => {
    const checkoutRoot = join(directory, 'checkout');
    mkdirSync(join(checkoutRoot, 'src'), { recursive: true });
    await expectRejected(() =>
      validateRepairPaths({ checkoutRoot, paths: ['src'], allowedPaths: ['src'] }),
    );
  });

  it('does not treat a glob allowlist as permission for an arbitrary file', async () => {
    const checkoutRoot = join(directory, 'checkout');
    mkdirSync(join(checkoutRoot, 'src'), { recursive: true });
    await expectRejected(() =>
      validateRepairPaths({ checkoutRoot, paths: ['src/file.ts'], allowedPaths: ['src/*'] }),
    );
  });

  it('rejects an executable-mode file and accepts nonexecutable source regardless of extension', async () => {
    const checkoutRoot = join(directory, 'checkout');
    mkdirSync(join(checkoutRoot, 'src'), { recursive: true });
    const executable = join(checkoutRoot, 'src', 'executable.ts');
    writeFileSync(executable, 'synthetic');
    chmodSync(executable, 0o755);
    await expectRejected(() =>
      validateRepairPaths({
        checkoutRoot,
        paths: ['src/executable.ts'],
        allowedPaths: ['src/executable.ts'],
      }),
    );
    const nonexecutable = join(checkoutRoot, 'src', 'ordinary.sh');
    writeFileSync(nonexecutable, 'synthetic');
    chmodSync(nonexecutable, 0o644);
    await validateRepairPaths({
      checkoutRoot,
      paths: ['src/ordinary.sh'],
      allowedPaths: ['src/ordinary.sh'],
    });
  });

  it.each([
    '.git/config',
    '.github/workflows/ci.yml',
    '.gitlab/pipeline.yml',
    '.circleci/config.yml',
    '.codex/config.toml',
    '.agents/config.json',
    'node_modules/pkg/index.js',
    'tests/repair.test.ts',
    'src/__tests__/guard.ts',
    'packages/core/index.ts',
    'src/oracle/policy.ts',
    '.env',
    '.env.local',
    'src/handler.test.ts',
    'src/handler.spec.ts',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lockb',
    '.npmrc',
    '.gitmodules',
    'Jenkinsfile',
    'vitest.config.ts',
    'playwright.config.ts',
    'auth.config.ts',
    'oauth-config.json',
    'src/security.config.ts',
    'TESTS/guard.ts',
    'src/CORE/policy.ts',
    '.ENV.production',
  ])('rejects protected path %s even if it was accidentally allowlisted', async (path) => {
    const checkoutRoot = join(directory, 'checkout');
    mkdirSync(dirname(join(checkoutRoot, path)), { recursive: true });
    writeFileSync(join(checkoutRoot, path), 'synthetic protected source');
    await expectRejected(() =>
      validateRepairPaths({ checkoutRoot, paths: [path], allowedPaths: [path] }),
    );
  });

  it('does not classify authentication implementation as auth configuration by name alone', async () => {
    const checkoutRoot = join(directory, 'checkout');
    mkdirSync(join(checkoutRoot, 'src'), { recursive: true });
    await validateRepairPaths({
      checkoutRoot,
      paths: ['src/authentication.ts'],
      allowedPaths: ['src/authentication.ts'],
    });
  });
});

describe('independent repair: verification receipt binding', () => {
  it.each<[string, string]>([
    ['local_replay', 'verified_local'],
    ['polar_sandbox', 'verified_polar_sandbox'],
  ])('records only the declared synthetic %s receipt mode', async (verificationMode, state) => {
    const store = await open();
    const proposal = await proposedForVerification(store, { verificationMode });
    const input = verification(proposal.id);
    await store.recordVerification(input);
    const result = await store.get(proposal.id);
    expect(result.state).toBe(state);
    expect(result.createdAt).toBe(proposal.createdAt);
    expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest).not.toBeNull();
    expect(result.approval).toBeNull();
  });

  it('keeps identical verification idempotent and immutable across restart', async () => {
    const store = await open();
    const proposal = await proposedForVerification(store);
    const input = verification(proposal.id);
    await store.recordVerification(input);
    const result = await store.get(proposal.id);
    const before = JSON.stringify(result);
    await store.recordVerification(input);
    expect(JSON.stringify(await store.get(proposal.id))).toBe(before);
    mutate(result.manifest, { forged: true });
    mutate(result.proposal, { diffHash: '0'.repeat(64) });
    input.after.artifactHash = 'e'.repeat(64);
    expect(JSON.stringify(await store.get(proposal.id))).toBe(before);
    await close(store);
    const reopened = await open();
    expect(JSON.stringify(await reopened.get(proposal.id))).toBe(before);
    await expectRejected(() => reopened.recordVerification(input), 'VERIFICATION_CONFLICT');
  });

  it('requires every configured regression check', async () => {
    const store = await open();
    const proposal = await proposedForVerification(store);
    const input = verification(proposal.id);
    input.regressions = input.regressions.filter((entry) => entry.checkId !== 'SC04');
    await expectRejected(() => store.recordVerification(input), 'VERIFICATION_REJECTED');
    expect((await store.get(proposal.id)).state).toBe('proposed');
  });

  it('uses operator-configured regression checks instead of silently substituting the default list', async () => {
    const store = await open({ requiredRegressionChecks: ['custom_regression'] });
    const proposal = await proposedForVerification(store);
    const input = verification(proposal.id);
    await expectRejected(() => store.recordVerification(input), 'VERIFICATION_REJECTED');
    await store.recordVerification({
      ...input,
      regressions: [receipt('receipt_custom', { checkId: 'custom_regression' })],
    });
    expect((await store.get(proposal.id)).state).toBe('verified_local');
  });

  it.each<[string, Record<string, unknown>]>([
    ['before', { failureCode: 'UNRELATED_FAILURE' }],
    ['before', { outcome: 'pass', failureCode: null, exitCode: 0 }],
    ['before', { diffHash: patchHash(changes()) }],
    ['before', { exitCode: 0 }],
    ['after', { outcome: 'fail', failureCode, exitCode: 1 }],
    ['after', { diffHash: null }],
    ['after', { diffHash: '0'.repeat(64) }],
    ['after', { checkId: 'different_reproduction' }],
    ['after', { baseCommit: 'e'.repeat(40) }],
    ['after', { policyHash: 'e'.repeat(64) }],
    ['after', { oracleHash: 'e'.repeat(64) }],
  ])('rejects mismatched %s reproduction receipt', async (slot, change) => {
    const store = await open();
    const proposal = await proposedForVerification(store);
    const before = await store.get(proposal.id);
    const input = verification(proposal.id);
    const changed =
      slot === 'before'
        ? { ...input, before: { ...input.before, ...change } }
        : { ...input, after: { ...input.after, ...change } };
    await expectRejected(() => store.recordVerification(changed));
    expect(await store.get(proposal.id)).toEqual(before);
  });

  it.each<Record<string, unknown>>([
    { outcome: 'fail', exitCode: 1, failureCode },
    { diffHash: null },
    { oracleHash: 'e'.repeat(64) },
    { policyHash: 'e'.repeat(64) },
    { baseCommit: 'e'.repeat(40) },
  ])('rejects a failed or mismatched regression receipt', async (change) => {
    const store = await open();
    const proposal = await proposedForVerification(store);
    const input = verification(proposal.id);
    input.regressions = input.regressions.map((entry, index) =>
      index === 0 ? { ...entry, ...change } : entry,
    );
    await expectRejected(() => store.recordVerification(input));
    expect((await store.get(proposal.id)).state).toBe('proposed');
  });

  it('rejects reused receipt IDs across reproduction and regression evidence', async () => {
    const store = await open();
    const proposal = await proposedForVerification(store);
    const input = verification(proposal.id);
    await expectRejected(
      () => store.recordVerification({ ...input, after: { ...input.after, id: input.before.id } }),
      'VERIFICATION_REJECTED',
    );
    await expectRejected(
      () =>
        store.recordVerification({
          ...input,
          regressions: input.regressions.map((entry) => ({ ...entry, id: input.after.id })),
        }),
      'VERIFICATION_REJECTED',
    );
  });

  it('rejects receipts older than the proposal and receipts from the future', async () => {
    const store = await open();
    const proposal = await proposedForVerification(store);
    const input = verification(proposal.id);
    await expectRejected(
      () =>
        store.recordVerification({
          ...input,
          before: { ...input.before, observedAt: proposal.createdAt - 1 },
        }),
      'VERIFICATION_REJECTED',
    );
    await expectRejected(
      () => store.recordVerification({ ...input, after: { ...input.after, observedAt: now + 1 } }),
      'VERIFICATION_REJECTED',
    );
    await expectRejected(
      () =>
        store.recordVerification({
          ...input,
          regressions: input.regressions.map((entry) => ({ ...entry, observedAt: now + 1 })),
        }),
      'VERIFICATION_REJECTED',
    );
  });

  it('requires after and regression observations to occur no earlier than before', async () => {
    const store = await open();
    const proposal = await proposedForVerification(store);
    const input = verification(proposal.id);
    await expectRejected(
      () =>
        store.recordVerification({
          ...input,
          after: { ...input.after, observedAt: input.before.observedAt - 1 },
        }),
      'VERIFICATION_REJECTED',
    );
    await expectRejected(
      () =>
        store.recordVerification({
          ...input,
          regressions: input.regressions.map((entry) => ({
            ...entry,
            observedAt: input.before.observedAt - 1,
          })),
        }),
      'VERIFICATION_REJECTED',
    );
  });

  it.each([
    'id',
    'executionId',
    'checkId',
    'oracleHash',
    'policyHash',
    'baseCommit',
    'diffHash',
    'artifactHash',
    'observedAt',
    'exitCode',
    'outcome',
    'failureCode',
  ])('requires receipt field %s', async (field) => {
    const store = await open();
    const proposal = await proposedForVerification(store);
    const input = verification(proposal.id);
    const after: Record<string, unknown> = { ...input.after };
    delete after[field];
    await expectRejected(() => store.recordVerification({ ...input, after }), 'INVALID_INPUT');
  });

  it('rejects missing receipts and forged manifest fields', async () => {
    const store = await open();
    const proposal = await proposedForVerification(store);
    const input = verification(proposal.id);
    await expectRejected(
      () => store.recordVerification({ ...input, before: undefined }),
      'INVALID_INPUT',
    );
    await expectRejected(
      () => store.recordVerification({ ...input, after: { ...input.after, extra: true } }),
      'INVALID_INPUT',
    );
    await expectRejected(
      () => store.recordVerification({ ...input, manifestHash: '0'.repeat(64) }),
      'INVALID_INPUT',
    );
  });
});

describe('independent repair: exact publication approvals without provider writes', () => {
  it.each<[string, boolean]>([
    ['local_replay', true],
    ['polar_sandbox', false],
  ])('binds %s publication draft mode and final text', async (verificationMode, draft) => {
    const store = await open();
    const record = await verified(store, { verificationMode });
    const pending = await store.requestPublication({
      proposalId: record.id,
      title: 'Synthetic title',
      body: 'Synthetic preamble.',
    });
    expect(pending.state).toBe('awaiting_publication');
    expect(pending.manifest).toEqual(record.manifest);
    expect(pending.manifestHash).toBe(record.manifestHash);
    expect(pending.approval).toMatchObject({
      id: expect.any(String),
      bindingHash: expect.any(String),
      expiresAt: now + expiryInterval,
      decision: 'pending',
      args: {
        repository,
        baseBranch: 'main',
        branch: repairBranch('run_owned', 'finding_owned', 1),
        draft,
        title: 'Synthetic title',
      },
    });
    const body = pending.approval?.args.body;
    expect(body).toContain('Synthetic preamble.');
    expect(body).toContain('https://reports.example.invalid/run_owned');
    expect(body).toContain(verificationMode);
  });

  it('reuses the exact approval and does not extend expiry on retries', async () => {
    const store = await open();
    const pending = await publicationRequested(store);
    now += 1_000;
    const repeated = await store.requestPublication({
      proposalId: pending.id,
      title: 'Synthetic repair',
      body: 'Synthetic publication preamble.',
    });
    expect(repeated).toEqual(pending);
    await expectRejected(
      () =>
        store.requestPublication({
          proposalId: pending.id,
          title: 'Changed title',
          body: 'Synthetic publication preamble.',
        }),
      'APPROVAL_STALE',
    );
    await expectRejected(
      () =>
        store.requestPublication({
          proposalId: pending.id,
          title: 'Synthetic repair',
          body: 'Changed body',
        }),
      'APPROVAL_STALE',
    );
  });

  it('does not allow caller mutation of diff or final publication text', async () => {
    const store = await open();
    const pending = await publicationRequested(store);
    const before = JSON.stringify(await store.get(pending.id));
    mutate(pending.proposal, { diffHash: '0'.repeat(64) });
    mutate(pending.approval?.args, {
      draft: false,
      repository: 'foreign-owner/repo',
      body: 'changed',
    });
    expect(JSON.stringify(await store.get(pending.id))).toBe(before);
  });

  it('keeps a wrong binding from consuming a pending approval', async () => {
    const store = await open();
    const pending = await publicationRequested(store);
    await expectRejected(() =>
      store.decidePublication(publicationDecision(pending, { bindingHash: '0'.repeat(64) })),
    );
    expect((await store.get(pending.id)).approval?.decision).toBe('pending');
    await store.decidePublication(publicationDecision(pending));
    expect(await store.get(pending.id)).toMatchObject({
      state: 'awaiting_publication',
      approval: { decision: 'allow' },
    });
  });

  it('never treats another proposal approval as approval of a different patch', async () => {
    const store = await open();
    const first = await publicationRequested(store);
    const alternateChanges = [{ path: webhookPath, content: 'different synthetic repair\n' }];
    const second = await proposedForVerification(store, {
      attempt: 2,
      branch: repairBranch('run_owned', 'finding_owned', 2),
      changes: alternateChanges,
      diffHash: patchHash(alternateChanges),
    });
    const input = verification(second.id);
    const diffHash = patchHash(alternateChanges);
    await store.recordVerification({
      ...input,
      after: { ...input.after, diffHash },
      regressions: input.regressions.map((entry) => ({ ...entry, diffHash })),
    });
    await store.requestPublication({
      proposalId: second.id,
      title: 'Second repair',
      body: 'Second preamble',
    });
    await expectRejected(() =>
      store.decidePublication({ ...publicationDecision(first), proposalId: second.id }),
    );
    expect((await store.get(second.id)).approval?.decision).toBe('pending');
  });

  it('accepts the final millisecond before publication expiry', async () => {
    const store = await open();
    const pending = await publicationRequested(store);
    if (!pending.approval) throw new Error('Expected approval');
    now = pending.approval.expiresAt - 1;
    await store.decidePublication(publicationDecision(pending));
    expect((await store.get(pending.id)).approval?.decision).toBe('allow');
  });

  it.each([0, 1])('rejects publication approval at expiry plus %s milliseconds', async (offset) => {
    const store = await open();
    const pending = await publicationRequested(store);
    if (!pending.approval) throw new Error('Expected approval');
    now = pending.approval.expiresAt + offset;
    await expectRejected(() => store.decidePublication(publicationDecision(pending)));
    expect((await store.get(pending.id)).approval?.decision).toBe('pending');
  });

  it.each(['allow', 'deny'])(
    'records repeated identical %s decisions without changing the approval',
    async (decision) => {
      const store = await open();
      const pending = await publicationRequested(store);
      const input = publicationDecision(pending, { decision });
      await store.decidePublication(input);
      const before = await store.get(pending.id);
      await store.decidePublication(input);
      expect(await store.get(pending.id)).toEqual(before);
      await expectRejected(() =>
        store.decidePublication(
          publicationDecision(pending, { decision: decision === 'allow' ? 'deny' : 'allow' }),
        ),
      );
    },
  );

  it('keeps denial abandoned and requires a fresh attempt rather than changing that decision', async () => {
    const store = await open();
    const pending = await publicationRequested(store);
    await store.decidePublication(publicationDecision(pending, { decision: 'deny' }));
    expect((await store.get(pending.id)).state).toBe('abandoned');
    await expectRejected(() =>
      store.requestPublication({ proposalId: pending.id, title: 'New title', body: 'Try again' }),
    );
    const next = await store.propose(
      proposalInput({ attempt: 2, branch: repairBranch('run_owned', 'finding_owned', 2) }),
    );
    expect(next.id).not.toBe(pending.id);
    expect(next.state).toBe('proposed');
  });

  it('preserves pending approval bindings and expiry across restart', async () => {
    const store = await open();
    const pending = await publicationRequested(store);
    await close(store);
    now += 1_000;
    const reopened = await open();
    expect(await reopened.get(pending.id)).toEqual(pending);
    await reopened.decidePublication(publicationDecision(pending));
    expect((await reopened.get(pending.id)).approval?.decision).toBe('allow');
  });

  it('rejects unknown approval fields and a caller-supplied draft override', async () => {
    const store = await open();
    const record = await verified(store);
    await expectRejected(
      () =>
        store.requestPublication({
          proposalId: record.id,
          title: 'Synthetic title',
          body: 'Synthetic body',
          draft: false,
        }),
      'INVALID_INPUT',
    );
    const pending = await store.requestPublication({
      proposalId: record.id,
      title: 'Synthetic title',
      body: 'Synthetic body',
    });
    await expectRejected(
      () => store.decidePublication(publicationDecision(pending, { extra: true })),
      'INVALID_INPUT',
    );
    await expectRejected(
      () => store.decidePublication(publicationDecision(pending, { decision: 'approve' })),
      'INVALID_INPUT',
    );
  });
});

type ReplayObservation = Parameters<typeof createRepairReplayPlan>[0]['observations'][number];
type ReplayInput = Omit<Parameters<typeof createRepairReplayPlan>[0], 'observations'> & {
  observations: ReplayObservation[];
};
type ReplayPlan = ReturnType<typeof createRepairReplayPlan>;
type ReplayScenario = 'SC01' | 'SC02' | 'SC03' | 'SC04';
type ReplayBilling = ReplayPlan['states'][ReplayScenario];
const replayScenarios: ReplayScenario[] = ['SC01', 'SC02', 'SC03', 'SC04'];
const originalReplayRun = 'synthetic_original_replay_run';
const originalReplayBuild = 'synthetic_original_build';
const originalCustomer = 'cus_SYNTHETIC_ORIGINAL_PRIVATE_CUSTOMER';
const originalSubscription = 'sub_SYNTHETIC_ORIGINAL_PRIVATE_SUBSCRIPTION';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function replayPolicy() {
  return createPolicy({
    schemaVersion: 2,
    priceId: 'price_synthetic_replay',
    featureId: 'export',
    featureConfigHash: 'a'.repeat(64),
    cancellation: 'allow_until_period_end',
    requireInitialPaymentConfirmed: true,
    syncWindowSeconds: 60,
    predicateVersion: 'synthetic-export-v1',
  });
}

function replayBilling(scenarioId: ReplayScenario): ReplayBilling {
  if (scenarioId === 'SC01')
    return {
      livemode: false,
      identityResolved: true,
      noSubscriptionConfirmed: true,
      customerId: null,
      subscription: null,
    };
  return {
    livemode: false,
    identityResolved: true,
    noSubscriptionConfirmed: false,
    customerId: originalCustomer,
    subscription: {
      id: originalSubscription,
      customerId: originalCustomer,
      priceId: 'price_synthetic_replay',
      status: scenarioId === 'SC04' ? 'canceled' : 'active',
      initialPaymentConfirmed: true,
      cancelAtPeriodEnd: scenarioId === 'SC03',
      periodEnd: 20_000,
      billingTime: scenarioId === 'SC02' ? 10_000 : scenarioId === 'SC03' ? 15_000 : 20_000,
    },
  };
}

function replaySubscription(
  scenarioId: Exclude<ReplayScenario, 'SC01'>,
  change: Partial<NonNullable<ReplayBilling['subscription']>>,
) {
  const billing = replayBilling(scenarioId);
  if (!billing.subscription) throw new Error('Expected synthetic paid subscription');
  return { ...billing, subscription: { ...billing.subscription, ...change } };
}

async function recordedReplay(
  scenarioId: ReplayScenario,
  overrides: Record<string, unknown> = {},
): Promise<ReplayObservation> {
  const evidence = new EvidenceStore(join(directory, 'replay-observation-fixtures.sqlite'));
  try {
    const payload = replayBilling(scenarioId);
    return await evidence.record({
      runId: originalReplayRun,
      scenarioId,
      subjectId:
        scenarioId === 'SC01' ? 'synthetic_original_free_user' : 'synthetic_original_paid_user',
      source: 'billing_provider',
      policyHash: replayPolicy().hash,
      targetBuild: originalReplayBuild,
      observedAt: initialTime + replayScenarios.indexOf(scenarioId) * 1_000,
      billingTime: payload.subscription?.billingTime ?? null,
      mode: 'local_replay',
      payload,
      ...overrides,
    });
  } finally {
    await evidence.close();
  }
}

async function replayInputs(): Promise<ReplayInput> {
  const observations: ReplayObservation[] = [];
  for (const scenario of replayScenarios) observations.push(await recordedReplay(scenario));
  return {
    runId: originalReplayRun,
    targetBuild: originalReplayBuild,
    policy: replayPolicy(),
    observations,
  };
}

function replaceScenario(
  input: ReplayInput,
  scenario: ReplayScenario,
  replacement: ReplayObservation,
): ReplayInput {
  return {
    ...input,
    observations: input.observations.map((record) =>
      record.scenarioId === scenario ? replacement : record,
    ),
  };
}

async function expectReplayRejected(action: () => unknown, code?: string) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (code) expect(caught).toMatchObject({ code });
}

function requiredSubscription(plan: ReplayPlan, scenario: Exclude<ReplayScenario, 'SC01'>) {
  const subscription = plan.states[scenario].subscription;
  if (!subscription) throw new Error('Expected synthetic plan subscription');
  return subscription;
}

// Only frozen-plan generation and JSON construction are exercised below.
// EvidenceStore hashes these synthetic fixtures; no provider observation, browser
// action, signed target replay, runtime execution or repair acceptance is claimed.
describe('independent repair replay: isolated identities and recorded billing facts', () => {
  it.each(['local_replay', 'polar_sandbox'] as const)(
    'creates an explicitly synthetic plan from coherent %s-labeled fixture records',
    async (mode) => {
      const input = await replayInputs();
      for (const scenario of replayScenarios) {
        const index = input.observations.findIndex((record) => record.scenarioId === scenario);
        input.observations[index] = await recordedReplay(scenario, { mode });
      }
      const plan = createRepairReplayPlan(input);
      expect(plan).toMatchObject({
        schemaVersion: 2,
        mode: 'local_replay',
        policyHash: input.policy.hash,
      });
      expect(plan.runId).toMatch(uuidPattern);
      expect(plan.runId).not.toBe(input.runId);
      expect(plan.markers.free).toMatch(uuidPattern);
      expect(plan.markers.paid).toMatch(uuidPattern);
      expect(new Set([plan.runId, plan.markers.free, plan.markers.paid]).size).toBe(3);
      expect(plan.states.SC01).toEqual(replayBilling('SC01'));
      const customer = plan.states.SC02.customerId;
      const subscription = requiredSubscription(plan, 'SC02').id;
      expect(customer).toMatch(/^cus_replay_\S+$/);
      expect(subscription).toMatch(/^sub_replay_\S+$/);
      for (const scenario of ['SC02', 'SC03', 'SC04'] as const) {
        const original = replayBilling(scenario);
        expect(plan.states[scenario]).toEqual({
          ...original,
          customerId: customer,
          subscription: { ...original.subscription, customerId: customer, id: subscription },
        });
      }
      expect(JSON.stringify(plan)).not.toContain(originalCustomer);
      expect(JSON.stringify(plan)).not.toContain(originalSubscription);
      expect(JSON.stringify(plan)).not.toContain('synthetic_original_paid_user');
    },
  );

  it('creates separate run, marker and billing identities on every new plan', async () => {
    const input = await replayInputs();
    const first = createRepairReplayPlan(input);
    const second = createRepairReplayPlan(input);
    expect(second.runId).not.toBe(first.runId);
    expect(second.markers.free).not.toBe(first.markers.free);
    expect(second.markers.paid).not.toBe(first.markers.paid);
    expect(second.states.SC02.customerId).not.toBe(first.states.SC02.customerId);
    expect(requiredSubscription(second, 'SC02').id).not.toBe(
      requiredSubscription(first, 'SC02').id,
    );
    expect(second.policyHash).toBe(first.policyHash);
  });

  it('keeps the selected snapshot times instead of replacing them with wall-clock time', async () => {
    let input = await replayInputs();
    const changed = replaySubscription('SC04', { billingTime: 25_123 });
    input = replaceScenario(
      input,
      'SC04',
      await recordedReplay('SC04', { payload: changed, billingTime: 25_123, observedAt: 1_000 }),
    );
    const plan = createRepairReplayPlan(input);
    expect(requiredSubscription(plan, 'SC02').billingTime).toBe(10_000);
    expect(requiredSubscription(plan, 'SC03').billingTime).toBe(15_000);
    expect(requiredSubscription(plan, 'SC04').billingTime).toBe(25_123);
    for (const scenario of ['SC02', 'SC03', 'SC04'] as const)
      expect(requiredSubscription(plan, scenario).periodEnd).toBe(20_000);
  });

  it('preserves an unpaid initial-invoice fact in the canceled state', async () => {
    const input = replaceScenario(
      await replayInputs(),
      'SC04',
      await recordedReplay('SC04', {
        payload: replaySubscription('SC04', { initialPaymentConfirmed: false }),
      }),
    );
    const plan = createRepairReplayPlan(input);
    expect(requiredSubscription(plan, 'SC02').initialPaymentConfirmed).toBe(true);
    expect(requiredSubscription(plan, 'SC03').initialPaymentConfirmed).toBe(true);
    expect(requiredSubscription(plan, 'SC04').initialPaymentConfirmed).toBe(false);
  });

  it('does not mutate frozen observations or policy and detaches the resulting plan', async () => {
    const input = await replayInputs();
    const before = JSON.stringify(input);
    for (const observation of input.observations) {
      if (observation.payload && typeof observation.payload === 'object') {
        const subscription: unknown = Reflect.get(observation.payload, 'subscription');
        if (subscription && typeof subscription === 'object') Object.freeze(subscription);
        Object.freeze(observation.payload);
      }
      Object.freeze(observation);
    }
    Object.freeze(input.observations);
    Object.freeze(input);
    const plan = createRepairReplayPlan(input);
    expect(JSON.stringify(input)).toBe(before);
    mutate(plan.states.SC03.subscription, { billingTime: 0 });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('does not let later input changes rewrite a generated plan or its replay bytes', async () => {
    const input = await replayInputs();
    const plan = createRepairReplayPlan(input);
    const before = JSON.stringify(plan);
    const payloadBefore = replayPayload(plan, 'SC03');
    const observed = input.observations.find((record) => record.scenarioId === 'SC03');
    if (!observed) throw new Error('Expected SC03 fixture');
    mutate(observed, { runId: 'changed-input-run', sha256: '0'.repeat(64) });
    mutate(observed.payload, { customerId: 'changed-input-customer', subscription: null });
    expect(JSON.stringify(plan)).toBe(before);
    expect(replayPayload(plan, 'SC03')).toBe(payloadBefore);
  });
});

describe('independent repair replay: authoritative selection and isolation', () => {
  it.each(replayScenarios)(
    'rejects missing %s evidence rather than inventing it',
    async (scenario) => {
      const input = await replayInputs();
      await expectReplayRejected(
        () =>
          createRepairReplayPlan({
            ...input,
            observations: input.observations.filter((record) => record.scenarioId !== scenario),
          }),
        'REPAIR_BILLING_EVIDENCE_REQUIRED',
      );
    },
  );

  it.each<[string, unknown]>([
    ['runId', 'synthetic_foreign_run'],
    ['targetBuild', 'synthetic_foreign_build'],
    ['policyHash', 'f'.repeat(64)],
    ['source', 'application'],
  ])('cannot substitute a record with a different %s', async (field, value) => {
    const input = replaceScenario(
      await replayInputs(),
      'SC03',
      await recordedReplay('SC03', { [field]: value }),
    );
    await expectReplayRejected(
      () => createRepairReplayPlan(input),
      'REPAIR_BILLING_EVIDENCE_REQUIRED',
    );
  });

  it.each<[string, unknown]>([
    ['runId', 'synthetic_foreign_run'],
    ['targetBuild', 'synthetic_foreign_build'],
    ['policyHash', 'f'.repeat(64)],
    ['source', 'browser'],
  ])(
    'ignores a newer out-of-scope %s record instead of contaminating the selected state',
    async (field, value) => {
      const input = await replayInputs();
      const foreign = await recordedReplay('SC03', {
        [field]: value,
        observedAt: initialTime + 99_000,
      });
      input.observations.push({ ...foreign, sha256: '0'.repeat(64) });
      const plan = createRepairReplayPlan(input);
      expect(requiredSubscription(plan, 'SC03').billingTime).toBe(15_000);
    },
  );

  it('uses the latest timestamp rather than input array order', async () => {
    const input = await replayInputs();
    const latest = await recordedReplay('SC03', {
      observedAt: initialTime + 50_000,
      billingTime: 18_123,
      payload: replaySubscription('SC03', { billingTime: 18_123 }),
    });
    input.observations.unshift(latest);
    input.observations.reverse();
    expect(requiredSubscription(createRepairReplayPlan(input), 'SC03').billingTime).toBe(18_123);
  });

  it('does not fall back from a corrupt newest digest to older valid evidence', async () => {
    const input = await replayInputs();
    const latest = await recordedReplay('SC03', { observedAt: initialTime + 50_000 });
    input.observations.push({ ...latest, sha256: '0'.repeat(64) });
    await expectReplayRejected(
      () => createRepairReplayPlan(input),
      'REPAIR_BILLING_EVIDENCE_REQUIRED',
    );
  });

  it('does not fall back when the newest payload has changed without its stored digest', async () => {
    const input = await replayInputs();
    const latest = await recordedReplay('SC03', { observedAt: initialTime + 50_000 });
    input.observations.push({
      ...latest,
      payload: replaySubscription('SC03', { billingTime: 17_777 }),
    });
    await expectReplayRejected(
      () => createRepairReplayPlan(input),
      'REPAIR_BILLING_EVIDENCE_REQUIRED',
    );
  });

  it('does not fall back from a correctly hashed but invalid newest state', async () => {
    const input = await replayInputs();
    input.observations.push(
      await recordedReplay('SC03', {
        observedAt: initialTime + 50_000,
        payload: replaySubscription('SC03', { cancelAtPeriodEnd: false }),
      }),
    );
    await expectReplayRejected(
      () => createRepairReplayPlan(input),
      'REPAIR_BILLING_EVIDENCE_REQUIRED',
    );
  });

  it('selects a newer valid record instead of an older invalid state', async () => {
    const input = await replayInputs();
    input.observations.push(
      await recordedReplay('SC03', {
        observedAt: initialTime,
        payload: replaySubscription('SC03', { cancelAtPeriodEnd: false }),
      }),
    );
    expect(requiredSubscription(createRepairReplayPlan(input), 'SC03').cancelAtPeriodEnd).toBe(
      true,
    );
  });

  it('allows duplicate latest snapshots only when their payload and scope agree', async () => {
    const input = await replayInputs();
    input.observations.push(await recordedReplay('SC03'));
    expect(requiredSubscription(createRepairReplayPlan(input), 'SC03').billingTime).toBe(15_000);
  });

  it.each(['payload', 'subjectId', 'mode'] as const)(
    'rejects conflicting latest-timestamp ties in %s',
    async (field) => {
      const input = await replayInputs();
      const overrides =
        field === 'payload'
          ? { payload: replaySubscription('SC03', { billingTime: 16_000 }) }
          : field === 'subjectId'
            ? { subjectId: 'synthetic_different_paid_user' }
            : { mode: 'polar_sandbox' };
      input.observations.push(await recordedReplay('SC03', overrides));
      await expectReplayRejected(
        () => createRepairReplayPlan(input),
        'REPAIR_BILLING_EVIDENCE_REQUIRED',
      );
    },
  );

  it.each(replayScenarios)(
    'rejects mixed execution mode in selected %s evidence',
    async (scenario) => {
      const input = replaceScenario(
        await replayInputs(),
        scenario,
        await recordedReplay(scenario, { mode: 'polar_sandbox' }),
      );
      await expectReplayRejected(
        () => createRepairReplayPlan(input),
        'REPAIR_BILLING_EVIDENCE_REQUIRED',
      );
    },
  );

  it.each(['SC02', 'SC03', 'SC04'] as const)(
    'rejects a different paid subject in %s',
    async (scenario) => {
      const input = replaceScenario(
        await replayInputs(),
        scenario,
        await recordedReplay(scenario, { subjectId: 'synthetic_other_paid_subject' }),
      );
      await expectReplayRejected(
        () => createRepairReplayPlan(input),
        'REPAIR_BILLING_EVIDENCE_REQUIRED',
      );
    },
  );

  it('rejects free/paid subject collisions', async () => {
    const input = replaceScenario(
      await replayInputs(),
      'SC01',
      await recordedReplay('SC01', { subjectId: 'synthetic_original_paid_user' }),
    );
    await expectReplayRejected(
      () => createRepairReplayPlan(input),
      'REPAIR_BILLING_EVIDENCE_REQUIRED',
    );
  });

  it.each(['SC03', 'SC04'] as const)(
    'rejects incompatible customer, subscription or period identity in %s',
    async (scenario) => {
      for (const payload of [
        {
          ...replaySubscription(scenario, { customerId: 'cus_synthetic_other' }),
          customerId: 'cus_synthetic_other',
        },
        replaySubscription(scenario, { id: 'sub_synthetic_other' }),
        replaySubscription(scenario, { periodEnd: 19_000 }),
      ]) {
        const input = replaceScenario(
          await replayInputs(),
          scenario,
          await recordedReplay(scenario, { payload }),
        );
        await expectReplayRejected(
          () => createRepairReplayPlan(input),
          'REPAIR_BILLING_EVIDENCE_REQUIRED',
        );
      }
    },
  );

  it('rejects changed or forged policy instead of reusing a recorded hash', async () => {
    const input = await replayInputs();
    const changed = { ...input.policy, syncWindowSeconds: 5 };
    await expectReplayRejected(() => createRepairReplayPlan({ ...input, policy: changed }));
    await expectReplayRejected(() =>
      createRepairReplayPlan({ ...input, policy: { ...input.policy, hash: '0'.repeat(64) } }),
    );
  });
});

describe('independent repair replay: missing, malformed and unsupported state', () => {
  it.each(replayScenarios)(
    'rejects live, unresolved or wrong-price %s state with honest hashes',
    async (scenario) => {
      const original = replayBilling(scenario);
      const invalid: unknown[] = [
        { ...original, livemode: true },
        { ...original, identityResolved: false },
      ];
      if (scenario !== 'SC01')
        invalid.push(replaySubscription(scenario, { priceId: 'price_synthetic_wrong' }));
      for (const payload of invalid) {
        const input = replaceScenario(
          await replayInputs(),
          scenario,
          await recordedReplay(scenario, { payload }),
        );
        await expectReplayRejected(
          () => createRepairReplayPlan(input),
          'REPAIR_BILLING_EVIDENCE_REQUIRED',
        );
      }
    },
  );

  it.each<[ReplayScenario, unknown]>([
    ['SC01', { ...replayBilling('SC01'), noSubscriptionConfirmed: false }],
    ['SC01', { ...replayBilling('SC01'), customerId: 'cus_synthetic_free' }],
    ['SC01', replayBilling('SC02')],
    ['SC02', replaySubscription('SC02', { status: 'trialing' })],
    ['SC02', replaySubscription('SC02', { initialPaymentConfirmed: false })],
    ['SC02', replaySubscription('SC02', { cancelAtPeriodEnd: true })],
    ['SC03', replaySubscription('SC03', { initialPaymentConfirmed: false })],
    ['SC03', replaySubscription('SC03', { cancelAtPeriodEnd: false })],
    ['SC03', replaySubscription('SC03', { billingTime: 20_000 })],
    ['SC04', replaySubscription('SC04', { status: 'active' })],
    ['SC04', replaySubscription('SC04', { billingTime: 19_999 })],
    ['SC03', replaySubscription('SC03', { customerId: 'cus_synthetic_mismatched_mapping' })],
    ['SC03', { ...replayBilling('SC03'), noSubscriptionConfirmed: true }],
    ['SC03', null],
    ['SC03', {}],
    ['SC03', { ...replayBilling('SC03'), email: 'synthetic-private@example.invalid' }],
  ])(
    'rejects invalid required %s snapshot %# instead of synthesizing a replacement',
    async (scenario, payload) => {
      const input = replaceScenario(
        await replayInputs(),
        scenario,
        await recordedReplay(scenario, { payload }),
      );
      await expectReplayRejected(
        () => createRepairReplayPlan(input),
        'REPAIR_BILLING_EVIDENCE_REQUIRED',
      );
    },
  );
});

describe('independent repair replay: deterministic explicit synthetic event payloads', () => {
  it.each<[Exclude<ReplayScenario, 'SC01'>, string]>([
    ['SC02', 'customer.subscription.created'],
    ['SC03', 'customer.subscription.updated'],
    ['SC04', 'customer.subscription.deleted'],
  ])(
    'constructs %s from its exact frozen state and synthetic identities',
    async (scenario, type) => {
      const input = await replayInputs();
      const plan = createRepairReplayPlan(input);
      const before = JSON.stringify(plan);
      const state = requiredSubscription(plan, scenario);
      const serialized = replayPayload(plan, scenario);
      expect(typeof serialized).toBe('string');
      expect(replayPayload(plan, scenario)).toBe(serialized);
      expect(JSON.stringify(plan)).toBe(before);
      expect(serialized).not.toContain(originalCustomer);
      expect(serialized).not.toContain(originalSubscription);
      expect(serialized).not.toContain(originalReplayRun);
      expect(serialized).not.toContain('synthetic_original_paid_user');
      const event = JSON.parse(serialized);
      expect(event).toEqual({
        id: expect.stringMatching(/\S/),
        object: 'event',
        type,
        livemode: false,
        created: state.billingTime,
        data: {
          object: {
            id: state.id,
            object: 'subscription',
            livemode: false,
            customer: state.customerId,
            metadata: { runId: plan.runId },
            status: state.status,
            cancel_at_period_end: state.cancelAtPeriodEnd,
            items: {
              data: [
                {
                  price: { id: state.priceId, livemode: false },
                  current_period_end: state.periodEnd,
                },
              ],
              has_more: false,
            },
            latest_invoice: {
              id: expect.stringMatching(/\S/),
              object: 'invoice',
              livemode: false,
              status: state.initialPaymentConfirmed ? 'paid' : 'open',
              customer: state.customerId,
              billing_reason: 'subscription_create',
              parent: { subscription_details: { subscription: state.id } },
            },
          },
        },
      });
    },
  );

  it('retains identical payloads when the same plan is serialized and reopened for patched execution', async () => {
    const plan = createRepairReplayPlan(await replayInputs());
    const restored = JSON.parse(JSON.stringify(plan));
    for (const scenario of ['SC02', 'SC03', 'SC04'] as const)
      expect(replayPayload(restored, scenario)).toBe(replayPayload(plan, scenario));
  });

  it('uses different deterministic events for different scenarios', async () => {
    const plan = createRepairReplayPlan(await replayInputs());
    const ids = ['SC02', 'SC03', 'SC04'].map(
      (scenario) => JSON.parse(Reflect.apply(replayPayload, undefined, [plan, scenario])).id,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('renders open invoice status only for the recorded false payment fact', async () => {
    const input = replaceScenario(
      await replayInputs(),
      'SC04',
      await recordedReplay('SC04', {
        payload: replaySubscription('SC04', { initialPaymentConfirmed: false }),
      }),
    );
    const plan = createRepairReplayPlan(input);
    const canceled = JSON.parse(replayPayload(plan, 'SC04'));
    expect(canceled.data.object.latest_invoice.status).toBe('open');
    expect(JSON.parse(replayPayload(plan, 'SC02')).data.object.latest_invoice.status).toBe('paid');
  });

  it.each(['SC01', 'SC00', 'SC05', '', null])(
    'rejects unsupported replay scenario %s',
    async (scenario) => {
      const plan = createRepairReplayPlan(await replayInputs());
      await expectReplayRejected(() => Reflect.apply(replayPayload, undefined, [plan, scenario]));
    },
  );
});
