import { describe, expect, it, vi } from 'vitest';
import {
  checkoutReadyForVerification,
  continueCheckoutForVerification,
  workflowDeadlineAfterPoll,
  workflowPolicyRequest,
  workflowProjectRequest,
  workflowReadyForReport,
  workflowShouldPollCheckout,
} from './workflow-runner.ts';
import { hashValue } from '../src/domain/index.ts';
import { ADAPTER_DOCTOR_SCOPE, type AdapterDoctorReport } from '#adapter-doctor';

const revenueFeature = {
  id: 'pipeline_export',
  method: 'GET' as const,
  path: '/api/export',
  denialStatuses: [403] satisfies 403[],
  browserPath: '/admin',
  actionTestId: 'pipeline-export-button',
  resultTestId: 'pipeline-export-result',
};

describe('workflow checkout readiness', () => {
  it('does not poll the checkout route until an approved Polar run reaches its external wait', () => {
    const checkoutPhase = {
      mode: 'polar_sandbox',
      approved: true,
      checkoutAnnounced: false,
      runtimeStatus: 'waiting_external',
    } satisfies Parameters<typeof workflowShouldPollCheckout>[0];
    expect(workflowShouldPollCheckout({ ...checkoutPhase, approved: false })).toBe(false);
    expect(workflowShouldPollCheckout({ ...checkoutPhase, runtimeStatus: 'approval' })).toBe(false);
    expect(workflowShouldPollCheckout({ ...checkoutPhase, runtimeStatus: 'running' })).toBe(false);
    expect(workflowShouldPollCheckout({ ...checkoutPhase, mode: 'local_replay' })).toBe(false);
    expect(workflowShouldPollCheckout({ ...checkoutPhase, checkoutAnnounced: true })).toBe(false);
    expect(workflowShouldPollCheckout(checkoutPhase)).toBe(true);
  });

  it('recognizes the worker checkout route documented 303 response', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.redirect('https://sandbox.polar.sh/checkout/synthetic', 303),
    );
    await expect(checkoutReadyForVerification('test-token', 'test-run', transport)).resolves.toBe(
      true,
    );
  });

  it('keeps polling only for the documented not-ready response', async () => {
    const transport = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { code: 'CHECKOUT_NOT_READY' } }), { status: 409 }),
    );
    await expect(checkoutReadyForVerification('test-token', 'test-run', transport)).resolves.toBe(
      false,
    );
  });

  it('fails closed on a different checkout-route conflict', async () => {
    const transport = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { code: 'PROJECT_CONFIG_CHANGED' } }), {
          status: 409,
        }),
    );
    await expect(checkoutReadyForVerification('test-token', 'test-run', transport)).rejects.toThrow(
      'CHECKOUT_ROUTE_409',
    );
  });

  it('fails closed on an unexpected redirect status', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.redirect('https://sandbox.polar.sh/checkout/synthetic', 302),
    );
    await expect(checkoutReadyForVerification('test-token', 'test-run', transport)).rejects.toThrow(
      'CHECKOUT_ROUTE_302',
    );
  });
});

describe('workflow checkout continuation', () => {
  it('freezes a report only after both controller and TrueForge are terminal', () => {
    expect(workflowReadyForReport('completed', 'running')).toBe(false);
    expect(workflowReadyForReport('completed', 'done')).toBe(true);
    expect(workflowReadyForReport('running', 'done')).toBe(false);
  });
  it('does not spend the active workflow budget during the persisted external wait', () => {
    expect(workflowDeadlineAfterPoll(10_000, 2_000, 5_500, 'waiting_external')).toBe(13_500);
    expect(workflowDeadlineAfterPoll(10_000, 2_000, 5_500, 'running')).toBe(10_000);
  });
  it.each(['CHECKOUT_CONTINUATION_NOT_READY', 'CHECKOUT_PENDING'])(
    'keeps polling for the documented continuation conflict %s',
    async (code) => {
      const transport = vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify({ error: { code } }), { status: 409 }),
      );
      await expect(
        continueCheckoutForVerification('test-token', 'test-run', transport),
      ).resolves.toBe(false);
    },
  );

  it('fails closed on a different continuation conflict', async () => {
    const transport = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { code: 'CHECKOUT_CONTINUATION_IN_FLIGHT' } }), {
          status: 409,
        }),
    );
    await expect(
      continueCheckoutForVerification('test-token', 'test-run', transport),
    ).rejects.toThrow('CHECKOUT_CONTINUATION_409');
  });

  it('accepts only a persisted runtime continuation receipt', async () => {
    const transport = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'resumed', turnId: 'continued-turn' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      continueCheckoutForVerification('test-token', 'test-run', transport),
    ).resolves.toBe(true);
  });
});

describe('workflow target binding', () => {
  it('builds project and policy input from the configured target and doctor receipt', () => {
    const config = {
      target: { id: 'secondary-contract-target', origin: 'http://127.0.0.1:3001' },
      repository: 'example/secondary-contract-target',
      defaultRef: 'a'.repeat(40),
      priceId: 'price_revenue_pipeline_monthly',
      model: 'synthetic-model',
    };
    expect(
      workflowProjectRequest(config, 'local_replay', '2026-08-30T00:00:00.000Z'),
    ).toMatchObject({
      repository: config.repository,
      ref: config.defaultRef,
      targetId: config.target.id,
      targetOrigin: config.target.origin,
      modelConsentModel: config.model,
    });
    const report = {
      schemaVersion: 1,
      targetId: config.target.id,
      expectedBuildId: config.defaultRef,
      verdict: 'compatible',
      checks: [
        {
          id: 'description',
          code: 'DESCRIPTION_COMPATIBLE',
          title: 'Description',
          detail: 'Passed.',
          status: 'pass',
        },
        {
          id: 'build_binding',
          code: 'BUILD_MATCHED',
          title: 'Build binding',
          detail: 'Passed.',
          status: 'pass',
        },
        {
          id: 'staging_authentication',
          code: 'STAGING_AUTHENTICATION_ENFORCED',
          title: 'Staging authentication',
          detail: 'Passed.',
          status: 'pass',
        },
        {
          id: 'ordinary_feature_isolation',
          code: 'ADAPTER_CREDENTIAL_ISOLATED',
          title: 'Ordinary feature isolation',
          detail: 'Passed.',
          status: 'pass',
        },
        {
          id: 'response_cache_policy',
          code: 'NO_STORE_ENFORCED',
          title: 'Response cache policy',
          detail: 'Passed.',
          status: 'pass',
        },
      ],
      receipt: {
        description: {
          adapterVersion: '1',
          environment: 'test',
          buildId: config.defaultRef,
          billingTimeModel: 'provider_status',
          feature: revenueFeature,
        },
        featureConfigHash: hashValue(revenueFeature),
      },
      scope: ADAPTER_DOCTOR_SCOPE,
    } satisfies AdapterDoctorReport;
    expect(workflowPolicyRequest(config, report)).toMatchObject({
      featureId: revenueFeature.id,
      featureConfigHash: hashValue(revenueFeature),
      predicateVersion: 'paywallproof-entitlement-v1',
    });
  });
});
