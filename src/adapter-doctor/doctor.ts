import { hashValue } from '#domain';
import { targetDescriptionSchema } from '#integrations/target-contract';
import { z } from 'zod';
import {
  ADAPTER_DOCTOR_SCOPE,
  adapterDoctorReportSchema,
  type AdapterDoctorCheck,
  type AdapterDoctorCheckId,
  type AdapterDoctorReport,
} from './report.ts';
import { type AdapterDoctorResponse, type AdapterDoctorTarget } from './http-target.ts';

const checkOrder = [
  'description',
  'build_binding',
  'staging_authentication',
  'ordinary_feature_isolation',
  'response_cache_policy',
] satisfies AdapterDoctorCheckId[];

const titles = {
  description: 'Description contract',
  build_binding: 'Source binding',
  staging_authentication: 'Staging authentication',
  ordinary_feature_isolation: 'Adapter credential isolation',
  response_cache_policy: 'Response cache policy',
} satisfies Record<AdapterDoctorCheckId, string>;

const stagingAuthDenialSchema = z.strictObject({ error: z.literal('ADAPTER_AUTH_REQUIRED') });
const ordinaryAuthDenialSchema = z.strictObject({ error: z.literal('AUTHENTICATION_REQUIRED') });

function pass(id: AdapterDoctorCheckId, code: string, detail: string): AdapterDoctorCheck {
  return { id, status: 'pass', code, title: titles[id], detail };
}

function blocked(
  id: AdapterDoctorCheckId,
  code: string,
  detail: string,
  remediation: string,
): AdapterDoctorCheck {
  return { id, status: 'blocked', code, title: titles[id], detail, remediation };
}

function notObserved(id: AdapterDoctorCheckId): AdapterDoctorCheck {
  return {
    id,
    status: 'not_observed',
    code: 'PREREQUISITE_NOT_OBSERVED',
    title: titles[id],
    detail: 'A required earlier observation was unavailable.',
  };
}

function noStore(response: AdapterDoctorResponse): boolean {
  return (
    response.headers.cacheControl
      ?.split(',')
      .some((directive) => directive.trim().toLowerCase() === 'no-store') ?? false
  );
}

function jsonResponse(response: AdapterDoctorResponse): boolean {
  return (
    response.headers.contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  );
}

function transportFailureCode(error: unknown): string {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current.name === 'TimeoutError' || current.message === 'PROVIDER_TIMEOUT')
      return 'TARGET_TIMEOUT';
    current = current.cause;
  }
  if (!(error instanceof Error)) return 'TARGET_UNREACHABLE';
  switch (error.message) {
    case 'REDIRECT_REJECTED':
      return 'TARGET_REDIRECT_REJECTED';
    case 'NETWORK_DESTINATION_REJECTED':
      return 'TARGET_DESTINATION_REJECTED';
    case 'RESPONSE_LIMIT':
    case 'RESPONSE_BUDGET_EXCEEDED':
      return 'TARGET_RESPONSE_LIMIT';
    default:
      return 'TARGET_UNREACHABLE';
  }
}

function blockedReport(input: {
  targetId: string;
  expectedBuildId: string;
  checks: AdapterDoctorCheck[];
}): AdapterDoctorReport {
  return adapterDoctorReportSchema.parse({
    schemaVersion: 1,
    verdict: 'blocked',
    scope: ADAPTER_DOCTOR_SCOPE,
    targetId: input.targetId,
    expectedBuildId: input.expectedBuildId,
    checks: input.checks,
  });
}

