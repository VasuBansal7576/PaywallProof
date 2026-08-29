import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './[...path]/route';
afterEach(() => vi.unstubAllGlobals());
describe('operator proxy checkout redirect, implementation-aware', () => {
  it('forwards only a sandbox checkout redirect without following it', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 303,
          headers: {
            Location: 'https://sandbox.polar.sh/checkout/synthetic-only',
            'Referrer-Policy': 'no-referrer',
          },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const response = await GET(new Request('http://127.0.0.1:3000/api/runs/run-one/checkout'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://sandbox.polar.sh/checkout/synthetic-only',
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ redirect: 'manual' })]),
    );
  });
  it.each([
    'https://polar.sh/checkout/live',
    'https://sandbox.polar.sh.evil.invalid/checkout/x',
    'https://user:pass@sandbox.polar.sh/checkout/x',
    'http://sandbox.polar.sh/checkout/x',
    'https://sandbox.polar.sh/settings',
  ])('rejects unsafe worker redirect %s', async (location) => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(null, { status: 303, headers: { Location: location } }),
    );
    const response = await GET(new Request('http://127.0.0.1:3000/api/runs/run-one/checkout'));
    expect(response.status).toBe(503);
    expect(response.headers.has('location')).toBe(false);
  });
  it('does not allow redirects from other routes or POST actions', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(null, {
          status: 303,
          headers: { Location: 'https://sandbox.polar.sh/checkout/test' },
        }),
    );
    expect((await GET(new Request('http://127.0.0.1:3000/api/runs/run-one/report'))).status).toBe(
      503,
    );
    expect(
      (
        await POST(
          new Request('http://127.0.0.1:3000/api/runs/run-one/checkout', {
            method: 'POST',
            body: '{}',
          }),
        )
      ).status,
    ).toBe(503);
  });
});
