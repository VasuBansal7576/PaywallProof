import { z } from 'zod';

export const repairProfileSchema = z.enum(['reference_v1', 'disabled']);
export type RepairProfile = z.infer<typeof repairProfileSchema>;

export const REFERENCE_REPAIR_TARGET = {
  id: 'reference',
  origin: 'http://127.0.0.1:3001',
  repository: 'VasuBansal7576/PaywallProof',
} as const;

const targetTrustInputs = [
  ['TARGET_ID', REFERENCE_REPAIR_TARGET.id],
  ['TARGET_ORIGIN', REFERENCE_REPAIR_TARGET.origin],
  ['PROJECT_REPOSITORY', REFERENCE_REPAIR_TARGET.repository],
] as const;

/**
 * Repair evaluation is coupled to the bundled reference target. An explicit profile
 * selects policy, but cannot turn an untrusted target configuration into that target.
 */
export function repairProfileFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): RepairProfile {
  const requestedProfile = repairProfileSchema.parse(environment.REPAIR_PROFILE ?? 'reference_v1');
  if (requestedProfile === 'disabled') return requestedProfile;

  const targetIsTrusted = targetTrustInputs.every(([key, expected]) => {
    const configured = environment[key];
    return configured === undefined || configured === expected;
  });
  return targetIsTrusted ? requestedProfile : 'disabled';
}
