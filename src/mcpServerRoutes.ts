import express from 'express';
import zod from 'zod';
import { authMiddleware } from './authMiddleware';
import { MCPServer } from './models/mcpServer';

const transportEnum = zod.enum(['stdio', 'http', 'sse']);

const baseSchema = zod.object({
  name: zod.string().min(1).max(100),
  description: zod.string().max(500).nullable().optional(),
  transport: transportEnum.optional(),
  command: zod.string().max(500).nullable().optional(),
  args: zod.array(zod.string()).optional(),
  env: zod.record(zod.string(), zod.string()).optional(),
  url: zod.string().max(1000).nullable().optional(),
  headers: zod.record(zod.string(), zod.string()).optional(),
  isEnabled: zod.boolean().optional(),
});

function validateTransportFields(
  transport: 'stdio' | 'http' | 'sse',
  command: string | null | undefined,
  url: string | null | undefined,
): string | null {
  if (transport === 'stdio') {
    if (!command || !command.trim()) return 'command is required when transport is "stdio".';
  } else {
    if (!url || !url.trim()) return `url is required when transport is "${transport}".`;
  }
  return null;
}

function formatServer(server: MCPServer) {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
    isEnabled: server.isEnabled,
    lastConnectedAt: server.lastConnectedAt,
    lastError: server.lastError,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

export function mcpServerRouter(): express.Router {
  const router = express.Router();

  router.get('/', authMiddleware, async (_req, res) => {
    const { logger, subscription } = res.locals;
    try {
      const servers = await MCPServer.findAll({
        where: { subscriptionId: subscription.id },
        order: [['name', 'ASC']],
      });
      res.json({ servers: servers.map(formatServer) });
    } catch (err) {
      logger.error('Error retrieving MCP servers.', { error: err });
      res.status(500).json({ error: 'Failed to retrieve MCP servers.' });
    }
  });

  router.post('/', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    try {
      const parsed = baseSchema.parse(req.body);
      const transport = parsed.transport ?? 'stdio';
      const command = parsed.command ?? null;
      const url = parsed.url ?? null;

      const validationError = validateTransportFields(transport, command, url);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      const server = await MCPServer.create({
        subscriptionId: subscription.id,
        name: parsed.name.trim(),
        description: parsed.description ?? null,
        transport,
        command,
        args: parsed.args ?? [],
        env: parsed.env ?? {},
        url,
        headers: parsed.headers ?? {},
        isEnabled: parsed.isEnabled ?? true,
      });

      res.status(201).json(formatServer(server));
    } catch (err: any) {
      logger.error('Error creating MCP server.', { error: err });
      if (err instanceof zod.ZodError) {
        return res.status(400).json({ error: 'Invalid MCP server data.' });
      }
      if (err?.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ error: 'An MCP server with that name already exists.' });
      }
      res.status(500).json({ error: 'Failed to create MCP server.' });
    }
  });

  router.get('/:id', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    const { id } = req.params;
    try {
      const server = await MCPServer.findOne({
        where: { id, subscriptionId: subscription.id },
      });
      if (!server) {
        return res.status(404).json({ error: 'MCP server not found.' });
      }
      res.json(formatServer(server));
    } catch (err) {
      logger.error('Error retrieving MCP server.', { error: err });
      res.status(500).json({ error: 'Failed to retrieve MCP server.' });
    }
  });

  router.patch('/:id', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    const { id } = req.params;
    try {
      const parsed = baseSchema.partial().parse(req.body);

      const server = await MCPServer.findOne({
        where: { id, subscriptionId: subscription.id },
      });
      if (!server) {
        return res.status(404).json({ error: 'MCP server not found.' });
      }

      const transport = parsed.transport ?? server.transport;
      const command = parsed.command !== undefined ? parsed.command : server.command;
      const url = parsed.url !== undefined ? parsed.url : server.url;

      const validationError = validateTransportFields(transport, command, url);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      await server.update({
        name: parsed.name !== undefined ? parsed.name.trim() : server.name,
        description: parsed.description !== undefined ? parsed.description : server.description,
        transport,
        command,
        args: parsed.args ?? server.args,
        env: parsed.env ?? server.env,
        url,
        headers: parsed.headers ?? server.headers,
        isEnabled: parsed.isEnabled ?? server.isEnabled,
      });

      res.json(formatServer(server));
    } catch (err: any) {
      logger.error('Error updating MCP server.', { error: err });
      if (err instanceof zod.ZodError) {
        return res.status(400).json({ error: 'Invalid MCP server data.' });
      }
      if (err?.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ error: 'An MCP server with that name already exists.' });
      }
      res.status(500).json({ error: 'Failed to update MCP server.' });
    }
  });

  router.delete('/:id', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    const { id } = req.params;
    try {
      const server = await MCPServer.findOne({
        where: { id, subscriptionId: subscription.id },
      });
      if (!server) {
        return res.status(404).json({ error: 'MCP server not found.' });
      }
      await server.destroy();
      res.status(204).send();
    } catch (err) {
      logger.error('Error deleting MCP server.', { error: err });
      res.status(500).json({ error: 'Failed to delete MCP server.' });
    }
  });

  return router;
}
