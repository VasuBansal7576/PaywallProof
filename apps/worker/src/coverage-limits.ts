export const COVERAGE_LIMIT_CODES = [
  'SINGLE_TARGET_SINGLE_PRICE_SINGLE_FEATURE',
  'PRODUCTION_BILLING_VARIANTS_NOT_TESTED',
  'LOCAL_REPLAY_NOT_NATIVE_PROVIDER_DELIVERY',
  'BUILD_SCOPED_NOT_SECURITY_CERTIFICATE',
  'AUTOMATED_REPAIR_REFERENCE_TARGET_ONLY',
] as const;

export type CoverageLimitCode = (typeof COVERAGE_LIMIT_CODES)[number];

const baseCoverageLimitCodes = [
  'SINGLE_TARGET_SINGLE_PRICE_SINGLE_FEATURE',
  'PRODUCTION_BILLING_VARIANTS_NOT_TESTED',
  'BUILD_SCOPED_NOT_SECURITY_CERTIFICATE',
] as const satisfies readonly CoverageLimitCode[];
const localReplayCoverageLimitCode =
  'LOCAL_REPLAY_NOT_NATIVE_PROVIDER_DELIVERY' as const satisfies CoverageLimitCode;

const coverageLimitText: Record<CoverageLimitCode, string> = {
  SINGLE_TARGET_SINGLE_PRICE_SINGLE_FEATURE:
    'One configured staging target, one monthly price, one API-backed export feature.',
  PRODUCTION_BILLING_VARIANTS_NOT_TESTED:
    'Production payments, trials, failed-payment grace periods, discounts and multiple subscriptions are not tested.',
  LOCAL_REPLAY_NOT_NATIVE_PROVIDER_DELIVERY:
    'Local replay uses explicitly synthetic signed billing events. It does not verify Polar delivery or integration.',
  BUILD_SCOPED_NOT_SECURITY_CERTIFICATE:
    'A passing report covers only the listed scenarios and target build. It is not a security certificate.',
  AUTOMATED_REPAIR_REFERENCE_TARGET_ONLY:
    'Lifecycle checks support this contract-v1 target. Automated repair and its trusted evaluator remain limited to the bundled reference target.',
};

export const referenceTargetOnlyRepairCoverage = {
  code: 'AUTOMATED_REPAIR_REFERENCE_TARGET_ONLY',
  text: coverageLimitText.AUTOMATED_REPAIR_REFERENCE_TARGET_ONLY,
} as const satisfies { code: CoverageLimitCode; text: string };

export function coverageForMode(mode: 'polar_sandbox' | 'local_replay') {
  const coverageLimitCodes: CoverageLimitCode[] = [
    ...baseCoverageLimitCodes,
    ...(mode === 'local_replay' ? [localReplayCoverageLimitCode] : []),
  ];
  return {
    coverageLimitCodes,
    coverageLimits: coverageLimitCodes.map((code) => coverageLimitText[code]),
  };
}
