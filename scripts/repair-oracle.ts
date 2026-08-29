import { runRepairOracle } from '#repair/oracle';
import {
  oracleAckSchema,
  oracleExitCode,
  oracleProcessStartSchema,
  validateOracleOutputPaths,
  validateOracleReport,
  validateOracleRoutes,
} from '#repair/oracle-process';
import { parseJson, parsePolicy } from '#domain';

// A fixed trusted host worker. It never imports source from the sandbox target.
const LIMIT = 8 * 1024 * 1024;
let started = false,
  finished = false,
  routeId = 0;
const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
const abort = new AbortController();
const startTimeout = setTimeout(() => finishError(), 10_000);
let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
function send(frame: unknown) {
  return new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected || Buffer.byteLength(JSON.stringify(frame)) > LIMIT) {
      reject(new Error('ORACLE_IPC_UNAVAILABLE'));
      return;
    }
    process.send(frame, (error) => (error ? reject(error) : resolve()));
  });
}
function stop() {
  clearTimeout(startTimeout);
  if (deadlineTimer) clearTimeout(deadlineTimer);
}
function finishError() {
  if (finished) return;
  finished = true;
  stop();
  abort.abort();
  for (const item of pending.values()) item.reject(new Error('ORACLE_ABORTED'));
  pending.clear();
  void send({ type: 'error', code: 'ORACLE_FAILED' }).finally(() => process.exit(2));
}
process.on('disconnect', finishError);
process.on('SIGTERM', finishError);
process.on('message', (raw: unknown) => {
  if (finished) return;
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > LIMIT) throw new Error('ORACLE_INPUT_LIMIT');
    const message = parseJson(raw);
    if (started) {
      const ack = oracleAckSchema.parse(message),
        waiting = pending.get(ack.id);
      if (!waiting) throw new Error('ORACLE_ACK_REJECTED');
      pending.delete(ack.id);
      waiting.resolve();
      return;
    }
    const input = oracleProcessStartSchema.parse(message),
      startedAt = Date.now();
    if (
      input.deadline <= startedAt ||
      input.deadline - startedAt > 900_000 ||
      parsePolicy(input.policy).hash !== input.plan.policyHash
    )
      throw new Error('ORACLE_INPUT_REJECTED');
    started = true;
    clearTimeout(startTimeout);
    deadlineTimer = setTimeout(() => {
      abort.abort();
      finishError();
    }, input.deadline - startedAt);
    void (async () => {
      await validateOracleOutputPaths(input.databasePath, input.artifactDirectory);
      const result = await runRepairOracle({
        ...input,
        signal: abort.signal,
        target: {
          ...input.target,
          registerRoutes: async (routes) => {
            const frame = validateOracleRoutes(
              { type: 'register', id: ++routeId, routes },
              input.plan.runId,
            );
            const acknowledged = new Promise<void>((resolve, reject) =>
              pending.set(frame.id, { resolve, reject }),
            );
            void acknowledged.catch(() => {});
            await send(frame);
            await acknowledged;
            abort.signal.throwIfAborted();
          },
        },
      });
      const checked = validateOracleReport(result, input, startedAt),
        exitCode = oracleExitCode(checked);
      if (pending.size || finished) throw new Error('ORACLE_INCOMPLETE');
      await send({ type: 'result', result: checked });
      finished = true;
      stop();
      process.exit(exitCode);
    })().catch(finishError);
  } catch {
    finishError();
  }
});
if (!process.send) finishError();
