import { z } from 'zod';
import { identifier } from '#domain';
import { SqliteControlDocuments } from './control-documents.ts';

const continuationFields = {
  sessionId: identifier,
  previousTurnId: identifier,
} as const;
const observedSchema = z.strictObject({
  status: z.literal('checkout_observed'),
  ...continuationFields,
});
const dispatchedSchema = z.strictObject({
  status: z.literal('dispatched'),
  ...continuationFields,
});
const confirmedSchema = z.strictObject({
  status: z.literal('confirmed'),
  ...continuationFields,
  turnId: identifier,
});
const unknownSchema = z.strictObject({
  status: z.literal('unknown'),
  ...continuationFields,
  reason: z.enum(['RUNTIME_CONTINUATION_NOT_FOUND', 'RUNTIME_LOOKUP_UNAVAILABLE']).optional(),
});
const checkoutContinuationSchema = z.discriminatedUnion('status', [
  observedSchema,
  dispatchedSchema,
  confirmedSchema,
  unknownSchema,
]);

type CheckoutObserved = z.infer<typeof observedSchema>;
type CheckoutDispatched = z.infer<typeof dispatchedSchema>;
type CheckoutConfirmed = z.infer<typeof confirmedSchema>;
type CheckoutPending = CheckoutObserved | CheckoutDispatched;
type CheckoutContinuation = z.infer<typeof checkoutContinuationSchema>;
type ResumeRuntimeState =
  | { status: 'running' }
  | { status: 'error'; error: 'RUN_STOPPED_AFTER_CONTINUATION' };

/** Persists checkout state and makes confirmation indivisible from runtime resumption. */
export class CheckoutContinuationStore {
  constructor(private readonly documents: SqliteControlDocuments) {}

  load(runId: string): CheckoutContinuation | null {
    return checkoutContinuationSchema
      .nullable()
      .parse(this.documents.get('checkout-continuation', runId));
  }

  observe(
    runId: string,
    input: Pick<CheckoutObserved, 'sessionId' | 'previousTurnId'>,
  ): CheckoutObserved {
    const continuation: CheckoutObserved = { status: 'checkout_observed', ...input };
    this.documents.put('checkout-continuation', runId, continuation);
    return continuation;
  }

  dispatch(runId: string, continuation: CheckoutObserved): CheckoutDispatched {
    const dispatched: CheckoutDispatched = { ...continuation, status: 'dispatched' };
    this.documents.put('checkout-continuation', runId, dispatched);
    return dispatched;
  }

  confirm(
    runId: string,
    continuation: CheckoutPending,
    turnId: string,
    runtime: ResumeRuntimeState = { status: 'running' },
  ): CheckoutConfirmed {
    const confirmed = confirmedSchema.parse({
      status: 'confirmed',
      sessionId: continuation.sessionId,
      previousTurnId: continuation.previousTurnId,
      turnId,
    });
    this.commitResume(runId, confirmed, runtime);
    return confirmed;
  }

  restore(
    runId: string,
    continuation: CheckoutConfirmed,
    runtime: ResumeRuntimeState = { status: 'running' },
  ) {
    this.commitResume(runId, continuation, runtime);
  }

  private commitResume(
    runId: string,
    continuation: CheckoutConfirmed,
    runtime: ResumeRuntimeState,
  ) {
    this.documents.putAll([
      { kind: 'checkout-continuation', id: runId, value: continuation },
      {
        kind: 'runtime',
        id: runId,
        value: {
          sessionId: continuation.sessionId,
          turnId: continuation.turnId,
          lastSequenceNumber: 0,
          ...runtime,
        },
      },
    ]);
  }
}
