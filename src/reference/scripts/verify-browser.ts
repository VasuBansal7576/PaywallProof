import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { signReplay } from '../replay-signature.ts';
import { z } from 'zod';

// This script connects only to the explicitly local reference test server.
const origin = 'http://127.0.0.1:3411';
const runId = `browser_${randomUUID()}`;
const headers = {
  authorization: 'Bearer reference-browser-adapter',
  'content-type': 'application/json',
};
const fixtureMarker = `private_browser_fixture_${randomUUID()}`;
async function post(path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`SETUP_${response.status}`);
  return response.json();
}
const user = z
  .object({ principalId: z.string() })
  .parse(await post('/staging/users', { runId, operationId: `create_${runId}`, fixtureMarker }));
const customerId = `cus_browser_${randomUUID().replaceAll('-', '')}`;
await post(`/staging/users/${user.principalId}/customer`, { runId, customerId });
const session = z
  .object({ cookie: z.string() })
  .parse(await post(`/staging/users/${user.principalId}/session`, { runId }));
const cookieValue = session.cookie.slice('pp_session='.length);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.addCookies([
    { name: 'pp_session', value: cookieValue, url: origin, httpOnly: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  await page.goto(`${origin}/dashboard`);
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-result')).toHaveAttribute('data-status', 'denied');
  await expect(page.getByTestId('export-result')).not.toContainText(fixtureMarker);
  async function replay(status: string, created: number) {
    const body = JSON.stringify({
      id: `evt_browser_${runId}_${created}`,
      type:
        status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated',
      livemode: false,
      created,
      data: {
        object: {
          id: `sub_${runId}`,
          object: 'subscription',
          livemode: false,
          customer: customerId,
          metadata: { runId },
          status,
          cancel_at_period_end: false,
          items: {
            data: [
              { price: { id: 'price_browser', livemode: false }, current_period_end: 2000000000 },
            ],
          },
          latest_invoice: {
            livemode: false,
            status: 'paid',
            billing_reason: 'subscription_create',
            customer: customerId,
          },
        },
      },
    });
    const response = await fetch(`${origin}/staging/replay`, {
      method: 'POST',
      headers: {
        ...headers,
        'paywallproof-replay-signature': signReplay({
          payload: body,
          secret: 'reference-browser-replay-secret',
        }),
      },
      body,
    });
    if (!response.ok) throw new Error(`REPLAY_${response.status}`);
  }
  await replay('active', 100);
  await page.reload();
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-result')).toHaveAttribute('data-status', 'allowed');
  await expect(page.getByTestId('export-result')).toContainText(fixtureMarker);
  await expect(page.getByRole('note')).toContainText('Local replay');
  mkdirSync('apps/demo-saas/.local', { recursive: true });
  await page.screenshot({ path: 'apps/demo-saas/.local/browser-pro.png', fullPage: true });
  await replay('canceled', 200);
  await page.reload();
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-result')).toHaveAttribute('data-status', 'denied');
  await expect(page.getByTestId('export-result')).not.toContainText(fixtureMarker);
  process.stdout.write(
    'PASS: real Next dashboard, ordinary session, free denial, signed local replay activation, marker export, cancellation denial. Mode: local_replay.\n',
  );
} finally {
  await browser.close();
  await fetch(`${origin}/staging/users/${user.principalId}?runId=${encodeURIComponent(runId)}`, {
    method: 'DELETE',
    headers,
  });
}
