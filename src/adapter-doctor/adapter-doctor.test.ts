import { serve } from '@hono/node-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TargetTransport } from '#integrations/network';
import { createReferenceApp } from '#reference';
import { createAdapterDoctor, HttpAdapterDoctorTarget } from './index.ts';

const buildId = 'a'.repeat(40);
const adapterToken = 'synthetic-adapter-doctor-token';
let directory: string;
let reference: ReturnType<typeof createReferenceApp> | undefined;
let server: ReturnType<typeof serve> | undefined;

async function fixture(
  options: {
    wrongStagingDenial?: boolean;
    redirectUnauthenticated?: boolean;
    redirectFeature?: boolean;
    publicFeature?: boolean;
    wrongBuild?: boolean;
    extraDescriptionField?: boolean;
    cacheableFeatureDenial?: boolean;
    rejectConfiguredCredential?: boolean;
    customFeature?: boolean;
    invalidJsonMediaType?: boolean;
    nonCanonicalFeaturePath?: '/api/./admin' | '/api/%2e%2e/admin';
  } = {},
) {
  directory = await mkdtemp(join(tmpdir(), 'paywallproof-adapter-doctor-'));
  reference = createReferenceApp({
    databasePath: join(directory, 'target.sqlite'),
    stagingEnabled: true,
    adapterToken: options.rejectConfiguredCredential ? 'different-server-token' : adapterToken,
    replaySecret: 'synthetic-replay-secret',
    webhookSecret: 'synthetic-webhook-secret',
    priceId: 'price_synthetic',
    buildId: options.wrongBuild ? 'b'.repeat(40) : buildId,
  });
  const app = reference.app;
  const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  const origin = await new Promise<string>((resolve, reject) => {
    server = serve(
      {
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => {
          const path = new URL(request.url).pathname;
          requests.push({
            method: request.method,
            path,
            authorization: request.headers.get('authorization'),
          });
          if (
            options.wrongStagingDenial &&
            path === '/staging/describe' &&
            !request.headers.has('authorization')
          )
            return Response.json(
              { error: 'WRONG_AUTH_CONTRACT' },
              { status: 401, headers: { 'Cache-Control': 'no-store' } },
            );
          if (
            options.nonCanonicalFeaturePath &&
            path === '/staging/describe' &&
            request.headers.has('authorization')
          )
            return Response.json(
              {
                adapterVersion: '1',
                environment: 'test',
                buildId,
                billingTimeModel: 'provider_status',
                feature: {
                  id: 'pro_export',
                  method: 'GET',
                  path: options.nonCanonicalFeaturePath,
                  denialStatuses: [403],
                  browserPath: '/dashboard',
                  actionTestId: 'export-button',
                  resultTestId: 'export-result',
                },
              },
              { headers: { 'Cache-Control': 'no-store' } },
            );
          if (
            options.invalidJsonMediaType &&
            path === '/staging/describe' &&
            request.headers.has('authorization')
          )
            return new Response(
              JSON.stringify({
                adapterVersion: '1',
                environment: 'test',
                buildId,
                billingTimeModel: 'provider_status',
                feature: {
                  id: 'pro_export',
                  method: 'GET',
                  path: '/api/export',
                  denialStatuses: [403],
                  browserPath: '/dashboard',
                  actionTestId: 'export-button',
                  resultTestId: 'export-result',
                },
              }),
              {
                headers: {
                  'Cache-Control': 'no-store',
                  'Content-Type': 'application/jsonp',
                },
              },
            );
          if (
            options.extraDescriptionField &&
            path === '/staging/describe' &&
            request.headers.has('authorization')
          )
            return Response.json(
              {
                adapterVersion: '1',
                environment: 'test',
                buildId,
                billingTimeModel: 'provider_status',
                feature: {
                  id: 'pro_export',
                  method: 'GET',
                  path: '/api/export',
                  denialStatuses: [403],
                  browserPath: '/dashboard',
                  actionTestId: 'export-button',
                  resultTestId: 'export-result',
                },
                untrustedExtension: true,
              },
              { headers: { 'Cache-Control': 'no-store' } },
            );
          if (
            options.customFeature &&
            path === '/staging/describe' &&
            request.headers.has('authorization')
          )
            return Response.json(
              {
                adapterVersion: '1',
                environment: 'test',
                buildId,
                billingTimeModel: 'provider_status',
                feature: {
                  id: 'pipeline_export',
                  method: 'GET',
                  path: '/api/paywallproof/export',
                  denialStatuses: [402, 403],
                  browserPath: '/admin',
                  actionTestId: 'pipeline-export-button',
                  resultTestId: 'pipeline-export-result',
                },
              },
              { headers: { 'Cache-Control': 'no-store' } },
            );
          if (
            options.redirectUnauthenticated &&
            path === '/staging/describe' &&
            !request.headers.has('authorization')
          )
            return new Response(null, {
              status: 302,
              headers: { Location: '/credential-leak-destination' },
            });
          if (options.redirectFeature && path === '/api/export')
            return new Response(null, {
              status: 302,
              headers: { Location: '/ordinary-session-leak-destination' },
            });
          if (options.publicFeature && path === '/api/export')
            return Response.json(
              { fixtureMarker: 'synthetic-credential-escalation' },
              { headers: { 'Cache-Control': 'no-store' } },
            );
          if (options.cacheableFeatureDenial && path === '/api/export')
            return Response.json({ error: 'AUTHENTICATION_REQUIRED' }, { status: 401 });
          if (options.customFeature && path === '/api/paywallproof/export')
            return Response.json(
              { error: 'AUTHENTICATION_REQUIRED' },
              { status: 401, headers: { 'Cache-Control': 'no-store' } },
            );
          return app.fetch(request);
        },
      },
      (info) => resolve(`http://127.0.0.1:${info.port}`),
    );
    server.once('error', reject);
  });
  const transport = new TargetTransport({ origin, allowLoopback: true, timeoutMs: 2_000 });
  return {
    doctor: createAdapterDoctor({
      targetId: 'reference',
      expectedBuildId: buildId,
      target: new HttpAdapterDoctorTarget({ transport, adapterToken }),
    }),
    requests,
  };
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  reference?.close();
  reference = undefined;
  const activeServer = server;
  if (activeServer?.listening)
    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => (error ? reject(error) : resolve()));
    });
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('Adapter Doctor', () => {
  it('accepts the exact read-only contract and emits a policy-bindable receipt', async () => {
    const { doctor, requests } = await fixture();

    const report = await doctor.inspect();

    expect(report.verdict).toBe('compatible');
    if (report.verdict !== 'compatible') throw new Error('Expected a compatible report');
    expect(report.receipt.description.buildId).toBe(buildId);
    expect(report.receipt.description.feature.id).toBe('pro_export');
    expect(report.receipt.featureConfigHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.checks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'description', status: 'pass' },
      { id: 'build_binding', status: 'pass' },
      { id: 'staging_authentication', status: 'pass' },
      { id: 'ordinary_feature_isolation', status: 'pass' },
      { id: 'response_cache_policy', status: 'pass' },
    ]);
    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/staging/describe',
        authorization: `Bearer ${adapterToken}`,
      },
      { method: 'GET', path: '/staging/describe', authorization: null },
      {
        method: 'GET',
        path: '/api/export',
        authorization: `Bearer ${adapterToken}`,
      },
    ]);
  });

  it('blocks a staging route whose 401 body does not match the adapter auth contract', async () => {
    const { doctor, requests } = await fixture({ wrongStagingDenial: true });

    const report = await doctor.inspect();

    expect(report.verdict).toBe('blocked');
    expect(report.checks.find((check) => check.id === 'staging_authentication')).toMatchObject({
      status: 'blocked',
      code: 'STAGING_AUTH_CONTRACT_MISMATCH',
    });
    expect(report.checks[3]).toMatchObject({ status: 'not_observed' });
    expect(requests).toHaveLength(2);
  });

  it('turns an authentication-check redirect into a safe blocked report', async () => {
    const { doctor } = await fixture({ redirectUnauthenticated: true });

    const report = await doctor.inspect();

    expect(report.verdict).toBe('blocked');
    expect(report.checks).toMatchObject([
      { id: 'description', status: 'pass' },
      { id: 'build_binding', status: 'pass' },
      {
        id: 'staging_authentication',
        status: 'blocked',
        code: 'TARGET_REDIRECT_REJECTED',
      },
      { id: 'ordinary_feature_isolation', status: 'not_observed' },
      { id: 'response_cache_policy', status: 'not_observed' },
    ]);
    expect(JSON.stringify(report)).not.toContain('credential-leak-destination');
  });

  it('turns a protected-feature redirect into a safe blocked report', async () => {
    const { doctor } = await fixture({ redirectFeature: true });

    const report = await doctor.inspect();

    expect(report.verdict).toBe('blocked');
    expect(report.checks).toMatchObject([
      { id: 'description', status: 'pass' },
      { id: 'build_binding', status: 'pass' },
      { id: 'staging_authentication', status: 'pass' },
      {
        id: 'ordinary_feature_isolation',
        status: 'blocked',
        code: 'TARGET_REDIRECT_REJECTED',
      },
      { id: 'response_cache_policy', status: 'not_observed' },
    ]);
    expect(JSON.stringify(report)).not.toContain('ordinary-session-leak-destination');
  });

  it('blocks an adapter credential that grants ordinary protected-feature access', async () => {
    const { doctor } = await fixture({ publicFeature: true });

    const report = await doctor.inspect();

    expect(report.verdict).toBe('blocked');
    expect(report.checks.find((check) => check.id === 'ordinary_feature_isolation')).toMatchObject({
      status: 'blocked',
      code: 'ADAPTER_CREDENTIAL_GRANTS_FEATURE_ACCESS',
    });
    expect(report.checks[4]).toMatchObject({ status: 'not_observed' });
  });

  it('blocks a deployment whose build does not match the selected source', async () => {
    const { doctor, requests } = await fixture({ wrongBuild: true });

    const report = await doctor.inspect();

    expect(report.verdict).toBe('blocked');
    expect(report.checks.find((check) => check.id === 'build_binding')).toMatchObject({
      status: 'blocked',
      code: 'TARGET_BUILD_MISMATCH',
    });
    expect(report.checks.slice(2).every((check) => check.status === 'not_observed')).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('rejects unversioned fields in the target description', async () => {
    const { doctor } = await fixture({ extraDescriptionField: true });

    const report = await doctor.inspect();

    expect(report.verdict).toBe('blocked');
    expect(report.checks[0]).toMatchObject({
      id: 'description',
      status: 'blocked',
      code: 'TARGET_DESCRIPTION_INVALID',
    });
  });

  it('rejects a JSON-like media type that is not application/json', async () => {
    const { doctor, requests } = await fixture({ invalidJsonMediaType: true });

    const report = await doctor.inspect();

    expect(report.verdict).toBe('blocked');
    expect(report.checks[0]).toMatchObject({
      id: 'description',
      status: 'blocked',
      code: 'TARGET_DESCRIPTION_INVALID',
    });
    expect(requests).toHaveLength(1);
  });

  it.each(['/api/./admin', '/api/%2e%2e/admin'] as const)(
    'rejects a feature path that URL normalization would rewrite: %s',
    async (nonCanonicalFeaturePath) => {
      const { doctor, requests } = await fixture({ nonCanonicalFeaturePath });

      const report = await doctor.inspect();

      expect(report.verdict).toBe('blocked');
      expect(report.checks[0]).toMatchObject({
        id: 'description',
        status: 'blocked',
        code: 'TARGET_DESCRIPTION_INVALID',
      });
      expect(requests).toHaveLength(1);
    },
  );

  it('blocks a diagnostic response that can be cached', async () => {
    const { doctor } = await fixture({ cacheableFeatureDenial: true });

    const report = await doctor.inspect();

    expect(report.verdict).toBe('blocked');
    expect(report.checks.find((check) => check.id === 'response_cache_policy')).toMatchObject({
      status: 'blocked',
      code: 'NO_STORE_MISSING',
    });
  });

  it('classifies a rejected configured credential without probing dependent routes', async () => {
    const { doctor, requests } = await fixture({ rejectConfiguredCredential: true });

    const report = await doctor.inspect();

    expect(report.verdict).toBe('blocked');
    expect(report.checks[0]).toMatchObject({
      id: 'description',
      status: 'blocked',
      code: 'ADAPTER_CREDENTIAL_REJECTED',
    });
    expect(requests).toHaveLength(1);
  });

  it('emits the same report for unchanged observations', async () => {
    const { doctor } = await fixture();

    expect(await doctor.inspect()).toEqual(await doctor.inspect());
  });

  it('accepts a different protected feature that still satisfies target contract v1', async () => {
    const { doctor, requests } = await fixture({ customFeature: true });

    const report = await doctor.inspect();

    expect(report.verdict).toBe('compatible');
    if (report.verdict !== 'compatible') throw new Error('Expected a compatible report');
    expect(report.receipt.description.feature).toMatchObject({
      id: 'pipeline_export',
      path: '/api/paywallproof/export',
      browserPath: '/admin',
      denialStatuses: [402, 403],
    });
    expect(requests[2]?.path).toBe('/api/paywallproof/export');
  });

  it('classifies a platform timeout without probing dependent routes', async () => {
    const timeout = new Error('The operation timed out');
    timeout.name = 'TimeoutError';
    const aborted = new Error('The operation was aborted', { cause: timeout });
    aborted.name = 'AbortError';
    const describe = vi.fn().mockRejectedValue(aborted);
    const doctor = createAdapterDoctor({
      targetId: 'reference',
      expectedBuildId: buildId,
      target: {
        describe,
        featureWithAdapterCredential: vi.fn(),
      },
    });

    const report = await doctor.inspect();

    expect(report.verdict).toBe('blocked');
    expect(report.checks[0]).toMatchObject({
      id: 'description',
      status: 'blocked',
      code: 'TARGET_TIMEOUT',
    });
    expect(describe).toHaveBeenCalledOnce();
  });
});
