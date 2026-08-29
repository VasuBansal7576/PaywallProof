import { z } from 'zod';
import { hashValue } from '#domain';
import {
  blobSha,
  gitSha,
  marker,
  RepairError,
  repositorySchema,
  type PublicationProgress,
  type RepairManifest,
} from './model.ts';
import type { RepairStore } from './store.ts';

export type GitHubRequest = { method: 'GET' | 'POST'; path: string; body?: unknown };
export type SyntheticGitHubTransport = {
  kind: 'synthetic';
  request: (request: GitHubRequest) => Promise<{ status: number; body: unknown }>;
};
const refSchema = z.object({
  ref: z.string(),
  object: z.object({ type: z.literal('commit'), sha: gitSha }),
});
const treeEntrySchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.enum(['blob', 'tree', 'commit']),
  sha: gitSha,
});
const treeSchema = z.object({
  sha: gitSha,
  truncated: z.boolean(),
  tree: z.array(treeEntrySchema),
});
const commitSchema = z.object({
  sha: gitSha,
  tree: z.object({ sha: gitSha }),
  parents: z.array(z.object({ sha: gitSha })),
  message: z.string(),
});
const prSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  draft: z.boolean(),
  state: z.enum(['open', 'closed']),
  title: z.string(),
  body: z.string().nullable(),
  head: z.object({ ref: z.string(), sha: gitSha, repo: z.object({ full_name: z.string() }) }),
  base: z.object({ ref: z.string(), sha: gitSha, repo: z.object({ full_name: z.string() }) }),
});
type FlatEntry = Pick<z.infer<typeof treeEntrySchema>, 'path' | 'mode' | 'type' | 'sha'>;
type Job = { store: RepairStore; proposalId: string; approvalId: string; leaseToken: string };

