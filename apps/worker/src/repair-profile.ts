import { z } from 'zod';

export const repairProfileSchema = z.enum(['reference_v1', 'disabled']);
export type RepairProfile = z.infer<typeof repairProfileSchema>;

const targetOverrideKeys = ['TARGET_ID', 'TARGET_ORIGIN', 'PROJECT_REPOSITORY'] as const;

/**
 * Repair evaluation is coupled to the bundled reference target. Any target override
 * disables repair unless the operator explicitly selects a trusted profile.
 */
export function repairProfileFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): RepairProfile {
  if (environment.REPAIR_PROFILE !== undefined)
    return repairProfileSchema.parse(environment.REPAIR_PROFILE);
  return targetOverrideKeys.some((key) => environment[key] !== undefined)
    ? 'disabled'
    : 'reference_v1';
}
