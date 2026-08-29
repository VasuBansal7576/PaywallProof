import { z } from 'zod';

export const modeSchema = z.enum(['polar_sandbox', 'local_replay']);
export type Mode = z.infer<typeof modeSchema>;
export const configSchema = z.object({
  target: z.object({ id: z.literal('reference'), origin: z.string() }),
  repository: z.string(),
  defaultRef: z.string(),
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
  targetId: z.literal('reference'),
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
  projectConfigHash: z.string().optional(),
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
    ref: z.string(),
    path: z.string(),
    dynamicSubAgents: z.literal(true),
  }),
  verdict: z.enum(['confirmed', 'needs_attention', 'inconclusive']).optional(),
  summary: z.string().optional(),
  reviewers: z.array(z.unknown()).optional(),
  completedAt: z.number().optional(),
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
  runtimeError: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
  artifacts: z.array(z.unknown()).optional(),
  scenarios: z.array(scenarioSchema),
  observations: z.array(z.unknown()),
  cleanup: z.unknown(),
  repairs: z.array(z.unknown()),
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
export const preflightSchema = z.object({
  ready: z.boolean(),
  checks: z.array(
    z.object({ name: z.string(), status: z.enum(['pass', 'blocked']), detail: z.string() }),
  ),
  featureConfigHash: z.string().optional(),
  target: z
    .object({ buildId: z.string(), feature: z.unknown().optional() })
    .passthrough()
    .optional(),
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
