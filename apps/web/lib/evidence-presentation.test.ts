import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunReport } from '../components/report';
import { detailSchema, type RunDetail, type Scenario } from './contracts';
import {
  artifactSchema,
  linkedArtifacts,
  observationSchema,
  scenarioEvidence,
} from './evidence-presentation';

const scenario: Scenario = {
  id: 'SC02',
  api: { verdict: 'inconclusive', code: 'UNRECOGNIZED_RESPONSE' },
  browser: { verdict: 'inconclusive', code: 'UNRECOGNIZED_RESPONSE' },
  state: { verdict: 'pass', code: 'STATE_MATCH' },
  observationIds: ['provider', 'application', 'api', 'browser'],
};
function fixture(): RunDetail {
  const base = {
    runId: 'run_test',
    scenarioId: 'SC02',
    subjectId: 'user_test',
    policyHash: 'a'.repeat(64),
    targetBuild: 'build_test',
    observedAt: 1800000000000,
    billingTime: 1800000000,
    mode: 'local_replay',
    sha256: 'b'.repeat(64),
  };
  return detailSchema.parse({
    run: {
      id: 'run_test',
      projectId: 'project_test',
      policy: {
        schemaVersion: 2,
        priceId: 'price_test',
        featureId: 'pro_export',
        featureConfigHash: 'c'.repeat(64),
        cancellation: 'allow_until_period_end',
        requireInitialPaymentConfirmed: true,
        syncWindowSeconds: 60,
        predicateVersion: 'reference-export-v1',
        hash: 'a'.repeat(64),
      },
      targetBuild: 'build_test',
      featureConfigHash: 'c'.repeat(64),
      targetFeature: {
        id: 'pipeline_export',
        method: 'GET',
        path: '/api/paywallproof/export',
        denialStatuses: [402, 403],
        browserPath: '/admin',
        actionTestId: 'pipeline-export-button',
        resultTestId: 'pipeline-export-result',
      },
      mode: 'local_replay',
      status: 'completed',
      outcome: 'inconclusive',
      createdAt: 1800000000000,
      startedAt: 1800000000000,
      verdicts: ['inconclusive'],
      approval: {
        id: 'approval_test',
        bindingHash: 'd'.repeat(64),
        expiresAt: 1800000010000,
        decision: 'allow',
      },
    },
    runtime: null,
    scenarios: [scenario],
    cleanup: [],
    repairs: [],
    coverageLimits: ['Synthetic local replay only.'],
    observations: [
      {
        ...base,
        id: 'provider',
        source: 'billing_provider',
        payload: {
          livemode: false,
          identityResolved: true,
          noSubscriptionConfirmed: false,
          customerId: 'cus_test',
          subscription: {
            id: 'sub_test',
            customerId: 'cus_test',
            priceId: 'price_test',
            status: 'active',
            initialPaymentConfirmed: true,
            cancelAtPeriodEnd: false,
            periodEnd: 1801000000,
            billingTime: 1800000000,
          },
        },
      },
      {
        ...base,
        id: 'application',
        source: 'application',
        payload: {
          principalId: 'user_test',
          runId: 'run_test',
          customerId: 'cus_test',
          status: 'active',
          buildId: 'build_test',
        },
      },
      {
        ...base,
        id: 'api',
        source: 'api_probe',
        payload: {
          status: 200,
          body: { error: 'unexpected response' },
          transportError: false,
          denialStatuses: [403],
        },
      },
      {
        ...base,
        id: 'browser',
        source: 'browser',
        payload: {
          status: 200,
          body: { uiStatus: 'unavailable', visibleText: '<script>untrusted()</script>' },
          transportError: false,
          denialStatuses: [403],
        },
      },
    ],
    artifacts: [
      {
        id: `${randomUUID()}.png`,
        runId: 'run_test',
        observationId: 'browser',
        sha256: 'e'.repeat(64),
        contentType: 'image/png',
        source: 'browser',
        collectedAt: '2027-01-15T08:00:00.000Z',
      },
    ],
  });
}

