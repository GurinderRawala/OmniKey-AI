import { Logger } from 'winston';
import { MCPServer } from '../models/mcpServer';

// Lightweight per-subscription cache for the small projection of MCP server fields
// embedded in the agent system prompt. Avoids re-querying on every agent request.
//
// Invalidation: the cache is short-lived (TTL) and is also invalidated explicitly
// from the MCP CRUD routes whenever an MCP server is created, updated, or deleted.

export interface PromptMCP {
  name: string;
  description: string | null;
  transport: string;
}

interface CacheEntry {
  value: PromptMCP[];
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export function invalidatePromptMcps(subscriptionId: string): void {
  cache.delete(subscriptionId);
}

export async function getPromptMcpsForSubscription(
  subscriptionId: string,
  log?: Logger,
): Promise<PromptMCP[]> {
  const now = Date.now();
  const cached = cache.get(subscriptionId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const rows = await MCPServer.findAll({
      where: { subscriptionId, isEnabled: true },
      attributes: ['name', 'description', 'transport'],
      raw: true,
    });
    const value: PromptMCP[] = rows.map((r) => ({
      name: r.name,
      description: r.description ?? null,
      transport: r.transport,
    }));
    cache.set(subscriptionId, { value, expiresAt: now + TTL_MS });
    return value;
  } catch (err) {
    log?.error('Failed to load installed MCP servers for agent prompt', { error: err });
    return [];
  }
}
