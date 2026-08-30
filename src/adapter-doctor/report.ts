import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const contractPath = z
  .string()
  .min(2)
  .max(256)
  .regex(/^\/[A-Za-z0-9_./~-]+$/)
  .refine(
    (value) =>
      !value.startsWith('//') &&
      !value.split('/').some((segment) => segment === '.' || segment === '..'),
  );
const testId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const targetFeatureSchema = z.strictObject({
  id: identifier.max(100),
  method: z.literal('GET'),
  path: contractPath,
  denialStatuses: z
    .array(z.number().int().min(400).max(499))
    .min(1)
    .max(16)
    .refine((statuses) => new Set(statuses).size === statuses.length),
  browserPath: contractPath,
  actionTestId: testId,
  resultTestId: testId,
});
export type TargetFeature = Readonly<z.infer<typeof targetFeatureSchema>>;

export const targetDescriptionSchema = z.strictObject({
  adapterVersion: z.literal('1'),
  environment: z.literal('test'),
  buildId: identifier,
  billingTimeModel: z.literal('provider_status'),
  feature: targetFeatureSchema,
});
export type TargetDescription = Readonly<z.infer<typeof targetDescriptionSchema>>;

export const adapterDoctorCheckIdSchema = z.enum([
  'description',
  'build_binding',
  'staging_authentication',
  'ordinary_feature_isolation',
  'response_cache_policy',
]);
export type AdapterDoctorCheckId = z.infer<typeof adapterDoctorCheckIdSchema>;

const checkBase = z.strictObject({
  id: adapterDoctorCheckIdSchema,
  code: identifier,
  title: identifier,
  detail: identifier,
});
export const adapterDoctorCheckSchema = z.discriminatedUnion('status', [
  checkBase.extend({ status: z.literal('pass') }),
  checkBase.extend({ status: z.literal('blocked'), remediation: identifier }),
  checkBase.extend({
    status: z.literal('not_observed'),
    code: z.literal('PREREQUISITE_NOT_OBSERVED'),
  }),
]);
export type AdapterDoctorCheck = Readonly<z.infer<typeof adapterDoctorCheckSchema>>;

const checkAt = (id: AdapterDoctorCheckId) =>
  adapterDoctorCheckSchema.refine((check) => check.id === id);
const adapterDoctorChecksSchema = z.tuple([
  checkAt('description'),
  checkAt('build_binding'),
  checkAt('staging_authentication'),
  checkAt('ordinary_feature_isolation'),
  checkAt('response_cache_policy'),
]);

const scopeSchema = z.strictObject({
  sideEffects: z.literal('none'),
  methods: z.tuple([z.literal('GET')]),
  maximumRequests: z.literal(3),
  excluded: z.tuple([
    z.literal('FIXTURE_MUTATION_NOT_EXERCISED'),
    z.literal('SESSION_AND_BROWSER_FLOW_NOT_EXERCISED'),
    z.literal('BILLING_LIFECYCLE_NOT_EXERCISED'),
    z.literal('PRODUCTION_STAGING_DISABLEMENT_NOT_OBSERVED'),
  ]),
});
export type AdapterDoctorScope = Readonly<z.infer<typeof scopeSchema>>;
export const ADAPTER_DOCTOR_SCOPE = {
  sideEffects: 'none',
  methods: ['GET'],
  maximumRequests: 3,
  excluded: [
    'FIXTURE_MUTATION_NOT_EXERCISED',
    'SESSION_AND_BROWSER_FLOW_NOT_EXERCISED',
    'BILLING_LIFECYCLE_NOT_EXERCISED',
    'PRODUCTION_STAGING_DISABLEMENT_NOT_OBSERVED',
  ],
} satisfies AdapterDoctorScope;

const reportBase = z.strictObject({
  schemaVersion: z.literal(1),
  scope: scopeSchema,
  targetId: identifier,
  expectedBuildId: identifier,
  checks: adapterDoctorChecksSchema,
});
export const adapterDoctorReportSchema = z.discriminatedUnion('verdict', [
  reportBase.extend({
    verdict: z.literal('compatible'),
    receipt: z.strictObject({
      description: targetDescriptionSchema,
      featureConfigHash: digest,
    }),
  }),
  reportBase.extend({ verdict: z.literal('blocked') }),
]);
export type AdapterDoctorReport = Readonly<z.infer<typeof adapterDoctorReportSchema>>;
