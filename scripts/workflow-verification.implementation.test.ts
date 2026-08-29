import { describe, it, expect } from 'vitest';
import {
  assertLocalWorkflowComplete,
  assertPolarWorkflowComplete,
} from './workflow-verification.ts';

// Implementation-aware acceptance-receipt tests; these fixtures are not live evidence.
const receipt = () => ({
  run: { status: 'completed', outcome: 'passed', mode: 'local_replay' },
  scenarios: ['SC01', 'SC02', 'SC03', 'SC04'].map((id) => ({
    id,
    api: { verdict: 'pass' },
    browser: { verdict: 'pass' },
    state: { verdict: 'pass' },
  })),
  cleanup: [
    { resourceId: 'first', status: 'deleted' },
    { resourceId: 'second', status: 'deleted' },
  ],
});
describe('local workflow completion receipt', () => {
  it('accepts complete scenarios and two distinct deleted fixtures', () =>
    expect(() => assertLocalWorkflowComplete(receipt())).not.toThrow());
  it.each(['running', 'canceled', 'awaiting_plan_approval'])(
    'rejects %s despite a passed label',
    (status) => {
      const input = receipt();
      input.run.status = status;
      expect(() => assertLocalWorkflowComplete(input)).toThrow();
    },
  );
  it('rejects a failed overall outcome', () => {
    const input = receipt();
    input.run.outcome = 'failed';
    expect(() => assertLocalWorkflowComplete(input)).toThrow();
  });
  it('does not reclassify a provider receipt as local replay', () => {
    const input = receipt();
    input.run.mode = 'polar_sandbox';
    expect(() => assertLocalWorkflowComplete(input)).toThrow();
  });
  for (const index of [0, 1, 2, 3])
    for (const channel of ['api', 'browser', 'state'] as const) {
      it(`rejects scenario ${index + 1} ${channel} failure despite a passed overall label`, () => {
        const input = receipt();
        const scenario = input.scenarios[index];
        if (!scenario) throw Error('FIXTURE_MISSING');
        scenario[channel].verdict = 'fail';
        expect(() => assertLocalWorkflowComplete(input)).toThrow();
      });
    }
  it('rejects duplicate scenario identities', () => {
    const input = receipt();
    const first = input.scenarios[0];
    if (!first) throw Error('FIXTURE_MISSING');
    input.scenarios.fill(first);
    expect(() => assertLocalWorkflowComplete(input)).toThrow();
  });
  it('rejects missing scenarios', () => {
    const input = receipt();
    input.scenarios.pop();
    expect(() => assertLocalWorkflowComplete(input)).toThrow();
  });
  it.each(['leftover', 'retained', 'unknown'])('rejects %s cleanup', (status) => {
    const input = receipt();
    input.cleanup = [
      { resourceId: 'first', status },
      { resourceId: 'second', status: 'deleted' },
    ];
    expect(() => assertLocalWorkflowComplete(input)).toThrow();
  });
  it('rejects missing cleanup', () => {
    const input = receipt();
    input.cleanup = [];
    expect(() => assertLocalWorkflowComplete(input)).toThrow();
  });
  it('rejects counting one deleted fixture twice', () => {
    const input = receipt();
    input.cleanup = [
      { resourceId: 'same', status: 'deleted' },
      { resourceId: 'same', status: 'deleted' },
    ];
    expect(() => assertLocalWorkflowComplete(input)).toThrow();
  });
});

const polarReceipt = () => {
  const sources = ['billing_provider', 'application', 'api_probe', 'browser'] as const;
  const scenarios = ['SC01', 'SC02', 'SC03', 'SC04'].map((id) => ({
    id,
    api: { verdict: 'pass' },
    browser: { verdict: 'pass' },
    state: { verdict: 'pass' },
    observationIds: sources.map((source) => `${id}-${source}`),
  }));
  const observations = scenarios.flatMap((scenario) =>
    sources.map((source) => ({
      id: `${scenario.id}-${source}`,
      runId: 'polar-run',
      scenarioId: scenario.id,
      source,
      mode: 'polar_sandbox',
      sha256: 'a'.repeat(64),
    })),
  );
  return {
    run: { id: 'polar-run', status: 'completed', outcome: 'passed', mode: 'polar_sandbox' },
    scenarios,
    observations,
    artifacts: observations
      .filter((observation) => observation.source === 'browser')
      .map((observation) => ({
        id: `artifact-${observation.scenarioId}`,
        observationId: observation.id,
        source: 'browser',
        contentType: 'image/png',
        sha256: 'b'.repeat(64),
      })),
    cleanup: [
      { resourceId: 'free-user', status: 'deleted', code: undefined },
      { resourceId: 'paid-user', status: 'deleted', code: undefined },
      ...['customer', 'checkout', 'subscription'].map((resourceId) => ({
        resourceId,
        status: 'retained',
        code: 'POLAR_CANCELED_AUDIT_RETAINED',
      })),
    ],
  };
};

describe('Polar workflow completion receipt', () => {
  it('accepts one fully bound native lifecycle with honest provider retention', () =>
    expect(() => assertPolarWorkflowComplete(polarReceipt())).not.toThrow());

  it('rejects a local-replay receipt presented as native provider evidence', () => {
    const input = polarReceipt();
    input.run.mode = 'local_replay';
    expect(() => assertPolarWorkflowComplete(input)).toThrow();
  });

  it('rejects missing provider observations even when every scenario says pass', () => {
    const input = polarReceipt();
    input.observations.shift();
    expect(() => assertPolarWorkflowComplete(input)).toThrow('POLAR_OBSERVATION_BINDING_INVALID');
  });

  it('rejects duplicated provider observations hidden by set membership', () => {
    const input = polarReceipt();
    const first = input.observations[0];
    if (!first) throw Error('FIXTURE_MISSING');
    input.observations.push({ ...first });
    expect(() => assertPolarWorkflowComplete(input)).toThrow('POLAR_OBSERVATION_BINDING_INVALID');
  });

  it('rejects synthetic observation provenance', () => {
    const input = polarReceipt();
    const observation = input.observations[0];
    if (!observation) throw Error('FIXTURE_MISSING');
    observation.mode = 'local_replay';
    expect(() => assertPolarWorkflowComplete(input)).toThrow();
  });

  it('requires one browser screenshot bound to each browser observation', () => {
    const input = polarReceipt();
    input.artifacts.pop();
    expect(() => assertPolarWorkflowComplete(input)).toThrow('POLAR_ARTIFACT_BINDING_INVALID');
  });

  it('rejects a duplicate browser artifact hidden by set membership', () => {
    const input = polarReceipt();
    const first = input.artifacts[0];
    if (!first) throw Error('FIXTURE_MISSING');
    input.artifacts.push({ ...first });
    expect(() => assertPolarWorkflowComplete(input)).toThrow('POLAR_ARTIFACT_BINDING_INVALID');
  });

  it.each([
    ['leftover', 'POLAR_CHECKOUT_STILL_OPEN'],
    ['retained', 'POLAR_UNPAID_AUDIT_RETAINED'],
  ])('rejects incomplete provider cleanup %s/%s', (status, code) => {
    const input = polarReceipt();
    const provider = input.cleanup[2];
    if (!provider) throw Error('FIXTURE_MISSING');
    provider.status = status;
    provider.code = code;
    expect(() => assertPolarWorkflowComplete(input)).toThrow('POLAR_CLEANUP_INCOMPLETE');
  });
});
