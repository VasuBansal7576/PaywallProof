import { z } from 'zod';
import { modeSchema, type RunDetail, type Scenario } from './contracts';

const identifier = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const observationSchema = z.object({
  id: identifier, runId: identifier, scenarioId: identifier, subjectId: identifier,
  source: z.enum(['stripe', 'application', 'api_probe', 'browser']), policyHash: digest, targetBuild: identifier,
  observedAt: z.number().int().nonnegative().max(8_640_000_000_000_000), billingTime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  mode: modeSchema, sha256: digest, payload: z.unknown(),
});
export type Observation = z.infer<typeof observationSchema>;
export const artifactSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.png$/),
  runId: identifier, observationId: identifier, sha256: digest,
  contentType: z.literal('image/png'), source: z.literal('browser'), collectedAt: z.iso.datetime({ offset: true }),
  sizeBytes: z.number().int().positive().optional(), expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export type Artifact = z.infer<typeof artifactSchema>;
export type EvidenceFacts = { kind: 'recorded'; observation: Observation; facts: Array<{ label: string; value: string }> } | { kind: 'unavailable'; reason: string };
const billingSchema = z.object({
  livemode: z.boolean(), identityResolved: z.boolean(), noSubscriptionConfirmed: z.boolean(), customerId: identifier.nullable(),
  subscription: z.object({ id: identifier, customerId: identifier, priceId: identifier, status: identifier, initialInvoicePaid: z.boolean(), cancelAtPeriodEnd: z.boolean(), periodEnd: z.number(), billingTime: z.number() }).nullable(),
});
const applicationSchema = z.object({ principalId: identifier, runId: identifier, customerId: identifier.nullable(), status: identifier, buildId: identifier });
const probeSchema = z.object({ status: z.number().int().min(100).max(599).nullable(), body: z.unknown(), transportError: z.boolean(), denialStatuses: z.array(z.number()) });
const probeBodySchema = z.object({ fixtureMarker: z.string().optional(), error: z.string().optional(), uiStatus: z.string().optional(), visibleText: z.string().optional() });

