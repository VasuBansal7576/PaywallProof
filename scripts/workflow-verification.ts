import { z } from 'zod';

const pass = z.object({ verdict: z.literal('pass') });
const completed = z.object({
  run: z.object({
    status: z.literal('completed'),
    outcome: z.literal('passed'),
    mode: z.literal('local_replay'),
  }),
  scenarios: z
    .array(
      z.object({
        id: z.enum(['SC01', 'SC02', 'SC03', 'SC04']),
        api: pass,
        browser: pass,
        state: pass,
      }),
    )
    .length(4),
  cleanup: z
    .array(z.object({ resourceId: z.string().min(1), status: z.literal('deleted') }))
    .length(2),
});

const scenarioId = z.enum(['SC01', 'SC02', 'SC03', 'SC04']);
const evidenceSource = z.enum(['billing_provider', 'application', 'api_probe', 'browser']);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const polarCompleted = z.object({
  run: z.object({
    id: z.string().min(1),
    status: z.literal('completed'),
    outcome: z.literal('passed'),
    mode: z.literal('polar_sandbox'),
  }),
  scenarios: z
    .array(
      z.object({
        id: scenarioId,
        api: pass,
        browser: pass,
        state: pass,
        observationIds: z.array(z.string().min(1)).length(4),
      }),
    )
    .length(4),
  observations: z.array(
    z.object({
      id: z.string().min(1),
      runId: z.string().min(1),
      scenarioId,
      source: evidenceSource,
      mode: z.literal('polar_sandbox'),
      sha256: digest,
    }),
  ),
  artifacts: z.array(
    z.object({
      id: z.string().min(1),
      observationId: z.string().min(1),
      source: z.literal('browser'),
      contentType: z.literal('image/png'),
      sha256: digest,
    }),
  ),
  cleanup: z.array(
    z.object({
      resourceId: z.string().min(1),
      status: z.enum(['deleted', 'retained', 'leftover']),
      code: z.string().optional(),
    }),
  ),
});

function sameMembers(actual: Iterable<string>, expected: Iterable<string>): boolean {
  const actualSet = new Set(actual),
    expectedSet = new Set(expected);
  return (
    actualSet.size === expectedSet.size && [...actualSet].every((member) => expectedSet.has(member))
  );
}

/** A controller's overall label alone is not sufficient acceptance evidence. */
export function assertLocalWorkflowComplete(input: unknown): void {
  const receipt = completed.parse(input);
  if (new Set(receipt.scenarios.map((scenario) => scenario.id)).size !== 4)
    throw Error('WORKFLOW_SCENARIO_IDENTITY_INVALID');
  if (new Set(receipt.cleanup.map((resource) => resource.resourceId)).size !== 2)
    throw Error('WORKFLOW_CLEANUP_IDENTITY_INVALID');
}

/** Native acceptance requires complete evidence bindings, not only a provider checkout. */
export function assertPolarWorkflowComplete(input: unknown): void {
  const receipt = polarCompleted.parse(input);
  const expectedScenarios = scenarioId.options;
  if (
    !sameMembers(
      receipt.scenarios.map((scenario) => scenario.id),
      expectedScenarios,
    )
  )
    throw Error('POLAR_SCENARIO_IDENTITY_INVALID');

  const observations = new Map(
    receipt.observations.map((observation) => [observation.id, observation]),
  );
  const boundObservationIds = receipt.scenarios.flatMap((scenario) => scenario.observationIds);
  if (
    receipt.observations.length !== 16 ||
    observations.size !== 16 ||
    new Set(boundObservationIds).size !== 16 ||
    !sameMembers(boundObservationIds, observations.keys())
  )
    throw Error('POLAR_OBSERVATION_BINDING_INVALID');
  for (const scenario of receipt.scenarios) {
    const bound = scenario.observationIds.map((id) => observations.get(id));
    if (
      bound.some(
        (observation) =>
          !observation ||
          observation.runId !== receipt.run.id ||
          observation.scenarioId !== scenario.id,
      ) ||
      !sameMembers(
        bound.flatMap((observation) => (observation ? [observation.source] : [])),
        evidenceSource.options,
      )
    )
      throw Error('POLAR_OBSERVATION_BINDING_INVALID');
  }

  const browserObservations = receipt.observations
    .filter((observation) => observation.source === 'browser')
    .map((observation) => observation.id);
  if (
    receipt.artifacts.length !== 4 ||
    new Set(receipt.artifacts.map((artifact) => artifact.id)).size !== 4 ||
    !sameMembers(
      receipt.artifacts.map((artifact) => artifact.observationId),
      browserObservations,
    )
  )
    throw Error('POLAR_ARTIFACT_BINDING_INVALID');

  const deleted = receipt.cleanup.filter((resource) => resource.status === 'deleted');
  const retained = receipt.cleanup.filter((resource) => resource.status === 'retained');
  if (
    receipt.cleanup.length !== 5 ||
    deleted.length !== 2 ||
    retained.length !== 3 ||
    retained.some((resource) => resource.code !== 'POLAR_CANCELED_AUDIT_RETAINED') ||
    new Set(receipt.cleanup.map((resource) => resource.resourceId)).size !== 5
  )
    throw Error('POLAR_CLEANUP_INCOMPLETE');
}
