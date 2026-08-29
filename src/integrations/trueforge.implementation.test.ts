import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { TrueForgeAdapter } from './trueforge.ts';

const sdk = vi.hoisted(() => ({
  createSession: vi.fn(),
  createTurn: vi.fn(),
  getTurn: vi.fn(),
  listTurnEvents: vi.fn(),
  listTurns: vi.fn(),
  upsertSkill: vi.fn(),
}));

vi.mock('@truefoundry/trueforge-sdk', () => ({
  TrueForge: class {
    settings = {
      skills: { createOrUpdate: sdk.upsertSkill },
      modelProviders: {
        list: vi.fn(async () => ({
          data: [
            {
              name: 'local',
              manifest: {
                type: 'custom',
                name: 'local',
                baseUrl: 'http://127.0.0.1:9876/v1',
                models: [
                  {
                    name: 'model',
                    modelId: 'synthetic-model',
                    properties: { reasoningEfforts: [] },
                  },
                ],
              },
            },
          ],
        })),
      },
    };

    sessions = {
      ...sdk,
      create: sdk.createSession,
    };
  },
}));

function doneTurn(
  id: string,
  requiredActions: Extract<TrueForgeApi.Turn['state'], { status: 'done' }>['requiredActions'] = [],
  createdAt = '2026-08-29T12:00:00.000Z',
): TrueForgeApi.Turn {
  return {
    id,
    sessionId: 'session',
    previousTurnId: null,
    createdAt,
    state: {
      status: 'done',
      completedAt: new Date().toISOString(),
      output: null,
      requiredActions,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.createTurn.mockResolvedValue({ data: doneTurn('continued') });
  sdk.createSession.mockResolvedValue({ data: { id: 'review-session' } });
  sdk.upsertSkill.mockResolvedValue({ data: { name: 'paywallproof-evidence-review' } });
});

describe('TrueForge newest-turn contract', () => {
  it.each([
    ['newest-first', ['newest', 'older']],
    ['oldest-first', ['older', 'newest']],
  ] as const)('continues the newest turn from a %s multi-page iterator', async (_, order) => {
    const turns = {
      older: doneTurn('older', [], '2026-08-29T12:00:00.000Z'),
      newest: doneTurn('newest', [], '2026-08-29T12:00:01.000Z'),
    };
    sdk.listTurns.mockImplementation(async function* () {
      for (const id of order) yield turns[id];
    });

    const adapter = new TrueForgeAdapter({ model: 'local/model' });
    await expect(
      adapter.continueTurn({
        sessionId: 'session',
        previousTurnId: 'newest',
        input: 'Continue',
      }),
    ).resolves.toMatchObject({ id: 'continued' });
    expect(sdk.createTurn).toHaveBeenCalledWith('session', {
      previousTurnId: 'newest',
      input: [{ type: 'user.message', content: 'Continue' }],
    });
  });

  it('continues approval for the first item when older pages also exist', async () => {
    const requiredActions: Extract<
      TrueForgeApi.Turn['state'],
      { status: 'done' }
    >['requiredActions'] = [
      {
        type: 'tool.approval_required',
        id: 'approval-required',
        createdAt: new Date().toISOString(),
        threadId: 'main',
        toolCalls: [{ id: 'call', sourceEventId: 'event' }],
      },
    ];
    sdk.listTurns.mockImplementation(async function* () {
      yield doneTurn('older', [], '2026-08-29T12:00:00.000Z');
      yield doneTurn('newest', requiredActions, '2026-08-29T12:00:01.000Z');
    });
    sdk.getTurn.mockResolvedValue({ data: doneTurn('newest', requiredActions) });
    sdk.listTurnEvents.mockImplementation(async function* () {
      yield {
        type: 'model.message',
        id: 'event',
        threadId: 'main',
        createdAt: new Date().toISOString(),
        toolCalls: [
          {
            type: 'function',
            id: 'call',
            function: { name: 'prepare_fixture', arguments: '{}' },
            toolInfo: { type: 'mcp', name: 'prepare_fixture' },
          },
        ],
      };
    });

    const adapter = new TrueForgeAdapter({ model: 'local/model' });
    await expect(
      adapter.continueApproval({
        sessionId: 'session',
        turnId: 'newest',
        decisions: [{ threadId: 'main', toolCallId: 'call', approval: { status: 'allow' } }],
      }),
    ).resolves.toMatchObject({ id: 'continued' });
  });
});

describe('TrueForge evidence-review configuration', () => {
  it('registers the repository skill and enables it with dynamic subagents', async () => {
    const adapter = new TrueForgeAdapter({ model: 'local/model' });
    await adapter.registerSkill({
      name: 'paywallproof-evidence-review',
      description: 'Review a completed report.',
      repositoryUrl: 'https://github.com/example/paywallproof.git',
      ref: 'a'.repeat(40),
      path: 'skills/paywallproof-evidence-review',
    });
    await adapter.createSession({
      instructions: 'Coordinate an independent review.',
      mcpServerName: 'paywallproof_review',
      enableTools: ['read_run_report', 'record_evidence_review'],
      requireApprovalForTools: [],
      skills: ['paywallproof-evidence-review'],
      dynamicSubAgents: true,
      sandbox: true,
    });

    expect(sdk.upsertSkill).toHaveBeenCalledWith({
      manifest: {
        type: 'git',
        name: 'paywallproof-evidence-review',
        description: 'Review a completed report.',
        url: 'https://github.com/example/paywallproof.git',
        ref: 'a'.repeat(40),
        path: 'skills/paywallproof-evidence-review',
      },
    });
    expect(sdk.createSession).toHaveBeenCalledWith({
      agent: {
        spec: expect.objectContaining({
          skills: [{ name: 'paywallproof-evidence-review' }],
          mcpServers: [
            expect.objectContaining({
              name: 'paywallproof_review',
              enableTools: ['read_run_report', 'record_evidence_review'],
              requireApprovalForTools: [],
            }),
          ],
          config: expect.objectContaining({
            sandbox: { enabled: true },
            dynamicSubAgents: { enabled: true },
          }),
        }),
      },
    });
  });
});
