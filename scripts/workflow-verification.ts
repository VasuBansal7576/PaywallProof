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

/** A controller's overall label alone is not sufficient acceptance evidence. */
export function assertLocalWorkflowComplete(input: unknown): void {
  const receipt = completed.parse(input);
  if (new Set(receipt.scenarios.map((scenario) => scenario.id)).size !== 4)
    throw Error('WORKFLOW_SCENARIO_IDENTITY_INVALID');
  if (new Set(receipt.cleanup.map((resource) => resource.resourceId)).size !== 2)
    throw Error('WORKFLOW_CLEANUP_IDENTITY_INVALID');
}