/** Presentation only. Worker verdicts are never recalculated from these labels. */
export function scenarioEvidence(detail: RunDetail, scenario: Scenario, source: Observation['source']): EvidenceFacts {
  const linked = detail.observations.flatMap(value => {
    const parsed = observationSchema.safeParse(value);
    return parsed.success && scenario.observationIds.includes(parsed.data.id) ? [parsed.data] : [];
  });
  const candidates = linked.filter(observation => observation.source === source);
  if (candidates.length !== 1) return { kind: 'unavailable', reason: candidates.length ? 'Multiple linked observations require inspection. No source summary was selected.' : 'No valid linked observation was recorded for this source.' };
  const [observation] = candidates;
  if (!observation) return { kind: 'unavailable', reason: 'No observation was recorded.' };
  if (new Set(linked.map(record => record.subjectId)).size !== 1) return { kind: 'unavailable', reason: 'The linked observations contain different principals. No combined scenario summary is available.' };
  if (observation.runId !== detail.run.id || observation.scenarioId !== scenario.id || observation.policyHash !== detail.run.policy.hash || observation.targetBuild !== detail.run.targetBuild || observation.mode !== detail.run.mode) return { kind: 'unavailable', reason: 'The linked observation does not match this run, scenario, policy, mode, and target build.' };
  const facts: Array<{ label: string; value: string }> = [];
  if (source === 'stripe') {
    const parsed = billingSchema.safeParse(observation.payload);
    if (!parsed.success) return { kind: 'unavailable', reason: 'The recorded provider payload has an unsupported shape. Inspect the raw observation.' };
    const billing = parsed.data;
    facts.push({ label: 'Billing source', value: observation.mode === 'local_replay' ? 'Synthetic local replay' : 'Stripe sandbox' }, { label: 'Identity resolved', value: billing.identityResolved ? 'Yes' : 'No' }, { label: 'Mode flag', value: billing.livemode ? 'Live mode, outside allowed scope' : 'Test mode' }, { label: 'Customer', value: billing.customerId ?? 'No customer recorded' });
    if (!billing.subscription) facts.push({ label: 'Subscription', value: billing.noSubscriptionConfirmed ? 'Absence confirmed' : 'Not resolved' });
    else facts.push({ label: 'Subscription', value: billing.subscription.id }, { label: 'Provider status', value: billing.subscription.status }, { label: 'Price', value: billing.subscription.priceId }, { label: 'Initial invoice paid', value: billing.subscription.initialInvoicePaid ? 'Yes' : 'No' }, { label: 'Cancel at period end', value: billing.subscription.cancelAtPeriodEnd ? 'Yes' : 'No' }, { label: 'Period boundary', value: `${billing.subscription.periodEnd} Unix seconds` });
  } else if (source === 'application') {
    const parsed = applicationSchema.safeParse(observation.payload);
    if (!parsed.success) return { kind: 'unavailable', reason: 'The recorded application payload has an unsupported shape. Inspect the raw observation.' };
    const application = parsed.data;
    if (application.principalId !== observation.subjectId || application.runId !== detail.run.id || application.buildId !== detail.run.targetBuild) return { kind: 'unavailable', reason: 'The stored application identity does not match its observation.' };
    facts.push({ label: 'Stored status', value: application.status }, { label: 'Customer mapping', value: application.customerId ?? 'No customer linked' }, { label: 'Principal', value: application.principalId });
  } else {
    const parsed = probeSchema.safeParse(observation.payload);
    if (!parsed.success) return { kind: 'unavailable', reason: 'The recorded probe payload has an unsupported shape. Inspect the raw observation.' };
    facts.push({ label: 'HTTP response', value: parsed.data.status === null ? 'No response recorded' : String(parsed.data.status) }, { label: 'Transport', value: parsed.data.transportError ? 'Error recorded' : 'Response recorded' });
    const body = probeBodySchema.safeParse(parsed.data.body);
    if (body.success) {
      if (body.data.error !== undefined) facts.push({ label: 'Response error field', value: body.data.error });
      facts.push({ label: 'Top-level fixture marker', value: body.data.fixtureMarker !== undefined ? 'Present in recorded body' : 'Not present in recorded body' });
      if (body.data.uiStatus !== undefined) facts.push({ label: 'UI result state', value: body.data.uiStatus });
      if (body.data.visibleText !== undefined) facts.push({ label: 'Recorded UI text', value: body.data.visibleText });
    }
  }
  return { kind: 'recorded', observation, facts };
}

export function linkedArtifacts(detail: RunDetail, observationIds: string[], scenarioId?: string): { artifacts: Artifact[]; invalidCount: number } {
  const browserIds = new Set(detail.observations.flatMap(value => {
    const parsed = observationSchema.safeParse(value);
    return parsed.success && parsed.data.runId === detail.run.id && parsed.data.source === 'browser' && observationIds.includes(parsed.data.id) && (scenarioId === undefined || parsed.data.scenarioId === scenarioId) && parsed.data.targetBuild === detail.run.targetBuild && parsed.data.policyHash === detail.run.policy.hash && parsed.data.mode === detail.run.mode ? [parsed.data.id] : [];
  }));
  const artifacts: Artifact[] = [];
  let invalidCount = 0;
  for (const value of detail.artifacts ?? []) {
    const parsed = artifactSchema.safeParse(value);
    if (!parsed.success || parsed.data.runId !== detail.run.id) { invalidCount++; continue; }
    if (browserIds.has(parsed.data.observationId)) artifacts.push(parsed.data);
  }
  return { artifacts, invalidCount };
}

export function expectedRule(scenarioId: string): string {
  switch (scenarioId) {
    case 'SC01': return 'An authenticated user with no subscription must be denied the protected export without receiving fixture data.';
    case 'SC02': return 'An active subscription for the configured price with a paid initial invoice permits the protected export.';
    case 'SC03': return 'Scheduled cancellation preserves paid access before the period boundary while the subscription is active.';
    case 'SC04': return 'After provider-confirmed cancellation and the synchronization deadline, the protected export must be denied without returning fixture data.';
    default: return 'This scenario is outside the declared core lifecycle. No expected rule has been inferred.';
  }
}
