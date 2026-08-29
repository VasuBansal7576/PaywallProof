import { describe, expect, it, vi } from 'vitest';
import {
  checkoutReadyForVerification,
  continueCheckoutForVerification,
  workflowDeadlineAfterPoll,
  workflowReadyForReport,
} from './workflow-runner.ts';

describe('workflow checkout readiness', () => {
  it('recognizes the worker checkout route documented 303 response', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.redirect('https://sandbox.polar.sh/checkout/synthetic', 303),
    );
    await expect(checkoutReadyForVerification('test-token', 'test-run', transport)).resolves.toBe(
      true,
    );
  });

  it('keeps polling only for the documented not-ready response', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response('{}', { status: 409 }));
    await expect(checkoutReadyForVerification('test-token', 'test-run', transport)).resolves.toBe(
      false,
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
  it('keeps polling while provider completion is not yet confirmed', async () => {
    const transport = vi.fn(async () => new Response('{}', { status: 409 }));
    await expect(
      continueCheckoutForVerification('test-token', 'test-run', transport),
    ).resolves.toBe(false);
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
