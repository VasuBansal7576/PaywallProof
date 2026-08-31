import { z } from 'zod';
import { adapterDoctorReportSchema } from '#adapter-doctor';
import { targetFeatureSchema } from '#integrations/target-contract';

export const modeSchema = z.enum(['polar_sandbox', 'local_replay']);
export type Mode = z.infer<typeof modeSchema>;
export const configSchema = z.object({
  target: z.object({ id: z.string(), origin: z.string() }),
  repository: z.string(),
  defaultRef: z.string(),
  reviewSkill: z.object({ repository: z.string(), ref: z.string() }),
  polarConfigured: z.boolean(),
  priceId: z.string(),
  model: z.string(),
  limits: z.record(z.string(), z.unknown()),
  coverageLimits: z.array(z.string()),
});
export type Config = z.infer<typeof configSchema>;
export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  repository: z.string(),
  ref: z.string(),
  targetId: z.string(),
  targetOrigin: z.string().nullable(),
  modelConsentModel: z.string().nullable(),
  ownershipConfirmed: z.boolean(),
  modelConsent: z.boolean(),
});
export type Project = z.infer<typeof projectSchema>;
export const policySchema = z.object({
  schemaVersion: z.literal(2),
  priceId: z.string(),
  featureId: z.string(),
  featureConfigHash: z.string(),
  cancellation: z.literal('allow_until_period_end'),
  requireInitialPaymentConfirmed: z.literal(true),
  syncWindowSeconds: z.number(),
  predicateVersion: z.string(),
  hash: z.string(),
});
export type Policy = z.infer<typeof policySchema>;
export const runSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  policy: policySchema,
  targetBuild: z.string(),
  featureConfigHash: z.string(),
  featureProbeHash: z.string().optional(),
  targetFeature: targetFeatureSchema.optional(),
  projectConfigHash: z.string().optional(),
  cleanupConfigHash: z.string().optional(),
  mode: modeSchema,
  status: z.enum(['awaiting_plan_approval', 'running', 'stopping', 'completed', 'canceled']),
  outcome: z.enum(['passed', 'failed', 'inconclusive']).nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  verdicts: z.array(z.string()),
  approval: z.object({
    id: z.string(),
    bindingHash: z.string(),
    expiresAt: z.number(),
    decision: z.enum(['pending', 'allow', 'deny']),
  }),
});
export type Run = z.infer<typeof runSchema>;
const assertionSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'inconclusive', 'unsupported', 'skipped']),
  code: z.string(),
});
const cleanupReceiptSchema = z.object({
  resourceId: z.string(),
  status: z.enum(['deleted', 'retained', 'leftover']),
  code: z.string().optional(),
});
export const scenarioSchema = z.object({
  id: z.string(),
  api: assertionSchema,
  browser: assertionSchema,
  state: assertionSchema,
  observationIds: z.array(z.string()),
});
export type Scenario = z.infer<typeof scenarioSchema>;
const evidenceReviewSchema = z.object({
  runId: z.string(),
  attempt: z.number().int().positive().default(1),
  status: z.enum(['starting', 'running', 'completed', 'error']),
  reportHash: z.string(),
  createdAt: z.number(),
  sessionId: z.string().nullable(),
  turnId: z.string().nullable(),
  error: z.string().nullable(),
  skill: z.object({
    name: z.literal('paywallproof-evidence-review'),
    repository: z.string().optional(),
    ref: z.string(),
    path: z.string(),
    dynamicSubAgents: z.literal(true),
  }),
  verdict: z.enum(['confirmed', 'needs_attention', 'inconclusive']).optional(),
  summary: z.string().optional(),
  reviewers: z.array(z.unknown()).optional(),
  completedAt: z.number().optional(),
  reportCurrent: z.boolean().default(true),
});
const controlErrorReceiptSchema = z.object({
  code: z.string().default('CONTROL_OPERATION_FAILED'),
  message: z.string(),
});
const operationReconciliationSchema = z.object({
  status: z.enum(['manual_review', 'safe_cleanup']),
  operations: z.array(
    z.object({
      operationId: z.string(),
      kind: z.string(),
      state: z.enum(['dispatched', 'unknown']),
      argsHash: z.string(),
    }),
  ),
});
const continuationReconciliationSchema = z.object({
  status: z.enum(['reconciled', 'unknown']),
  continuations: z.array(
    z.object({
      kind: z.enum(['plan', 'checkout']),
      status: z.enum(['confirmed', 'unknown']),
      previousTurnId: z.string(),
      turnId: z.string().optional(),
      code: z.enum(['RUNTIME_CONTINUATION_NOT_FOUND', 'RUNTIME_LOOKUP_UNAVAILABLE']).optional(),
    }),
  ),
});
export const detailSchema = z.object({
  run: runSchema,
  runtime: z
    .object({
      sessionId: z.string(),
      turnId: z.string(),
      lastSequenceNumber: z.number(),
      status: z.string(),
      error: z.unknown().optional(),
      pendingApprovals: z.unknown().optional(),
    })
    .nullable(),
  runtimeError: controlErrorReceiptSchema.nullable().optional(),
  runtimeCancelError: controlErrorReceiptSchema.nullable().optional(),
  stopError: controlErrorReceiptSchema.nullable().optional(),
  operationReconciliation: operationReconciliationSchema.nullable().optional(),
  continuationReconciliation: continuationReconciliationSchema.nullable().optional(),
  artifacts: z.array(z.unknown()).optional(),
  scenarios: z.array(scenarioSchema),
  observations: z.array(z.unknown()),
  cleanup: z.array(cleanupReceiptSchema),
  repairs: z.array(z.unknown()),
  repairSupported: z.boolean().default(false),
  evidenceReview: evidenceReviewSchema.nullable().optional(),
  coverageLimits: z.array(z.string()),
});
export type RunDetail = z.infer<typeof detailSchema>;
export const eventSchema = z.object({
  sequence: z.number(),
  type: z.string(),
  payload: z.unknown(),
  occurredAt: z.number(),
});
export type RunEvent = z.infer<typeof eventSchema>;
const connectionCheckSchema = z.strictObject({
  name: z.string(),
  status: z.enum(['pass', 'blocked']),
  detail: z.string(),
});
export const preflightSchema = z.strictObject({
  ready: z.boolean(),
  adapter: adapterDoctorReportSchema,
  connections: z.array(connectionCheckSchema),
});
export type Preflight = z.infer<typeof preflightSchema>;

export const scenarios = [
  {
    id: 'SC01',
    title: 'Free user',
    description: 'An ordinary free user cannot export protected data.',
  },
  {
    id: 'SC02',
    title: 'Paid activation',
    description: 'An active subscription with a paid initial order can export.',
  },
  {
    id: 'SC03',
    title: 'Scheduled cancellation',
    description: 'Access continues before the paid period ends.',
  },
  {
    id: 'SC04',
    title: 'Cancellation boundary',
    description: 'Confirmed cancellation removes protected access.',
  },
];
