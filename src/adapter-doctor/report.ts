import { z } from 'zod';
import { hashValue } from '#domain';
import {
  bindTargetFeatureProbe,
  targetDescriptionSchema,
  targetFeatureProbeContractSchema,
} from '#integrations/target-contract';

const identifier = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

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

const reportBaseFields = {
  scope: scopeSchema,
  targetId: identifier,
  expectedBuildId: identifier,
  checks: adapterDoctorChecksSchema,
};

const legacyReceiptSchema = z
  .strictObject({
    description: targetDescriptionSchema,
    featureConfigHash: digest,
  })
  .superRefine((receipt, context) => {
    if (receipt.featureConfigHash !== hashValue(receipt.description.feature))
      context.addIssue({ code: 'custom', message: 'Feature descriptor hash mismatch' });
  });
const boundReceiptSchema = z
  .strictObject({
    description: targetDescriptionSchema,
    featureConfigHash: digest,
    featureProbe: targetFeatureProbeContractSchema,
    featureProbeHash: digest,
  })
  .superRefine((receipt, context) => {
    if (receipt.featureConfigHash !== hashValue(receipt.description.feature))
      context.addIssue({ code: 'custom', message: 'Feature descriptor hash mismatch' });
    const binding = bindTargetFeatureProbe(receipt.description.feature);
    if (
      receipt.featureProbeHash !== binding.hash ||
      hashValue(receipt.featureProbe) !== binding.hash
    )
      context.addIssue({ code: 'custom', message: 'Feature probe contract hash mismatch' });
  });

const legacyReportSchema = z.discriminatedUnion('verdict', [
  z.strictObject({ schemaVersion: z.literal(1), ...reportBaseFields }).extend({
    verdict: z.literal('compatible'),
    receipt: legacyReceiptSchema,
  }),
  z
    .strictObject({ schemaVersion: z.literal(1), ...reportBaseFields })
    .extend({ verdict: z.literal('blocked') }),
]);
const boundReportSchema = z.discriminatedUnion('verdict', [
  z.strictObject({ schemaVersion: z.literal(2), ...reportBaseFields }).extend({
    verdict: z.literal('compatible'),
    receipt: boundReceiptSchema,
  }),
  z
    .strictObject({ schemaVersion: z.literal(2), ...reportBaseFields })
    .extend({ verdict: z.literal('blocked') }),
]);
export const adapterDoctorReportSchema = z.union([boundReportSchema, legacyReportSchema]);
export type AdapterDoctorReport = Readonly<z.infer<typeof adapterDoctorReportSchema>>;