describe('recorded evidence presentation', () => {
  it('summarizes recorded facts without changing an inconclusive HTTP 200 into a pass', () => {
    const detail = fixture();
    const evidence = scenarioEvidence(detail, scenario, 'api_probe');
    expect(evidence.kind).toBe('recorded');
    if (evidence.kind !== 'recorded') throw new Error('Expected recorded evidence');
    expect(evidence.facts).toContainEqual({ label: 'HTTP response', value: '200' });
    expect(detail.scenarios[0]?.api.verdict).toBe('inconclusive');
    expect(scenarioEvidence(detail, scenario, 'billing_provider')).toMatchObject({
      kind: 'recorded',
      facts: expect.arrayContaining([{ label: 'Billing source', value: 'Synthetic local replay' }]),
    });
  });

  it.each(['runId', 'scenarioId', 'policyHash', 'targetBuild', 'mode', 'subjectId'])(
    'does not summarize an observation with the wrong %s',
    (field) => {
      const detail = fixture();
      detail.observations = detail.observations.map((value) => {
        const observation = observationSchema.parse(value);
        return observation.id === 'api'
          ? {
              ...observation,
              [field]:
                field === 'policyHash'
                  ? 'f'.repeat(64)
                  : field === 'mode'
                    ? 'polar_sandbox'
                    : 'foreign',
            }
          : observation;
      });
      expect(scenarioEvidence(detail, scenario, 'api_probe').kind).toBe('unavailable');
    },
  );

  it('shows missing, duplicate, and malformed source data as unavailable', () => {
    const detail = fixture();
    detail.observations = detail.observations.filter(
      (value) => observationSchema.parse(value).id !== 'api',
    );
    expect(scenarioEvidence(detail, scenario, 'api_probe').kind).toBe('unavailable');
    const duplicate = fixture();
    duplicate.observations.push(duplicate.observations[2]);
    expect(scenarioEvidence(duplicate, scenario, 'api_probe').kind).toBe('unavailable');
    const malformed = fixture();
    malformed.observations = malformed.observations.map((value) => {
      const observation = observationSchema.parse(value);
      return observation.id === 'api'
        ? { ...observation, payload: { status: 'not a status' } }
        : observation;
    });
    expect(scenarioEvidence(malformed, scenario, 'api_probe').kind).toBe('unavailable');
  });

  it('links screenshots only through a matching run and scenario browser observation', () => {
    const detail = fixture();
    expect(linkedArtifacts(detail, scenario.observationIds, scenario.id).artifacts).toHaveLength(1);
    expect(linkedArtifacts(detail, ['api'], scenario.id).artifacts).toHaveLength(0);
    expect(linkedArtifacts(detail, scenario.observationIds, 'SC04').artifacts).toHaveLength(0);
    const [artifact] = detail.artifacts ?? [];
    detail.artifacts = [{ ...artifactSchema.parse(artifact), runId: 'other_run' }];
    expect(linkedArtifacts(detail, scenario.observationIds, scenario.id)).toEqual({
      artifacts: [],
      invalidCount: 1,
    });
    detail.artifacts = [{ id: '../../secrets.png' }];
    expect(linkedArtifacts(detail, scenario.observationIds, scenario.id)).toEqual({
      artifacts: [],
      invalidCount: 1,
    });
  });

  it('renders an escaped report with explicit replay, observation, build, and policy provenance', () => {
    const detail = fixture();
    const markup = renderToStaticMarkup(createElement(RunReport, { detail }));
    expect(markup).toContain('synthetic billing events');
    expect(markup).toContain('build_test');
    expect(markup).toContain(detail.run.policy.hash);
    expect(markup).toContain('GET /api/paywallproof/export');
    expect(markup).toContain('/admin');
    expect(markup).toContain('pipeline-export-button');
    expect(markup).not.toContain('GET /api/export');
    expect(markup).toContain('inconclusive');
    expect(markup).toContain('&lt;script&gt;untrusted()&lt;/script&gt;');
    expect(markup).not.toContain('<script>untrusted()');
    expect(markup).toContain('View screenshot');
    expect(markup).not.toContain('<img');
  });
});
