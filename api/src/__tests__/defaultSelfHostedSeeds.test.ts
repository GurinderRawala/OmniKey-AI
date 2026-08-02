import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from 'winston';
import { decompressString } from '../compression';

const mocks = vi.hoisted(() => ({
  subscriptionFindAll: vi.fn(),
  taskTemplateFindAll: vi.fn(),
  taskTemplateCreate: vi.fn(),
  mcpServerFindAll: vi.fn(),
  mcpServerCreate: vi.fn(),
}));

vi.mock('../models/subscription', () => ({
  Subscription: {
    findAll: mocks.subscriptionFindAll,
  },
}));

vi.mock('../models/subscriptionTaskTemplate', () => ({
  SubscriptionTaskTemplate: {
    findAll: mocks.taskTemplateFindAll,
    create: mocks.taskTemplateCreate,
  },
}));

vi.mock('../models/mcpServer', () => ({
  MCPServer: {
    findAll: mocks.mcpServerFindAll,
    create: mocks.mcpServerCreate,
  },
}));

import {
  DEFAULT_CODING_AGENT_HEADING,
  seedDefaultSelfHostedAgentAssets,
  seedDefaultSelfHostedAgentAssetsForSubscription,
} from '../agent/defaultSelfHostedSeeds';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

beforeEach(() => {
  mocks.subscriptionFindAll.mockReset();
  mocks.taskTemplateFindAll.mockReset();
  mocks.taskTemplateCreate.mockReset();
  mocks.mcpServerFindAll.mockReset();
  mocks.mcpServerCreate.mockReset();
});

describe('seedDefaultSelfHostedAgentAssets', () => {
  it('creates the coding-agent instructions and bundled MCPs for subscriptions missing them', async () => {
    const logger = makeLogger();
    mocks.subscriptionFindAll.mockResolvedValue([{ id: 'sub-1' }]);
    mocks.taskTemplateFindAll.mockResolvedValue([]);
    mocks.mcpServerFindAll.mockResolvedValue([]);

    await seedDefaultSelfHostedAgentAssets(logger);

    expect(mocks.taskTemplateCreate).toHaveBeenCalledWith({
      subscriptionId: 'sub-1',
      heading: DEFAULT_CODING_AGENT_HEADING,
      instructions: expect.stringMatching(/^gz1:/),
      isDefault: false,
    });

    const createdInstructions = decompressString(
      mocks.taskTemplateCreate.mock.calls[0][0].instructions,
    );
    expect(createdInstructions).toContain('You are a senior coding agent.');
    expect(createdInstructions).toContain('Stop when the task is done.');

    expect(mocks.mcpServerCreate).toHaveBeenCalledTimes(3);
    expect(mocks.mcpServerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub-1',
        name: 'filesystem',
        command: 'npx',
        args: expect.arrayContaining(['@modelcontextprotocol/server-filesystem']),
        isEnabled: true,
      }),
    );
    expect(mocks.mcpServerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub-1',
        name: 'playwright',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        isEnabled: true,
      }),
    );
    expect(mocks.mcpServerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub-1',
        name: 'git',
        command: 'uvx',
        args: ['mcp-server-git'],
        isEnabled: true,
      }),
    );
  });
});

describe('seedDefaultSelfHostedAgentAssetsForSubscription', () => {
  it('does not overwrite existing templates or MCP server configs', async () => {
    const logger = makeLogger();
    mocks.taskTemplateFindAll.mockResolvedValue([{ heading: ' coding agent ' }]);
    mocks.mcpServerFindAll.mockResolvedValue([{ name: 'Filesystem' }, { name: 'GIT' }]);

    await seedDefaultSelfHostedAgentAssetsForSubscription('sub-2', logger);

    expect(mocks.taskTemplateCreate).not.toHaveBeenCalled();
    expect(mocks.mcpServerCreate).toHaveBeenCalledTimes(1);
    expect(mocks.mcpServerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub-2',
        name: 'playwright',
      }),
    );
  });

  it('coalesces concurrent seed attempts for the same subscription', async () => {
    const logger = makeLogger();
    mocks.taskTemplateFindAll.mockResolvedValue([]);
    mocks.mcpServerFindAll.mockResolvedValue([]);

    await Promise.all([
      seedDefaultSelfHostedAgentAssetsForSubscription('sub-3', logger),
      seedDefaultSelfHostedAgentAssetsForSubscription('sub-3', logger),
    ]);

    expect(mocks.taskTemplateCreate).toHaveBeenCalledTimes(1);
    expect(mocks.mcpServerCreate).toHaveBeenCalledTimes(3);
  });
});
