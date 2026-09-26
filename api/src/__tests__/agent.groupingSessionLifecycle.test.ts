import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  findAll: vi.fn(),
  findByPk: vi.fn(),
  runAgentTurn: vi.fn(),
  handler: vi.fn(),
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../logger', () => ({ logger: mocks.log }));
vi.mock('../models/agentSession', () => ({
  AgentSession: { destroy: mocks.destroy, findAll: mocks.findAll },
}));
vi.mock('../models/subscription', () => ({
  Subscription: { findByPk: mocks.findByPk },
}));
vi.mock('../agent/sessionGrouping/agent/assignSessionGroupsTool', () => ({
  ASSIGN_SESSION_GROUPS_TOOL: {
    name: 'assign_session_groups',
    description: 'Assign groups',
    parameters: { type: 'object', properties: {} },
  },
  createAssignSessionGroupsHandler: vi.fn(() => mocks.handler),
}));
vi.mock('../agent/agentServer', () => ({ runAgentTurn: mocks.runAgentTurn }));

import { regroupSubscriptionViaAgent } from '../agent/sessionGrouping/agent/regroupViaAgent';

describe('grouping helper session lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.destroy.mockResolvedValue(1);
    mocks.findByPk.mockResolvedValue({ id: 'subscription-1' });
    mocks.findAll.mockResolvedValue([
      {
        id: 'session-1',
        title: 'Test session',
        groupName: null,
        groupDescription: null,
        sessionSummary: null,
        historyJson: JSON.stringify([{ role: 'user', content: 'Review this repository' }]),
      },
    ]);
  });

  it('keeps the helper parent row until the complete agent run settles', async () => {
    let finishRun: (() => void) | undefined;
    mocks.runAgentTurn.mockImplementation(
      async (_sessionId, _subscription, _message, send: (message: unknown) => void) => {
        send({ sender: 'agent', content: 'Running assign_session_groups' });
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        });
      },
    );

    const groupingRun = regroupSubscriptionViaAgent('subscription-1');
    await vi.waitFor(() => expect(finishRun).toBeTypeOf('function'));

    // The first destroy clears a stale row before starting. Activity messages
    // must not trigger the final cleanup while the agent is still persisting.
    expect(mocks.destroy).toHaveBeenCalledTimes(1);

    await regroupSubscriptionViaAgent('subscription-1');
    expect(mocks.findByPk).toHaveBeenCalledTimes(1);
    expect(mocks.runAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);

    finishRun?.();
    await groupingRun;

    expect(mocks.destroy).toHaveBeenCalledTimes(2);
    expect(mocks.destroy).toHaveBeenLastCalledWith({
      where: { id: 'grouping-subscription-1', subscriptionId: 'subscription-1' },
    });
  });
});
