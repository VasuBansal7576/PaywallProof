import { describe, expect, it, vi } from 'vitest';
import { createPolarWebhookRelay } from './polar-webhook-relay.ts';

const headers = {
  'content-type': 'application/json',
  'webhook-id': 'evt_test',
  'webhook-timestamp': '1788010000',
  'webhook-signature': 'v1,test-signature',
};

describe('public Polar webhook relay', () => {
  it.each([
    ['GET', '/api/polar/webhook'],
    ['POST', '/'],
    ['POST', '/api/polar/webhook/extra'],
  ])('rejects %s %s without reaching the target', async (method, path) => {
    const forward = vi.fn<typeof fetch>();
    const response = await createPolarWebhookRelay(forward).request(path, { method });
    expect(response.status).toBe(404);
    expect(forward).not.toHaveBeenCalled();
  });

  it('forwards only the exact signed body and allowlisted headers', async () => {
    const forward = vi.fn<typeof fetch>(async (_url, request) => {
      expect(request?.method).toBe('POST');
      expect(request?.redirect).toBe('error');
      expect(request?.body).toBe('{"type":"subscription.active"}');
      const forwarded = new Headers(request?.headers);
      expect(Object.fromEntries(forwarded)).toEqual(headers);
      return Response.json({ received: true }, { status: 200 });
    });
    const response = await createPolarWebhookRelay(forward).request('/api/polar/webhook', {
      method: 'POST',
      headers: { ...headers, authorization: 'must-not-forward', cookie: 'must-not-forward' },
      body: '{"type":"subscription.active"}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(forward).toHaveBeenCalledOnce();
  });

  it.each([
    [{ 'content-type': 'text/plain' }, 415],
    [{ 'content-type': 'application/json' }, 400],
    [{ ...headers, 'content-length': '1048577' }, 413],
  ])('rejects malformed input before forwarding', async (patch, status) => {
    const forward = vi.fn<typeof fetch>();
    const response = await createPolarWebhookRelay(forward).request('/api/polar/webhook', {
      method: 'POST',
      headers: patch,
      body: '{}',
    });
    expect(response.status).toBe(status);
    expect(forward).not.toHaveBeenCalled();
  });

  it('fails closed when the private target cannot be reached', async () => {
    const response = await createPolarWebhookRelay(async () => {
      throw new Error('private target unavailable');
    }).request('/api/polar/webhook', { method: 'POST', headers, body: '{}' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'WEBHOOK_TARGET_UNAVAILABLE' });
  });
});