export class GitHubPublicationAdapter {
  readonly repository: string;
  readonly transportMode: 'github' | 'synthetic';
  private readonly token: string | undefined;
  private readonly transport: SyntheticGitHubTransport | undefined;
  constructor(
    config:
      | { repository: string; token: string; transport?: never }
      | { repository: string; transport: SyntheticGitHubTransport; token?: never },
  ) {
    this.repository = repositorySchema.parse(config.repository);
    this.transportMode = config.transport ? 'synthetic' : 'github';
    this.transport = config.transport;
    this.token = config.token;
    if (this.transportMode === 'github' && (!this.token || /[\r\n]/.test(this.token)))
      throw new RepairError('GITHUB_CREDENTIAL_REQUIRED');
    if (this.transport && this.transport.kind !== 'synthetic')
      throw new RepairError('TRANSPORT_MODE_MISMATCH');
  }
  private async request(job: Job, method: 'GET' | 'POST', path: string, body?: unknown) {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('#'))
      throw new RepairError('GITHUB_PATH_REJECTED');
    const request: GitHubRequest = { method, path, ...(body === undefined ? {} : { body }) };
    job.store.guardPublication(job.proposalId, job.approvalId, job.leaseToken, method === 'POST');
    try {
      if (this.transport) return await this.transport.request(request);
      const response = await fetch(`https://api.github.com/repos/${this.repository}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            bytes += item.value.length;
            if (bytes > 8 * 1024 * 1024) {
              await reader.cancel();
              throw new RepairError('GITHUB_RESPONSE_LIMIT');
            }
            chunks.push(item.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      let result: unknown = null;
      try {
        result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        if (response.status !== 404) throw new RepairError('GITHUB_INVALID_RESPONSE');
      }
      return { status: response.status, body: result };
    } catch (error) {
      if (error instanceof RepairError) throw error;
      throw new RepairError(
        method === 'POST' ? 'PUBLICATION_OUTCOME_UNKNOWN' : 'GITHUB_UNAVAILABLE',
      );
    }
  }
  private async read<T>(job: Job, path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.request(job, 'GET', path);
    if (response.status !== 200)
      throw new RepairError(response.status === 404 ? 'GITHUB_NOT_FOUND' : 'GITHUB_READ_REJECTED');
    const parsed = schema.safeParse(response.body);
    if (!parsed.success) throw new RepairError('GITHUB_INVALID_RESPONSE');
    return parsed.data;
  }
  private async ref(job: Job, branch: string) {
    const response = await this.request(job, 'GET', `/git/ref/heads/${encodeURIComponent(branch)}`);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new RepairError('GITHUB_READ_REJECTED');
    const parsed = refSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.ref !== `refs/heads/${branch}`)
      throw new RepairError('GITHUB_INVALID_RESPONSE');
    return parsed.data.object.sha;
  }
  private async tree(job: Job, sha: string) {
    const tree = await this.read(job, `/git/trees/${sha}?recursive=1`, treeSchema);
    if (
      tree.sha !== sha ||
      tree.truncated ||
      new Set(tree.tree.map((entry) => entry.path)).size !== tree.tree.length
    )
      throw new RepairError('GITHUB_TREE_UNRESOLVED');
    return tree;
  }
  private fileMap(entries: z.infer<typeof treeEntrySchema>[]): FlatEntry[] {
    return entries
      .filter((entry) => entry.type !== 'tree')
      .map(({ path, mode, type, sha }) => ({ path, mode, type, sha }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  private expectedFiles(tree: z.infer<typeof treeSchema>, manifest: RepairManifest) {
    const files = new Map(this.fileMap(tree.tree).map((entry) => [entry.path, entry]));
    for (const change of manifest.changes) {
      const components = change.path.split('/');
      for (let index = 1; index < components.length; index++) {
        const parent = tree.tree.find(
          (entry) => entry.path === components.slice(0, index).join('/'),
        );
        if (parent && parent.type !== 'tree') throw new RepairError('REPAIR_PATH_REJECTED');
      }
      const previous = tree.tree.find((entry) => entry.path === change.path);
      if (previous && (previous.type !== 'blob' || previous.mode !== '100644'))
        throw new RepairError('REPAIR_PATH_REJECTED');
      if (change.content === null) {
        if (!previous) throw new RepairError('REPAIR_PATH_REJECTED');
        files.delete(change.path);
      } else
        files.set(change.path, {
          path: change.path,
          mode: '100644',
          type: 'blob',
          sha: blobSha(change.content),
        });
    }
    const expected = [...files.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    if (hashValue(expected) === hashValue(this.fileMap(tree.tree)))
      throw new RepairError('EMPTY_REPAIR_DIFF');
    return expected;
  }
  private async verifyCommit(
    job: Job,
    sha: string,
    manifest: RepairManifest,
    manifestHash: string,
    expected: FlatEntry[],
  ) {
    const commit = await this.read(job, `/git/commits/${sha}`, commitSchema);
    if (
      commit.sha !== sha ||
      commit.parents.length !== 1 ||
      commit.parents[0]?.sha !== manifest.baseCommit ||
      commit.message !== `PaywallProof repair ${manifestHash}`
    )
      throw new RepairError('GITHUB_COMMIT_MISMATCH');
    const tree = await this.tree(job, commit.tree.sha);
    if (hashValue(this.fileMap(tree.tree)) !== hashValue(expected))
      throw new RepairError('GITHUB_DIFF_MISMATCH');
    return commit;
  }
  private verifyPr(
    pr: z.infer<typeof prSchema>,
    record: ReturnType<RepairStore['get']>,
    commitSha: string,
  ) {
    const args = record.approval?.args;
    if (
      !args ||
      !record.manifestHash ||
      pr.head.repo.full_name !== this.repository ||
      pr.base.repo.full_name !== this.repository ||
      pr.head.ref !== args.branch ||
      pr.base.ref !== args.baseBranch ||
      pr.base.sha !== record.proposal.baseCommit ||
      pr.head.sha !== commitSha ||
      pr.draft !== args.draft ||
      pr.title !== args.title ||
      pr.body !== args.body ||
      !pr.body.includes(marker(record.manifestHash))
    )
      throw new RepairError('GITHUB_PR_MISMATCH');
    const url = new URL(pr.html_url);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.pathname !== `/${this.repository}/pull/${pr.number}` ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new RepairError('GITHUB_PR_MISMATCH');
    return pr;
  }
  private async existingPr(job: Job, record: ReturnType<RepairStore['get']>, commitSha: string) {
    const args = record.approval?.args;
    if (!args) throw new RepairError('APPROVAL_REQUIRED');
    const owner = this.repository.split('/')[0] ?? '';
    const prs = await this.read(
      job,
      `/pulls?state=all&head=${encodeURIComponent(`${owner}:${args.branch}`)}&base=${encodeURIComponent(args.baseBranch)}&per_page=100`,
      z.array(prSchema),
    );
    if (prs.length >= 100 || prs.length > 1) throw new RepairError('GITHUB_PR_UNRESOLVED');
    if (!prs[0]) return null;
    const detail = await this.read(job, `/pulls/${prs[0].number}`, prSchema);
    return this.verifyPr(detail, record, commitSha);
  }
  /** Called by publishRepair after the store has claimed the exact approved manifest. */
  async publishAuthorized(job: Job) {
    const record = job.store.get(job.proposalId),
      manifest = record.manifest,
      args = record.approval?.args,
      manifestHash = record.manifestHash;
    if (
      !manifest ||
      !args ||
      !manifestHash ||
      manifest.repository !== this.repository ||
      !record.progress
    )
      throw new RepairError('REPAIR_SCOPE_REJECTED');
    if (this.token && JSON.stringify({ manifest, args }).includes(this.token))
      throw new RepairError('SECRET_IN_REPAIR_REJECTED');
    let progress: PublicationProgress = record.progress;
    const persist = (next: PublicationProgress) => {
      job.store.saveProgress(job.proposalId, job.leaseToken, next);
      progress = next;
    };
    const checkBase = async () => {
      if ((await this.ref(job, manifest.baseBranch)) !== manifest.baseCommit)
        throw new RepairError('BASE_COMMIT_CHANGED');
    };
    await checkBase();
    const base = await this.read(job, `/git/commits/${manifest.baseCommit}`, commitSchema);
    if (base.sha !== manifest.baseCommit) throw new RepairError('BASE_COMMIT_CHANGED');
    const baseTree = await this.tree(job, base.tree.sha),
      expected = this.expectedFiles(baseTree, manifest);
    let branchSha = await this.ref(job, manifest.branch);
    if (!branchSha && progress.prAttempted) throw new RepairError('PUBLICATION_OUTCOME_UNKNOWN');
    if (branchSha) {
      const commit = await this.verifyCommit(job, branchSha, manifest, manifestHash, expected);
      if (progress.commitSha && progress.commitSha !== branchSha)
        throw new RepairError('GITHUB_BRANCH_CONFLICT');
      persist({ ...progress, commitSha: branchSha, treeSha: commit.tree.sha });
    } else {
      if (!progress.treeSha) {
        await checkBase();
        const tree = await this.request(job, 'POST', '/git/trees', {
          base_tree: base.tree.sha,
          tree: manifest.changes.map((change) => ({
            path: change.path,
            mode: '100644',
            type: 'blob',
            ...(change.content === null ? { sha: null } : { content: change.content }),
          })),
        });
        if (tree.status !== 201) throw new RepairError('GITHUB_WRITE_REJECTED');
        const sha = z.object({ sha: gitSha }).safeParse(tree.body);
        if (!sha.success) throw new RepairError('GITHUB_INVALID_RESPONSE');
        persist({ ...progress, treeSha: sha.data.sha });
      }
      if (!progress.treeSha) throw new RepairError('GITHUB_TREE_UNRESOLVED');
      if (
        hashValue(this.fileMap((await this.tree(job, progress.treeSha)).tree)) !==
        hashValue(expected)
      )
        throw new RepairError('GITHUB_DIFF_MISMATCH');
      if (!progress.commitSha) {
        await checkBase();
        const identity = {
          name: 'PaywallProof',
          email: 'paywallproof@users.noreply.github.com',
          date: new Date(record.createdAt).toISOString(),
        };
        const commit = await this.request(job, 'POST', '/git/commits', {
          message: `PaywallProof repair ${manifestHash}`,
          tree: progress.treeSha,
          parents: [manifest.baseCommit],
          author: identity,
          committer: identity,
        });
        if (commit.status !== 201) throw new RepairError('GITHUB_WRITE_REJECTED');
        const sha = z.object({ sha: gitSha }).safeParse(commit.body);
        if (!sha.success) throw new RepairError('GITHUB_INVALID_RESPONSE');
        persist({ ...progress, commitSha: sha.data.sha });
      }
      if (!progress.commitSha) throw new RepairError('GITHUB_COMMIT_MISMATCH');
      await this.verifyCommit(job, progress.commitSha, manifest, manifestHash, expected);
      await checkBase();
      const created = await this.request(job, 'POST', '/git/refs', {
        ref: `refs/heads/${manifest.branch}`,
        sha: progress.commitSha,
      });
      if (created.status !== 201 && created.status !== 422)
        throw new RepairError('GITHUB_WRITE_REJECTED');
      branchSha = await this.ref(job, manifest.branch);
      if (branchSha !== progress.commitSha) throw new RepairError('GITHUB_BRANCH_CONFLICT');
    }
    if (!branchSha) throw new RepairError('GITHUB_BRANCH_CONFLICT');
    await this.verifyCommit(job, branchSha, manifest, manifestHash, expected);
    let pr = await this.existingPr(job, record, branchSha);
    if (!pr) {
      if (progress.prAttempted) throw new RepairError('PUBLICATION_OUTCOME_UNKNOWN');
      await checkBase();
      job.store.guardPublication(job.proposalId, job.approvalId, job.leaseToken, true);
      persist({ ...progress, prAttempted: true });
      const created = await this.request(job, 'POST', '/pulls', {
        head: args.branch,
        base: args.baseBranch,
        title: args.title,
        body: args.body,
        draft: args.draft,
        maintainer_can_modify: false,
      });
      if (created.status !== 201) throw new RepairError('PUBLICATION_OUTCOME_UNKNOWN');
      const number = z.object({ number: z.number().int().positive() }).safeParse(created.body);
      if (!number.success) throw new RepairError('PUBLICATION_OUTCOME_UNKNOWN');
      pr = this.verifyPr(
        await this.read(job, `/pulls/${number.data.number}`, prSchema),
        record,
        branchSha,
      );
    }
    await checkBase();
    if ((await this.ref(job, manifest.branch)) !== branchSha)
      throw new RepairError('GITHUB_BRANCH_CONFLICT');
    const commit = await this.verifyCommit(job, branchSha, manifest, manifestHash, expected);
    const receipt = {
      repository: this.repository,
      branch: manifest.branch,
      baseCommit: manifest.baseCommit,
      commitSha: branchSha,
      treeSha: commit.tree.sha,
      prNumber: pr.number,
      url: pr.html_url,
      draft: pr.draft,
      manifestHash,
      collectedAt: job.store.now(),
      transportMode: this.transportMode,
    };
    return { kind: this.transportMode === 'github' ? 'published' : 'synthetic', receipt };
  }
}

export async function publishRepair(input: {
  store: RepairStore;
  adapter: GitHubPublicationAdapter;
  proposalId: string;
  approvalId: string;
}) {
  const { store, adapter, proposalId, approvalId } = input;
  const record = store.claimPublication(proposalId, approvalId, adapter.transportMode);
  if (record.progress?.result) return record.progress.result;
  if (!record.leaseToken) throw new RepairError('PUBLICATION_LEASE_LOST');
  const leaseToken = record.leaseToken;
  try {
    const result = await adapter.publishAuthorized({ store, proposalId, approvalId, leaseToken });
    const saved = store.finishPublication(proposalId, leaseToken, result);
    if (!saved.progress?.result) throw new RepairError('PUBLICATION_OUTCOME_UNKNOWN');
    return saved.progress.result;
  } finally {
    store.releasePublication(proposalId, leaseToken);
  }
}
