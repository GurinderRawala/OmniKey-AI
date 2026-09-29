import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';

const mocks = vi.hoisted(() => ({
  findAll: vi.fn(),
  findOne: vi.fn(),
  update: vi.fn(),
  connect: vi.fn(),
  listTools: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../models/mcpServer', () => ({
  MCPServer: {
    findAll: mocks.findAll,
    findOne: mocks.findOne,
    update: mocks.update,
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mocks.connect;
    listTools = mocks.listTools;
    close = mocks.close;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}));

import {
  activateMcpServerForSubscription,
  CONNECT_MCP_TOOL_NAME,
  getMcpToolsForSubscription,
  shutdownAllMcpClients,
} from '../agent/mcpRuntime';

function logger(): Logger {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;
}

beforeEach(async () => {
  await shutdownAllMcpClients();
  vi.clearAllMocks();
  mocks.update.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue(undefined);
  mocks.listTools.mockResolvedValue({
    tools: [
      {
        name: 'send_message',
        description: 'Send a workspace message',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ],
  });
});

describe('on-demand MCP runtime', () => {
  it('advertises server names without connecting to any MCP server', async () => {
    mocks.findAll.mockResolvedValue([
      { id: 'slack-id', name: 'Slack', transport: 'http' },
      { id: 'github-id', name: 'GitHub', transport: 'http' },
    ]);

    const bundle = await getMcpToolsForSubscription('sub-1', logger());

    expect(bundle.aiTools).toHaveLength(1);
    expect(bundle.aiTools[0].name).toBe(CONNECT_MCP_TOOL_NAME);
    expect(bundle.aiTools[0].parameters).toMatchObject({
      properties: { name: { enum: ['Slack', 'GitHub'] } },
    });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.listTools).not.toHaveBeenCalled();
  });

  it('connects only the server selected by name and returns its tool definitions', async () => {
    mocks.findOne.mockResolvedValue({
      id: 'slack-id',
      name: 'Slack',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: {},
    });
    const dispatch = new Map([
      ['mcp_github__get_issue', { serverId: 'github-id', mcpToolName: 'get_issue' }],
    ]);

    const activated = await activateMcpServerForSubscription('sub-1', 'Slack', dispatch, logger());

    expect(mocks.findOne).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub-1', name: 'Slack', isEnabled: true },
    });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(activated.replaceExistingTools).toBe(true);
    expect(activated.aiTools.map((tool) => tool.name)).toEqual(['mcp_slack__send_message']);
    expect(dispatch.get('mcp_slack__send_message')).toEqual({
      serverId: 'slack-id',
      mcpToolName: 'send_message',
    });
    expect(dispatch.has('mcp_github__get_issue')).toBe(false);
  });
});