export function createAdapterDoctor(input: {
  targetId: string;
  expectedBuildId: string;
  target: AdapterDoctorTarget;
}) {
  return {
    async inspect(options: { signal?: AbortSignal } = {}): Promise<AdapterDoctorReport> {
      let described: AdapterDoctorResponse;
      try {
        described = await input.target.describe({
          credential: 'configured',
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        return blockedReport({
          targetId: input.targetId,
          expectedBuildId: input.expectedBuildId,
          checks: checkOrder.map((id) =>
            id === 'description'
              ? blocked(
                  id,
                  transportFailureCode(error),
                  'The configured target could not be inspected.',
                  'Verify the staging origin, network policy, and adapter service health.',
                )
              : notObserved(id),
          ),
        });
      }
      const parsed =
        described.status === 200 && jsonResponse(described)
          ? targetDescriptionSchema.safeParse(described.body)
          : null;
      if (!parsed?.success)
        return blockedReport({
          targetId: input.targetId,
          expectedBuildId: input.expectedBuildId,
          checks: checkOrder.map((id) =>
            id === 'description'
              ? blocked(
                  id,
                  described.status === 401
                    ? 'ADAPTER_CREDENTIAL_REJECTED'
                    : 'TARGET_DESCRIPTION_INVALID',
                  'The authenticated description did not satisfy target contract v1.',
                  'Check the adapter credential and return the exact versioned description.',
                )
              : notObserved(id),
          ),
        });

      const description = parsed.data;
      const descriptionCheck = pass(
        'description',
        'DESCRIPTION_ACCEPTED',
        'Target contract v1 is present and valid.',
      );
      const buildCheck =
        description.buildId === input.expectedBuildId
          ? pass(
              'build_binding',
              'BUILD_MATCHES',
              'The deployed build matches the selected source.',
            )
          : blocked(
              'build_binding',
              'TARGET_BUILD_MISMATCH',
              'The deployed build does not match the selected source.',
              'Deploy the selected commit or reconnect the project to the deployed build.',
            );
      if (buildCheck.status === 'blocked')
        return blockedReport({
          targetId: input.targetId,
          expectedBuildId: input.expectedBuildId,
          checks: [
            descriptionCheck,
            buildCheck,
            notObserved('staging_authentication'),
            notObserved('ordinary_feature_isolation'),
            notObserved('response_cache_policy'),
          ],
        });
      let unauthenticated: AdapterDoctorResponse;
      try {
        unauthenticated = await input.target.describe({
          credential: 'omitted',
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        return blockedReport({
          targetId: input.targetId,
          expectedBuildId: input.expectedBuildId,
          checks: [
            descriptionCheck,
            buildCheck,
            blocked(
              'staging_authentication',
              transportFailureCode(error),
              'The staging authentication check could not be completed safely.',
              'Remove redirects and verify the staging adapter is reachable at the configured origin.',
            ),
            notObserved('ordinary_feature_isolation'),
            notObserved('response_cache_policy'),
          ],
        });
      }
      const stagingCheck =
        unauthenticated.status === 401 &&
        jsonResponse(unauthenticated) &&
        stagingAuthDenialSchema.safeParse(unauthenticated.body).success
          ? pass(
              'staging_authentication',
              'STAGING_AUTH_REQUIRED',
              'The staging description rejects requests without its dedicated credential.',
            )
          : blocked(
              'staging_authentication',
              unauthenticated.status === 200
                ? 'STAGING_ROUTE_PUBLIC'
                : 'STAGING_AUTH_CONTRACT_MISMATCH',
              'The staging description did not return the exact unauthenticated denial.',
              'Require the dedicated adapter bearer credential on every staging route.',
            );
      if (stagingCheck.status === 'blocked')
        return blockedReport({
          targetId: input.targetId,
          expectedBuildId: input.expectedBuildId,
          checks: [
            descriptionCheck,
            buildCheck,
            stagingCheck,
            notObserved('ordinary_feature_isolation'),
            notObserved('response_cache_policy'),
          ],
        });
      let feature: AdapterDoctorResponse;
      try {
        feature = await input.target.featureWithAdapterCredential({
          path: description.feature.path,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        return blockedReport({
          targetId: input.targetId,
          expectedBuildId: input.expectedBuildId,
          checks: [
            descriptionCheck,
            buildCheck,
            stagingCheck,
            blocked(
              'ordinary_feature_isolation',
              transportFailureCode(error),
              'The protected-feature isolation check could not be completed safely.',
              'Remove redirects and keep the protected feature on the configured target origin.',
            ),
            notObserved('response_cache_policy'),
          ],
        });
      }
      const featureCheck =
        feature.status === 401 &&
        jsonResponse(feature) &&
        ordinaryAuthDenialSchema.safeParse(feature.body).success
          ? pass(
              'ordinary_feature_isolation',
              'ADAPTER_CREDENTIAL_ISOLATED',
              'The adapter credential cannot act as an ordinary customer session.',
            )
          : blocked(
              'ordinary_feature_isolation',
              feature.status >= 200 && feature.status < 300
                ? 'ADAPTER_CREDENTIAL_GRANTS_FEATURE_ACCESS'
                : 'ORDINARY_AUTH_CONTRACT_MISMATCH',
              'The protected feature did not return the ordinary authentication denial.',
              'Keep adapter authentication separate from customer authentication.',
            );
      if (featureCheck.status === 'blocked')
        return blockedReport({
          targetId: input.targetId,
          expectedBuildId: input.expectedBuildId,
          checks: [
            descriptionCheck,
            buildCheck,
            stagingCheck,
            featureCheck,
            notObserved('response_cache_policy'),
          ],
        });
      const checks: AdapterDoctorCheck[] = [
        descriptionCheck,
        buildCheck,
        stagingCheck,
        featureCheck,
        [described, unauthenticated, feature].every(noStore)
          ? pass(
              'response_cache_policy',
              'NO_STORE_CONFIRMED',
              'Every diagnostic response disables shared and browser caching.',
            )
          : blocked(
              'response_cache_policy',
              'NO_STORE_MISSING',
              'At least one diagnostic response can be cached.',
              'Return Cache-Control: no-store on staging and protected diagnostic responses.',
            ),
      ];
      if (checks.some((check) => check.status !== 'pass'))
        return blockedReport({
          targetId: input.targetId,
          expectedBuildId: input.expectedBuildId,
          checks,
        });
      return adapterDoctorReportSchema.parse({
        schemaVersion: 1,
        verdict: 'compatible',
        scope: ADAPTER_DOCTOR_SCOPE,
        targetId: input.targetId,
        expectedBuildId: input.expectedBuildId,
        checks,
        receipt: {
          description,
          featureConfigHash: hashValue(description.feature),
        },
      });
    },
  };
}
