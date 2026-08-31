import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  aggregateVerdicts,
  digest,
  hashValue,
  identifier,
  parseJson,
  parsePolicy,
  policySchema,
  verdictSchema,
} from '#domain';
import { bindTargetFeatureProbe, targetFeatureSchema } from '#integrations/target-contract';

export class ControlError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const createSchema = z.strictObject({
  projectId: identifier,
  policy: policySchema,
  targetBuild: identifier,
  featureConfigHash: digest,
  featureProbeHash: digest.optional(),
  targetFeature: targetFeatureSchema.optional(),
  mode: z.enum(['polar_sandbox', 'local_replay']),
  projectConfigHash: digest.optional(),
  cleanupConfigHash: digest.optional(),
});
export const runSchema = createSchema.extend({
  id: identifier,
  status: z.enum(['awaiting_plan_approval', 'running', 'stopping', 'completed', 'canceled']),
  outcome: z.enum(['passed', 'failed', 'inconclusive']).nullable(),
  createdAt: milliseconds,
  startedAt: milliseconds.nullable(),
  verdicts: z.array(verdictSchema),
  approval: z.strictObject({
    id: identifier,
    bindingHash: digest,
    expiresAt: milliseconds,
    decision: z.enum(['pending', 'allow', 'deny']),
  }),
});
export type RunRecord = z.infer<typeof runSchema>;
const decisionSchema = z.strictObject({
  runId: identifier,
  approvalId: identifier,
  bindingHash: digest,
  decision: z.enum(['allow', 'deny']),
});
const operationKind = z.enum([
  'prepare_fixture',
  'change_test_subscription',
  'await_period_end',
  'probe_feature',
  'cleanup_run',
]);
const claimSchema = z.strictObject({
  runId: identifier,
  operationId: identifier,
  kind: operationKind,
  args: z.record(z.string(), z.unknown()),
  approvalId: identifier,
  leaseMs: z.number().int().min(1).max(30000),
});
const confirmedOperationSchema = z.strictObject({
  runId: identifier,
  operationId: identifier,
  kind: operationKind,
  args: z.record(z.string(), z.unknown()),
});
const operationSchema = z.strictObject({
  operationId: identifier,
  runId: identifier,
  kind: operationKind,
  args: z.record(z.string(), z.unknown()).optional(),
  argsHash: digest,
  state: z.enum(['dispatched', 'unknown', 'confirmed']),
  idempotencyKey: identifier,
  leaseUntil: milliseconds,
  receipt: z.unknown(),
});
export type RunOperation = z.infer<typeof operationSchema>;
type Operation = RunOperation;
const operationQuerySchema = z.strictObject({
  runId: identifier,
  states: z
    .array(z.enum(['dispatched', 'unknown', 'confirmed']))
    .max(3)
    .optional(),
});
const eventSchema = z.object({
  sequence: z.number().int(),
  type: identifier,
  payload: z.unknown(),
  occurredAt: milliseconds,
});
const externalWaitSchema = z.strictObject({
  runId: identifier,
  waitId: identifier,
  startedAt: milliseconds,
  endedAt: milliseconds,
});
const externalWaitCreditRequestSchema = externalWaitSchema.pick({ runId: true, waitId: true });
const externalWaitCreditSchema = externalWaitSchema.pick({ startedAt: true, endedAt: true });
export const RUN_LIMITS = Object.freeze({
  users: 2,
  customers: 1,
  checkouts: 1,
  subscriptions: 1,
  operations: 100,
  activeMilliseconds: 900000,
  approvalMilliseconds: 900000,
  externalWaitMilliseconds: 24 * 60 * 60 * 1000,
});

