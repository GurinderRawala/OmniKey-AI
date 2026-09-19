import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from 'winston';
import { decompressString } from '../compression';

const mocks = vi.hoisted(() => ({
  subscriptionFindAll: vi.fn(),
  taskTemplateFindAll: vi.fn(),
  taskTemplateCreate: vi.fn(),
  taskTemplateUpdate: vi.fn(),
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
    update: mocks.taskTemplateUpdate,
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
  DEFAULT_CODING_AGENT_INSTRUCTIONS_UPDATED_AT,
  resetDefaultSelfHostedSeedStateForTests,
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
  mocks.taskTemplateUpdate.mockReset();
  mocks.mcpServerFindAll.mockReset();
  mocks.mcpServerCreate.mockReset();
  resetDefaultSelfHostedSeedStateForTests();
});

describe('seedDefaultSelfHostedAgentAssets', () => {
  it('creates the coding-agent instructions and bundled MCPs for subscriptions missing them', async () => {
    const logger = makeLogger();
    mocks.subscriptionFindAll.mockResolvedValue([{ id: 'sub-1' }]);
    mocks.taskTemplateFindAll.mockResolvedValue([]);
    mocks.mcpServerFindAll.mockResolvedValue([]);

    await seedDefaultSelfHostedAgentAssets(logger);

    expect(mocks.taskTemplateCreate).toHaveBeenCalledWith({
      id: 'default-coding-agent-sub-1',
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
    expect(createdInstructions).toContain('AGENTS.override.md');
    expect(createdInstructions).toContain('AGENTS.md');
    expect(createdInstructions).toContain('project_doc_fallback_filenames');
    expect(createdInstructions).toContain('CLAUDE.md');
    expect(createdInstructions).toContain('.claude/CLAUDE.md');
    expect(createdInstructions).toContain('CLAUDE.local.md');
    expect(createdInstructions).toContain('.claude/rules/');
    expect(createdInstructions).toContain('.agents/skills/**/SKILL.md');
    expect(createdInstructions).toContain('.codex/skills/**/SKILL.md');
    expect(createdInstructions).toContain('.claude/skills/**/SKILL.md');

    expect(mocks.mcpServerCreate).toHaveBeenCalledTimes(3);
    expect(mocks.mcpServerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub-1',
        name: 'filesystem',
        command: 'npx',
        args: expect.arrayContaining(['@modelcontextprotocol/server-filesystem@2026.7.10']),
        isEnabled: true,
      }),
    );
    expect(mocks.mcpServerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub-1',
        name: 'playwright',
        command: 'npx',
        args: ['-y', '@playwright/mcp@0.0.78'],
        isEnabled: true,
      }),
    );
    expect(mocks.mcpServerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub-1',
        name: 'git',
        command: 'uvx',
        args: ['mcp-server-git==2026.7.10'],
        isEnabled: true,
      }),
    );
  });

  it('continues seeding later subscriptions after one subscription fails', async () => {
    const logger = makeLogger();
    mocks.subscriptionFindAll.mockResolvedValue([{ id: 'sub-fail' }, { id: 'sub-ok' }]);
    mocks.taskTemplateFindAll
      .mockRejectedValueOnce(new Error('database busy'))
      .mockResolvedValueOnce([]);
    mocks.mcpServerFindAll.mockResolvedValueOnce([]);

    await seedDefaultSelfHostedAgentAssets(logger);

    expect(logger.error).toHaveBeenCalledWith(
      'Default self-hosted agent asset seed failed for subscription; continuing',
      expect.objectContaining({ subscriptionId: 'sub-fail' }),
    );
    expect(mocks.taskTemplateCreate).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub-ok' }),
    );
    expect(mocks.mcpServerCreate).toHaveBeenCalledTimes(3);
  });
});

describe('seedDefaultSelfHostedAgentAssetsForSubscription', () => {
  it('does not overwrite existing templates or MCP server configs', async () => {
    const logger = makeLogger();
    mocks.taskTemplateFindAll.mockResolvedValue([
      {
        id: 'current-template',
        heading: ' coding agent ',
        updatedAt: new Date(DEFAULT_CODING_AGENT_INSTRUCTIONS_UPDATED_AT.getTime() + 1_000),
      },
    ]);
    mocks.mcpServerFindAll.mockResolvedValue([{ name: 'Filesystem' }, { name: 'GIT' }]);

    await seedDefaultSelfHostedAgentAssetsForSubscription('sub-2', logger);

    expect(mocks.taskTemplateCreate).not.toHaveBeenCalled();
    expect(mocks.taskTemplateUpdate).not.toHaveBeenCalled();
    expect(mocks.mcpServerCreate).toHaveBeenCalledTimes(1);
    expect(mocks.mcpServerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub-2',
        name: 'playwright',
      }),
    );
  });

  it('re-seeds coding-agent instructions whose last update predates this seed revision', async () => {
    const logger = makeLogger();
    const oldUpdatedAt = new Date(DEFAULT_CODING_AGENT_INSTRUCTIONS_UPDATED_AT.getTime() - 1_000);
    mocks.taskTemplateFindAll.mockResolvedValue([
      { id: 'old-template', heading: 'Coding Agent', updatedAt: oldUpdatedAt },
    ]);
    mocks.taskTemplateUpdate.mockResolvedValue([1]);
    mocks.mcpServerFindAll.mockResolvedValue([
      { name: 'filesystem' },
      { name: 'playwright' },
      { name: 'git' },
    ]);

    await seedDefaultSelfHostedAgentAssetsForSubscription('sub-old', logger);

    expect(mocks.taskTemplateCreate).not.toHaveBeenCalled();
    expect(mocks.taskTemplateUpdate).toHaveBeenCalledWith(
      { instructions: expect.stringMatching(/^gz1:/) },
      {
        where: {
          id: 'old-template',
          subscriptionId: 'sub-old',
          updatedAt: oldUpdatedAt,
        },
      },
    );
    const updatedInstructions = decompressString(
      mocks.taskTemplateUpdate.mock.calls[0][0].instructions,
    );
    expect(updatedInstructions).toContain('Repository instructions and skills');
    expect(logger.info).toHaveBeenCalledWith(
      'Seeded default self-hosted agent assets.',
      expect.objectContaining({ taskTemplateCreated: false, taskTemplateUpdated: true }),
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

  it('treats duplicate seeded assets from concurrent processes as already created', async () => {
    const logger = makeLogger();
    const duplicate = Object.assign(new Error('duplicate'), {
      name: 'SequelizeUniqueConstraintError',
    });
    mocks.taskTemplateFindAll.mockResolvedValue([]);
    mocks.taskTemplateCreate.mockRejectedValueOnce(duplicate);
    mocks.mcpServerFindAll.mockResolvedValue([]);
    mocks.mcpServerCreate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce({});

    await seedDefaultSelfHostedAgentAssetsForSubscription('sub-4', logger);

    expect(mocks.taskTemplateCreate).toHaveBeenCalledTimes(1);
    expect(mocks.mcpServerCreate).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      'Seeded default self-hosted agent assets.',
      expect.objectContaining({
        subscriptionId: 'sub-4',
        taskTemplateCreated: false,
        mcpServersCreated: ['filesystem', 'git'],
      }),
    );
  });
});
