// MCP client runtime.
//
// Maintains long-lived connections to each user-configured MCP server and
// exposes their tools to the agent as `AITool` entries. The agent's tool
// dispatcher routes any tool call whose name starts with `MCP_TOOL_PREFIX`
// back here so it is forwarded to the originating MCP server.

import { Logger } from 'winston';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../config';
import { MCPServer } from '../models/mcpServer';
import { AITool } from '../ai-client';

export const MCP_TOOL_PREFIX = 'mcp_';
const MAX_TOOL_NAME_LEN = 64;
const CONNECT_TIMEOUT_MS = 15_000;

interface ConnectedClient {
  serverId: string;
  serverName: string;
  client: Client;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
}

interface DispatchEntry {
  serverId: string;
  mcpToolName: string;
}

export interface McpToolBundle {
  aiTools: AITool[];
  dispatch: Map<string, DispatchEntry>;
}

const clients = new Map<string, ConnectedClient>(); // by MCPServer.id

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
}

function buildToolName(serverName: string, toolName: string): string {
  const candidate = `${MCP_TOOL_PREFIX}${slug(serverName)}__${slug(toolName)}`;
  return candidate.slice(0, MAX_TOOL_NAME_LEN);
}

function isStdioAllowed(): boolean {
  // Spawning arbitrary child processes is only safe in single-tenant (self-hosted)
  // deployments. On a shared SaaS backend, stdio servers are disabled — only
  // outbound HTTP/SSE transports are permitted.
  return config.isSelfHosted === true || config.isLocal === true;
}

async function connectOne(server: MCPServer, log: Logger): Promise<ConnectedClient | null> {
  try {
    if (server.transport === 'stdio' && !isStdioAllowed()) {
      throw new Error('stdio MCP transport is disabled in this deployment.');
    }

    const client = new Client({ name: 'omnikey-agent', version: '1.0.0' }, { capabilities: {} });

    if (server.transport === 'stdio') {
      if (!server.command) throw new Error('command is required for stdio transport');
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        // Pass-through the user-provided env in addition to a safe default set.
        env: { ...process.env, ...(server.env ?? {}) } as Record<string, string>,
        stderr: 'pipe',
      });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'MCP stdio connect');
    } else if (server.transport === 'http') {
      if (!server.url) throw new Error('url is required for http transport');
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers ?? {} },
      });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'MCP http connect');
    } else {
      if (!server.url) throw new Error('url is required for sse transport');
      const transport = new SSEClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers ?? {} },
      });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'MCP sse connect');
    }

    const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'MCP listTools');
    const tools = (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    }));

    await MCPServer.update(
      { lastConnectedAt: new Date(), lastError: null },
      { where: { id: server.id } },
    ).catch(() => undefined);

    log.info('Connected to MCP server', {
      mcpServerId: server.id,
      mcpServerName: server.name,
      transport: server.transport,
      toolCount: tools.length,
    });

    return { serverId: server.id, serverName: server.name, client, tools };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Failed to connect to MCP server', {
      mcpServerId: server.id,
      mcpServerName: server.name,
      transport: server.transport,
      error: message,
    });
    await MCPServer.update({ lastError: message }, { where: { id: server.id } }).catch(
      () => undefined,
    );
    return null;
  }
}

async function getOrConnect(server: MCPServer, log: Logger): Promise<ConnectedClient | null> {
  const cached = clients.get(server.id);
  if (cached) return cached;
  const connected = await connectOne(server, log);
  if (connected) clients.set(server.id, connected);
  return connected;
}

/**
 * Builds the set of AI tool definitions exposed to the LLM for one subscription.
 * Returns both the tool definitions and a dispatch map used by `executeMcpTool`
 * to route a tool call back to the right (server, mcpToolName) pair.
 */
export async function getMcpToolsForSubscription(
  subscriptionId: string,
  log: Logger,
): Promise<McpToolBundle> {
  const aiTools: AITool[] = [];
  const dispatch = new Map<string, DispatchEntry>();

  let servers: MCPServer[];
  try {
    servers = await MCPServer.findAll({
      where: { subscriptionId, isEnabled: true },
    });
  } catch (err) {
    log.error('Failed to load MCP servers for runtime', { error: err });
    return { aiTools, dispatch };
  }

  // Connect / re-use clients in parallel.
  const connected = await Promise.all(servers.map((s) => getOrConnect(s, log)));

  for (const c of connected) {
    if (!c) continue;
    for (const tool of c.tools) {
      const toolName = buildToolName(c.serverName, tool.name);
      if (dispatch.has(toolName)) {
        log.warn('MCP tool name collision — skipping', {
          toolName,
          mcpServerName: c.serverName,
          mcpToolName: tool.name,
        });
        continue;
      }
      dispatch.set(toolName, { serverId: c.serverId, mcpToolName: tool.name });
      aiTools.push({
        name: toolName,
        description: tool.description
          ? `[${c.serverName}] ${tool.description}`
          : `[${c.serverName}] MCP tool ${tool.name}`,
        parameters: tool.inputSchema,
      });
    }
  }

  return { aiTools, dispatch };
}

/**
 * Executes a previously-advertised MCP tool. `dispatch` must be the same map
 * produced by `getMcpToolsForSubscription` for this turn (so we know which
 * server and underlying tool name to forward to).
 */
export async function executeMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  dispatch: Map<string, DispatchEntry>,
  log: Logger,
): Promise<string> {
  const entry = dispatch.get(toolName);
  if (!entry) {
    return `Error: unknown MCP tool "${toolName}".`;
  }
  const client = clients.get(entry.serverId);
  if (!client) {
    return `Error: MCP server for tool "${toolName}" is not connected.`;
  }

  try {
    const result = await withTimeout(
      client.client.callTool({ name: entry.mcpToolName, arguments: args }),
      60_000,
      `MCP callTool ${toolName}`,
    );
    return stringifyMcpToolResult(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('MCP tool call failed', {
      toolName,
      mcpServerId: entry.serverId,
      mcpToolName: entry.mcpToolName,
      error: message,
    });
    return `Error invoking MCP tool ${toolName}: ${message}`;
  }
}

/**
 * Disconnect (and forget) any cached client for the given MCP server id. Called
 * by the CRUD routes after an MCP server row is updated or deleted so the next
 * agent turn picks up the new config.
 */
export async function invalidateMcpRuntimeForServer(serverId: string): Promise<void> {
  const existing = clients.get(serverId);
  if (!existing) return;
  clients.delete(serverId);
  try {
    await existing.client.close();
  } catch {
    // ignore — the client may already be torn down.
  }
}

/**
 * Disconnect every cached client. Intended for graceful shutdown and tests.
 */
export async function shutdownAllMcpClients(): Promise<void> {
  const all = Array.from(clients.values());
  clients.clear();
  await Promise.all(
    all.map((c) =>
      c.client.close().catch(() => {
        // ignore
      }),
    ),
  );
}

function stringifyMcpToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '');
  const r = result as { content?: unknown; isError?: boolean };
  if (Array.isArray(r.content)) {
    const parts = r.content.map((item) => {
      if (item && typeof item === 'object' && 'type' in item) {
        const i = item as { type: string; text?: string; data?: string; mimeType?: string };
        if (i.type === 'text' && typeof i.text === 'string') return i.text;
        if (i.type === 'image') return `[image: ${i.mimeType ?? 'unknown'}]`;
        if (i.type === 'resource') return `[resource]`;
      }
      return JSON.stringify(item);
    });
    const joined = parts.join('\n');
    return r.isError ? `Error from MCP tool: ${joined}` : joined;
  }
  return JSON.stringify(result);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