function boundary<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof ControlError) throw error;
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      (error instanceof Error && /JSON|POLICY_HASH/.test(error.message))
    )
      throw new ControlError('INVALID_INPUT');
    throw error;
  }
}
export function openRunStore(options: { path: string; clock?: () => number }) {
  const path = identifier.parse(options.path);
  const clock = options.clock ?? Date.now;
  const database = new Database(path);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,active INTEGER NOT NULL,record TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(project_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS operations_run ON operations(run_id);
    CREATE TABLE IF NOT EXISTS run_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,occurred_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS external_wait_credits(run_id TEXT NOT NULL,wait_id TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER NOT NULL,PRIMARY KEY(run_id,wait_id));
  `);
  const now = () => milliseconds.parse(clock());
  function loadRun(id: unknown): RunRecord {
    const row = database.prepare('SELECT record FROM runs WHERE id=?').get(identifier.parse(id));
    if (!row) throw new ControlError('NOT_FOUND');
    return runSchema.parse(JSON.parse(z.object({ record: z.string() }).parse(row).record));
  }
  function saveRun(run: RunRecord) {
    database
      .prepare('UPDATE runs SET active=?,record=? WHERE id=?')
      .run(
        ['running', 'stopping', 'awaiting_plan_approval'].includes(run.status) ? 1 : 0,
        JSON.stringify(run),
        run.id,
      );
  }
  function event(runId: string, type: string, payload: unknown) {
    database
      .prepare('INSERT INTO run_events(run_id,type,payload,occurred_at) VALUES(?,?,?,?)')
      .run(runId, type, JSON.stringify(payload), now());
  }
  function loadOperation(id: string): Operation | undefined {
    const row = database.prepare('SELECT record FROM operations WHERE id=?').get(id);
    return row
      ? operationSchema.parse(JSON.parse(z.object({ record: z.string() }).parse(row).record))
      : undefined;
  }
  function saveOperation(operation: Operation) {
    database
      .prepare('UPDATE operations SET record=? WHERE id=?')
      .run(JSON.stringify(operation), operation.operationId);
  }
  function transactional<T>(action: () => T): T {
    return boundary(() => database.transaction(action).immediate());
  }
  return {
    createRun(input: unknown): RunRecord {
      return transactional(() => {
        const config = createSchema.parse(parseJson(input));
        const policy = parsePolicy(config.policy);
        if (config.featureConfigHash !== policy.featureConfigHash)
          throw new ControlError('INVALID_INPUT');
        if (
          config.targetFeature !== undefined &&
          (hashValue(config.targetFeature) !== config.featureConfigHash ||
            config.targetFeature.id !== policy.featureId)
        )
          throw new ControlError('INVALID_INPUT');
        if (
          config.featureProbeHash !== undefined &&
          (config.targetFeature === undefined ||
            bindTargetFeatureProbe(config.targetFeature).hash !== config.featureProbeHash)
        )
          throw new ControlError('INVALID_INPUT');
        if (
          database
            .prepare('SELECT 1 FROM runs WHERE project_id=? AND active=1')
            .get(config.projectId)
        )
          throw new ControlError('ACTIVE_RUN_CONFLICT');
        const id = randomUUID(),
          time = now();
        const bindingHash = hashValue({
          runId: id,
          ...config,
          scenarios: ['SC01', 'SC02', 'SC03', 'SC04'],
          limits: RUN_LIMITS,
        });
        const run: RunRecord = {
          ...config,
          policy,
          id,
          status: 'awaiting_plan_approval',
          outcome: null,
          createdAt: time,
          startedAt: null,
          verdicts: [],
          approval: {
            id: randomUUID(),
            bindingHash,
            expiresAt: time + RUN_LIMITS.approvalMilliseconds,
            decision: 'pending',
          },
        };
        database
          .prepare('INSERT INTO runs VALUES(?,?,1,?)')
          .run(id, config.projectId, JSON.stringify(run));
        event(id, 'run.created', { policyHash: policy.hash, mode: config.mode });
        return run;
      });
    },
    getRun(id: unknown): RunRecord {
      return boundary(() => loadRun(id));
    },
    /**
     * Returns a durable receipt before checking mutable live-run preconditions.
     * Exact retries remain readable after completion or configuration drift; changed
     * arguments under the same operation ID remain a conflict.
     */
    confirmedOperation(input: unknown): Operation | null {
      return boundary(() => {
        const request = confirmedOperationSchema.parse(parseJson(input, 36));
        const args = parseJson(request.args);
        const run = loadRun(request.runId);
        const operation = loadOperation(request.operationId);
        if (!operation) return null;
        if (operation.runId !== run.id) throw new ControlError('OWNERSHIP_MISMATCH');
        if (operation.kind !== request.kind || operation.argsHash !== hashValue(args))
          throw new ControlError('OPERATION_CONFLICT');
        return operation.state === 'confirmed' ? operation : null;
      });
    },
    decidePlan(input: unknown): RunRecord {
      return transactional(() => {
        const decision = decisionSchema.parse(parseJson(input));
        const run = loadRun(decision.runId);
        if (
          decision.approvalId !== run.approval.id ||
          decision.bindingHash !== run.approval.bindingHash
        )
          throw new ControlError('APPROVAL_STALE');
        if (run.approval.decision !== 'pending') {
          if (run.approval.decision !== decision.decision)
            throw new ControlError('APPROVAL_CONFLICT');
          return run;
        }
        if (now() >= run.approval.expiresAt || run.status !== 'awaiting_plan_approval')
          throw new ControlError('APPROVAL_STALE');
        run.approval.decision = decision.decision;
        run.status = decision.decision === 'allow' ? 'running' : 'canceled';
        run.startedAt = decision.decision === 'allow' ? now() : null;
        saveRun(run);
        event(run.id, 'plan.decided', {
          decision: decision.decision,
          bindingHash: decision.bindingHash,
        });
        return run;
      });
    },
    externalWaitCredit(input: unknown): z.infer<typeof externalWaitCreditSchema> | null {
      return boundary(() => {
        const request = externalWaitCreditRequestSchema.parse(parseJson(input));
        loadRun(request.runId);
        const credit = database
          .prepare(
            'SELECT started_at AS startedAt,ended_at AS endedAt FROM external_wait_credits WHERE run_id=? AND wait_id=?',
          )
          .get(request.runId, request.waitId);
        return credit === undefined ? null : externalWaitCreditSchema.parse(credit);
      });
    },
    creditExternalWait(input: unknown): RunRecord {
      return transactional(() => {
        const request = externalWaitSchema.parse(parseJson(input));
        const run = loadRun(request.runId);
        const previous = database
          .prepare(
            'SELECT started_at AS startedAt,ended_at AS endedAt FROM external_wait_credits WHERE run_id=? AND wait_id=?',
          )
          .get(request.runId, request.waitId);
        if (previous) {
          const credited = externalWaitCreditSchema.parse(previous);
          if (credited.startedAt !== request.startedAt || credited.endedAt !== request.endedAt)
            throw new ControlError('OPERATION_CONFLICT');
          return run;
        }
        if (
          run.status !== 'running' ||
          run.approval.decision !== 'allow' ||
          run.startedAt === null ||
          request.startedAt < run.startedAt ||
          request.endedAt < request.startedAt ||
          request.endedAt > now() ||
          request.endedAt - request.startedAt > RUN_LIMITS.externalWaitMilliseconds
        )
          throw new ControlError('INVALID_TRANSITION');
        run.startedAt += request.endedAt - request.startedAt;
        database
          .prepare('INSERT INTO external_wait_credits VALUES(?,?,?,?)')
          .run(request.runId, request.waitId, request.startedAt, request.endedAt);
        saveRun(run);
        event(run.id, 'run.external_wait_credited', {
          waitId: request.waitId,
          durationMs: request.endedAt - request.startedAt,
        });
        return run;
      });
    },
    claimOperation(input: unknown): {
      kind: 'dispatch' | 'confirmed' | 'unknown' | 'in_flight';
      operation: Operation;
    } {
      return transactional(() => {
        const claim = claimSchema.parse(parseJson(input, 36));
        const args = z.record(z.string(), z.unknown()).parse(parseJson(claim.args));
        const run = loadRun(claim.runId);
        const previous = loadOperation(claim.operationId);
        if (previous && previous.runId !== run.id) throw new ControlError('OWNERSHIP_MISMATCH');
        if (
          run.status !== 'running' ||
          run.approval.decision !== 'allow' ||
          claim.approvalId !== run.approval.id
        )
          throw new ControlError('APPROVAL_REQUIRED');
        const argsHash = hashValue(args);
        if (previous) {
          if (previous.kind !== claim.kind || previous.argsHash !== argsHash)
            throw new ControlError('OPERATION_CONFLICT');
          if (previous.state === 'confirmed') return { kind: 'confirmed', operation: previous };
          if (previous.state === 'unknown') return { kind: 'unknown', operation: previous };
          if (now() >= previous.leaseUntil) {
            previous.state = 'unknown';
            saveOperation(previous);
            event(run.id, 'operation.unknown', { operationId: previous.operationId });
            return { kind: 'unknown', operation: previous };
          }
          return { kind: 'in_flight', operation: previous };
        }
        if (run.startedAt === null || now() - run.startedAt >= RUN_LIMITS.activeMilliseconds)
          throw new ControlError('EXECUTION_DEADLINE');
        const count = z
          .object({ count: z.number() })
          .parse(
            database.prepare('SELECT count(*) AS count FROM operations WHERE run_id=?').get(run.id),
          ).count;
        if (count >= RUN_LIMITS.operations) throw new ControlError('OPERATION_LIMIT');
        const operation: Operation = {
          operationId: claim.operationId,
          runId: run.id,
          kind: claim.kind,
          args,
          argsHash,
          state: 'dispatched',
          idempotencyKey: `pp:${run.id}:${claim.operationId}:${argsHash}`,
          leaseUntil: now() + claim.leaseMs,
          receipt: null,
        };
        database
          .prepare('INSERT INTO operations VALUES(?,?,?)')
          .run(operation.operationId, run.id, JSON.stringify(operation));
        event(run.id, 'operation.dispatched', {
          operationId: operation.operationId,
          kind: operation.kind,
          argsHash,
        });
        return { kind: 'dispatch', operation };
      });
    },
    operations(input: unknown): RunOperation[] {
      return boundary(() => {
        const request = operationQuerySchema.parse(parseJson(input));
        loadRun(request.runId);
        const states = request.states ? new Set(request.states) : null;
        return database
          .prepare('SELECT record FROM operations WHERE run_id=? ORDER BY id')
          .all(request.runId)
          .map((row) =>
            operationSchema.parse(JSON.parse(z.object({ record: z.string() }).parse(row).record)),
          )
          .filter((operation) => !states || states.has(operation.state));
      });
    },
    abandonDispatched(input: unknown): RunOperation[] {
      return transactional(() => {
        const request = z.strictObject({ runId: identifier }).parse(parseJson(input));
        loadRun(request.runId);
        const operations = database
          .prepare('SELECT record FROM operations WHERE run_id=? ORDER BY id')
          .all(request.runId)
          .map((row) =>
            operationSchema.parse(JSON.parse(z.object({ record: z.string() }).parse(row).record)),
          );
        for (const operation of operations) {
          if (operation.state !== 'dispatched') continue;
          operation.state = 'unknown';
          saveOperation(operation);
          event(request.runId, 'operation.unknown', { operationId: operation.operationId });
        }
        return operations
          .filter((operation) => operation.state === 'unknown')
          .map((operation) => operationSchema.parse(parseJson(operation)));
      });
    },
    confirmOperation(input: unknown): Operation {
      return transactional(() => {
        const request = z
          .strictObject({ runId: identifier, operationId: identifier, receipt: z.unknown() })
          .parse(parseJson(input, 36));
        const receipt = parseJson(request.receipt);
        loadRun(request.runId);
        const operation = loadOperation(request.operationId);
        if (!operation) throw new ControlError('NOT_FOUND');
        if (operation.runId !== request.runId) throw new ControlError('OWNERSHIP_MISMATCH');
        if (operation.state === 'confirmed') {
          if (hashValue(operation.receipt) !== hashValue(receipt))
            throw new ControlError('OPERATION_CONFLICT');
          return operation;
        }
        operation.state = 'confirmed';
        operation.receipt = receipt;
        saveOperation(operation);
        event(request.runId, 'operation.confirmed', { operationId: operation.operationId });
        return operation;
      });
    },
    cancelRun(id: unknown): RunRecord {
      return transactional(() => {
        const run = loadRun(id);
        if (run.status === 'completed' || run.status === 'canceled') return run;
        run.status = 'canceled';
        saveRun(run);
        event(run.id, 'run.canceled', {});
        return run;
      });
    },
    requestStop(id: unknown): RunRecord {
      return transactional(() => {
        const run = loadRun(id);
        if (['completed', 'canceled', 'stopping'].includes(run.status)) return run;
        run.status = 'stopping';
        saveRun(run);
        event(run.id, 'run.stopping', {});
        return run;
      });
    },
    finishRun(input: unknown): RunRecord {
      return transactional(() => {
        const request = z
          .strictObject({ runId: identifier, verdicts: z.array(verdictSchema) })
          .parse(parseJson(input));
        const run = loadRun(request.runId);
        if (run.status === 'completed' && hashValue(run.verdicts) === hashValue(request.verdicts))
          return run;
        if (run.status !== 'running') throw new ControlError('INVALID_TRANSITION');
        run.status = 'completed';
        run.verdicts = request.verdicts;
        run.outcome = aggregateVerdicts(request.verdicts);
        saveRun(run);
        event(run.id, 'run.completed', { outcome: run.outcome, verdicts: run.verdicts });
        return run;
      });
    },
    events(input: unknown) {
      return boundary(() => {
        const request = z
          .strictObject({ runId: identifier, after: milliseconds })
          .parse(parseJson(input));
        loadRun(request.runId);
        return database
          .prepare(
            'SELECT sequence,type,payload,occurred_at AS occurredAt FROM run_events WHERE run_id=? AND sequence>? ORDER BY sequence',
          )
          .all(request.runId, request.after)
          .map((row) => {
            const parsed = eventSchema.extend({ payload: z.string() }).parse(row);
            return { ...parsed, payload: parseJson(JSON.parse(parsed.payload)) };
          });
      });
    },
    close() {
      database.close();
    },
  };
}
