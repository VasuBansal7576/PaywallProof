import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashValue, identifier } from '#domain';
import {
  approvalSchema,
  checked,
  marker,
  pathSchema,
  progressSchema,
  recordSchema,
  RepairError,
  repositorySchema,
  resultSchema,
  timestamp,
  validateProposal,
  verificationSchema,
  type RepairRecord,
} from './model.ts';

export function openRepairStore(options: {
  path: string;
  repository: string;
  allowedPaths: string[];
  requiredRegressionChecks?: string[];
  clock?: () => number;
}) {
  const config = checked(
    z.strictObject({
      path: identifier,
      repository: repositorySchema,
      allowedPaths: z.array(pathSchema).min(1),
      requiredRegressionChecks: z
        .array(identifier)
        .min(1)
        .refine((values) => new Set(values).size === values.length),
    }),
    {
      path: options.path,
      repository: options.repository,
      allowedPaths: options.allowedPaths,
      requiredRegressionChecks: options.requiredRegressionChecks ?? [
        'SC01',
        'SC02',
        'SC03',
        'SC04',
      ],
    },
  );
  const database = new Database(config.path);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.exec(
    'CREATE TABLE IF NOT EXISTS repair_proposals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,finding_id TEXT NOT NULL,attempt INTEGER NOT NULL,record TEXT NOT NULL,UNIQUE(run_id,finding_id,attempt));',
  );
  const now = () => timestamp.parse((options.clock ?? Date.now)());
  function get(id: string): RepairRecord {
    const row = database
      .prepare('SELECT record FROM repair_proposals WHERE id=?')
      .get(identifier.parse(id));
    if (!row) throw new RepairError('NOT_FOUND');
    return recordSchema.parse(JSON.parse(z.object({ record: z.string() }).parse(row).record));
  }
  function save(record: RepairRecord) {
    database
      .prepare('UPDATE repair_proposals SET record=? WHERE id=?')
      .run(JSON.stringify(recordSchema.parse(record)), record.id);
    return get(record.id);
  }
  function transaction<T>(operation: () => T): T {
    return database.transaction(operation).immediate();
  }
  function authorized(record: RepairRecord, approvalId: string) {
    if (
      !record.manifest ||
      !record.manifestHash ||
      !record.approval ||
      record.approval.id !== approvalId ||
      record.approval.decision !== 'allow'
    )
      throw new RepairError('APPROVAL_REQUIRED');
    validateProposal(record.proposal, config.repository, config.allowedPaths);
    if (
      record.manifestHash !== hashValue(record.manifest) ||
      record.approval.bindingHash !==
        hashValue({ manifest: record.manifest, args: record.approval.args })
    )
      throw new RepairError('APPROVAL_STALE');
  }
  const store = {
    propose(input: unknown) {
      const proposal = validateProposal(input, config.repository, config.allowedPaths);
      return transaction(() => {
        const previous = database
          .prepare('SELECT id FROM repair_proposals WHERE run_id=? AND finding_id=? AND attempt=?')
          .get(proposal.runId, proposal.findingId, proposal.attempt);
        if (previous) {
          const record = get(z.object({ id: z.string() }).parse(previous).id);
          if (hashValue(record.proposal) !== hashValue(proposal))
            throw new RepairError('REPAIR_CONFLICT');
          return record;
        }
        if (
          proposal.attempt === 2 &&
          !database
            .prepare('SELECT 1 FROM repair_proposals WHERE run_id=? AND finding_id=? AND attempt=1')
            .get(proposal.runId, proposal.findingId)
        )
          throw new RepairError('REPAIR_ATTEMPT_ORDER');
        const record: RepairRecord = {
          id: randomUUID(),
          createdAt: now(),
          proposal,
          state: 'proposed',
          manifest: null,
          manifestHash: null,
          approval: null,
          progress: null,
          leaseToken: null,
          leaseUntil: 0,
        };
        database
          .prepare('INSERT INTO repair_proposals VALUES(?,?,?,?,?)')
          .run(
            record.id,
            proposal.runId,
            proposal.findingId,
            proposal.attempt,
            JSON.stringify(record),
          );
        return get(record.id);
      });
    },
    get,
    list(runId: string) {
      return database
        .prepare('SELECT id FROM repair_proposals WHERE run_id=? ORDER BY finding_id,attempt')
        .all(identifier.parse(runId))
        .map((row) => get(z.object({ id: z.string() }).parse(row).id));
    },
    recordVerification(input: unknown) {
      const request = checked(verificationSchema.extend({ proposalId: identifier }), input);
      return transaction(() => {
        const record = get(request.proposalId),
          verification = {
            before: request.before,
            after: request.after,
            regressions: request.regressions,
          };
        if (record.manifest) {
          if (hashValue(record.manifest.verification) !== hashValue(verification))
            throw new RepairError('VERIFICATION_CONFLICT');
          return record;
        }
        if (record.state !== 'proposed') throw new RepairError('INVALID_TRANSITION');
        const { before, after, regressions } = verification,
          proposal = record.proposal,
          receipts = [before, after, ...regressions];
        if (new Set(receipts.map((receipt) => receipt.id)).size !== receipts.length)
          throw new RepairError('VERIFICATION_REJECTED');
        if (
          receipts.some(
            (receipt) =>
              receipt.oracleHash !== proposal.oracleHash ||
              receipt.policyHash !== proposal.policyHash ||
              receipt.baseCommit !== proposal.baseCommit ||
              receipt.observedAt < record.createdAt ||
              receipt.observedAt > now(),
          )
        )
          throw new RepairError('VERIFICATION_REJECTED');
        if (
          before.outcome !== 'fail' ||
          before.exitCode === 0 ||
          before.failureCode !== proposal.failureCode ||
          before.diffHash !== null ||
          before.checkId !== after.checkId
        )
          throw new RepairError('VERIFICATION_REJECTED');
        if (
          [after, ...regressions].some(
            (receipt) =>
              receipt.outcome !== 'pass' ||
              receipt.exitCode !== 0 ||
              receipt.failureCode !== null ||
              receipt.diffHash !== proposal.diffHash ||
              receipt.observedAt < before.observedAt,
          )
        )
          throw new RepairError('VERIFICATION_REJECTED');
        if (
          regressions.length !== config.requiredRegressionChecks.length ||
          new Set(regressions.map((receipt) => receipt.checkId)).size !== regressions.length ||
          config.requiredRegressionChecks.some(
            (id) => !regressions.some((receipt) => receipt.checkId === id),
          )
        )
          throw new RepairError('VERIFICATION_REJECTED');
        record.manifest = {
          ...proposal,
          requiredRegressionChecks: [...config.requiredRegressionChecks],
          verification,
        };
        record.manifestHash = hashValue(record.manifest);
        record.state =
          proposal.verificationMode === 'local_replay'
            ? 'verified_local'
            : 'verified_polar_sandbox';
        return save(record);
      });
    },
    requestPublication(input: unknown) {
      const request = checked(
        z.strictObject({
          proposalId: identifier,
          title: z.string().min(1).max(200),
          body: z.string().min(1).max(40000),
        }),
        input,
      );
      return transaction(() => {
        const record = get(request.proposalId);
        if (!record.manifest || !record.manifestHash)
          throw new RepairError('VERIFICATION_REQUIRED');
        const manifest = record.manifest;
        const limitation =
          `Verification mode: ${manifest.verificationMode}.\n\n` +
          (manifest.verificationMode === 'local_replay'
            ? 'Local replay only. Polar integration was not verified. This pull request must remain a draft.'
            : 'Verified against the recorded Polar sandbox run; no production guarantee.');
        const receipts = [
          manifest.verification.before,
          manifest.verification.after,
          ...manifest.verification.regressions,
        ];
        const evidence = JSON.stringify(
          receipts.map((receipt) => ({
            id: receipt.id,
            check: receipt.checkId,
            outcome: receipt.outcome,
            exitCode: receipt.exitCode,
            artifactHash: receipt.artifactHash,
          })),
          null,
          2,
        ).replaceAll('`', '\\u0060');
        const args = {
          repository: manifest.repository,
          baseBranch: manifest.baseBranch,
          branch: manifest.branch,
          draft: manifest.verificationMode === 'local_replay',
          title: request.title,
          body: `${request.body}\n\n${marker(record.manifestHash)}\n\n${limitation}\n\nFinding: ${manifest.findingId} (${manifest.failureCode})\nProposed change: ${manifest.summary}\nRisk: Generated code still requires owner review. No merge or deployment is authorized.\n\nReport and reproduction: ${manifest.reportUrl}\nPolicy: ${manifest.policyHash}\nDiff: ${manifest.diffHash}\nUnchanged oracle: ${manifest.oracleHash}\n\nVerification receipts:\n\n\`\`\`json\n${evidence}\n\`\`\``,
        };
        if (record.approval) {
          if (hashValue(record.approval.args) !== hashValue(args))
            throw new RepairError('APPROVAL_STALE');
          return record;
        }
        if (!['verified_local', 'verified_polar_sandbox'].includes(record.state))
          throw new RepairError('INVALID_TRANSITION');
        record.approval = approvalSchema.parse({
          id: randomUUID(),
          bindingHash: hashValue({ manifest, args }),
          expiresAt: now() + 900000,
          decision: 'pending',
          args,
        });
        record.state = 'awaiting_publication';
        return save(record);
      });
    },
    decidePublication(input: unknown) {
      const request = checked(
        z.strictObject({
          proposalId: identifier,
          approvalId: identifier,
          bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
          decision: z.enum(['allow', 'deny']),
        }),
        input,
      );
      return transaction(() => {
        const record = get(request.proposalId),
          approval = record.approval;
        if (
          !approval ||
          approval.id !== request.approvalId ||
          approval.bindingHash !== request.bindingHash
        )
          throw new RepairError('APPROVAL_STALE');
        if (approval.decision !== 'pending') {
          if (approval.decision !== request.decision) throw new RepairError('APPROVAL_CONFLICT');
          return record;
        }
        if (now() >= approval.expiresAt || record.state !== 'awaiting_publication')
          throw new RepairError('APPROVAL_STALE');
        approval.decision = request.decision;
        if (request.decision === 'deny') record.state = 'abandoned';
        return save(record);
      });
    },
    // Trusted adapter coordination only; never expose these methods as model/HTTP tools.
    claimPublication(
      proposalId: string,
      approvalId: string,
      transportMode: 'github' | 'synthetic',
    ) {
      return transaction(() => {
        const record = get(proposalId);
        authorized(record, approvalId);
        if (record.progress && record.progress.transportMode !== transportMode)
          throw new RepairError('TRANSPORT_MODE_MISMATCH');
        if (record.progress?.result) return record;
        if (record.leaseToken && record.leaseUntil > now())
          throw new RepairError('PUBLICATION_IN_FLIGHT');
        record.progress ??= {
          transportMode,
          treeSha: null,
          commitSha: null,
          prAttempted: false,
          result: null,
        };
        record.leaseToken = randomUUID();
        record.leaseUntil = now() + 30000;
        return save(record);
      });
    },
    guardPublication(proposalId: string, approvalId: string, leaseToken: string, write: boolean) {
      return transaction(() => {
        const record = get(proposalId);
        authorized(record, approvalId);
        if (record.leaseToken !== leaseToken || record.leaseUntil < now())
          throw new RepairError('PUBLICATION_LEASE_LOST');
        if (write && (!record.approval || now() >= record.approval.expiresAt))
          throw new RepairError('APPROVAL_STALE');
        record.leaseUntil = now() + 30000;
        return save(record);
      });
    },
    saveProgress(proposalId: string, leaseToken: string, input: unknown) {
      const progress = checked(progressSchema, input);
      return transaction(() => {
        const record = get(proposalId);
        if (record.leaseToken !== leaseToken) throw new RepairError('PUBLICATION_LEASE_LOST');
        if (progress.transportMode !== record.progress?.transportMode)
          throw new RepairError('TRANSPORT_MODE_MISMATCH');
        record.progress = progress;
        return save(record);
      });
    },
    finishPublication(proposalId: string, leaseToken: string, input: unknown) {
      const result = checked(resultSchema, input);
      return transaction(() => {
        const record = get(proposalId);
        if (
          record.leaseToken !== leaseToken ||
          !record.progress ||
          result.receipt.manifestHash !== record.manifestHash ||
          result.receipt.transportMode !== record.progress.transportMode ||
          result.kind !== (result.receipt.transportMode === 'github' ? 'published' : 'synthetic')
        )
          throw new RepairError('PUBLICATION_RECEIPT_REJECTED');
        record.progress.result = result;
        record.leaseToken = null;
        record.leaseUntil = 0;
        if (result.kind === 'published') record.state = 'published';
        return save(record);
      });
    },
    releasePublication(proposalId: string, leaseToken: string) {
      transaction(() => {
        const record = get(proposalId);
        if (record.leaseToken === leaseToken) {
          record.leaseToken = null;
          record.leaseUntil = 0;
          save(record);
        }
      });
    },
    now,
    close() {
      database.close();
    },
  };
  return store;
}
export type RepairStore = ReturnType<typeof openRepairStore>;
