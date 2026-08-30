import { describe, expect, it } from 'vitest';
import {
  ADAPTER_DOCTOR_SCOPE,
  adapterDoctorReportSchema,
} from '../../../src/adapter-doctor/index.ts';
import { preflightSchema } from './contracts.ts';

describe('operator contracts', () => {
  it('parses the Adapter Doctor report and connection checks as one preflight result', () => {
    const feature = {
      id: 'pro_export',
      method: 'GET',
      path: '/api/export',
      denialStatuses: [403],
      browserPath: '/dashboard',
      actionTestId: 'export-button',
      resultTestId: 'export-result',
    };
    const adapter = adapterDoctorReportSchema.parse({
      schemaVersion: 1,
      verdict: 'compatible',
      scope: ADAPTER_DOCTOR_SCOPE,
      targetId: 'reference',
      expectedBuildId: 'a'.repeat(40),
      checks: [
        ['description', 'DESCRIPTION_ACCEPTED'],
        ['build_binding', 'BUILD_MATCHES'],
        ['staging_authentication', 'STAGING_AUTH_REQUIRED'],
        ['ordinary_feature_isolation', 'ADAPTER_CREDENTIAL_ISOLATED'],
        ['response_cache_policy', 'NO_STORE_CONFIRMED'],
      ].map(([id, code]) => ({ id, code, status: 'pass', title: id, detail: code })),
      receipt: {
        description: {
          adapterVersion: '1',
          environment: 'test',
          buildId: 'a'.repeat(40),
          billingTimeModel: 'provider_status',
          feature,
        },
        featureConfigHash: 'b'.repeat(64),
      },
    });

    const result = preflightSchema.parse({
      ready: true,
      adapter,
      connections: [
        { name: 'Billing mode', status: 'pass', detail: 'No provider request.' },
        { name: 'TrueForge', status: 'pass', detail: 'Connection verified.' },
      ],
    });

    expect(result).toMatchObject({ ready: true, adapter });
    expect(result.connections.map((connection) => connection.name)).toEqual([
      'Billing mode',
      'TrueForge',
    ]);
    expect(
      adapterDoctorReportSchema.safeParse({
        ...adapter,
        checks: [
          adapter.checks[0],
          adapter.checks[0],
          adapter.checks[2],
          adapter.checks[3],
          adapter.checks[4],
        ],
      }).success,
    ).toBe(false);
  });
});
