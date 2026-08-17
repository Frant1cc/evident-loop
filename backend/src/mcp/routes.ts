import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';

import { failure, success } from '../response.js';
import type { McpManager, McpServerDraft } from './contracts.js';

export function createMcpRouter(manager: McpManager) {
  const router = Router();

  router.get('/servers', (_req, res) => {
    res.json(success({ servers: manager.listServers() }));
  });

  router.post('/servers', (req, res) => {
    try {
      const server = manager.saveServer(parseDraft(req.body) as McpServerDraft);
      res.status(201).json(success({ server }, 'MCP server draft saved'));
    } catch (error) {
      res.status(400).json(failure(errorMessage(error, 'Invalid MCP server configuration')));
    }
  });

  router.put('/servers/:id', (req, res) => {
    try {
      const server = manager.updateServer(req.params.id, parseDraft(req.body, true));
      res.json(success({ server }, 'MCP server updated'));
    } catch (error) {
      respondManagerError(res, error);
    }
  });

  router.post('/servers/:id/test', async (req, res) => {
    try {
      const server = await manager.testServer(req.params.id);
      const status = server.status === 'authorization_required' ? 202 : 200;
      res.status(status).json(success({ server }, 'MCP server test completed'));
    } catch (error) {
      respondManagerError(res, error, 502);
    }
  });

  router.post('/servers/:id/authorize', async (req, res) => {
    const code = req.body?.code ?? req.body?.authorizationCode;
    if (typeof code !== 'string' || !code) {
      res.status(400).json(failure('OAuth authorization code is required'));
      return;
    }
    try {
      const server = await manager.authorize(req.params.id, code, typeof req.body?.state === 'string' ? req.body.state : undefined);
      res.json(success({ server }, 'MCP server authorized'));
    } catch (error) {
      respondManagerError(res, error, 502);
    }
  });

  router.get('/oauth/callback', async (req, res) => {
    const state = readQuery(req.query.state);
    const serverId = readQuery(req.query.serverId ?? req.query.server ?? req.query.id)
      ?? (state ? manager.getServerIdForOAuthState?.(state) : undefined);
    const code = readQuery(req.query.code);
    if (!serverId || !code) {
      res.status(400).json(failure('OAuth callback requires serverId and code'));
      return;
    }
    try {
      const server = await manager.authorize(serverId, code, state);
      res.json(success({ server }, 'MCP OAuth authorization completed'));
    } catch (error) {
      respondManagerError(res, error, 400);
    }
  });

  router.patch('/servers/:id/enabled', async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json(failure('enabled must be a boolean'));
      return;
    }
    try {
      const server = await manager.setEnabled(req.params.id, req.body.enabled);
      res.json(success({ server }, req.body.enabled ? 'MCP server enabled' : 'MCP server disabled'));
    } catch (error) {
      respondManagerError(res, error, 409);
    }
  });

  router.post('/servers/:id/refresh', async (req, res) => {
    try {
      const server = await manager.refresh(req.params.id);
      res.json(success({ server }, 'MCP server refreshed'));
    } catch (error) {
      respondManagerError(res, error, 502);
    }
  });

  router.delete('/servers/:id', async (req, res) => {
    try {
      await manager.deleteServer(req.params.id);
      res.json(success({ id: req.params.id }, 'MCP server deleted'));
    } catch (error) {
      respondManagerError(res, error);
    }
  });

  return router;
}

/** Origin/Host checks shared by all local API routes at the composition root. */
export function mcpSecurityMiddleware(req: Request, res: Response, next: NextFunction) {
  const configuredOrigins = (process.env.APP_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origin = req.get('origin');
  const requestHost = req.get('host') ?? '';
  const requestProtocol = req.protocol === 'https' ? 'https' : 'http';
  const defaultOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...(requestHost ? [`${requestProtocol}://${requestHost}`] : [])
  ];
  const allowedOrigins = configuredOrigins.length ? configuredOrigins : defaultOrigins;
  if (origin && !allowedOrigins.includes(origin)) {
    res.status(403).json(failure('Origin is not allowed'));
    return;
  }

  const configuredHost = process.env.HOST?.trim() || '127.0.0.1';
  const rawHost = requestHost;
  const host = (rawHost.startsWith('[') ? rawHost.slice(1, rawHost.indexOf(']')) : rawHost.split(':')[0]).toLowerCase();
  const normalizedConfigured = configuredHost.replace(/^\[|\]$/g, '').toLowerCase();
  const accepted = !host || host === normalizedConfigured || isLoopback(configuredHost) && isLoopback(host);
  if (!accepted) {
    res.status(403).json(failure('Host is not allowed'));
    return;
  }
  next();
}

function parseDraft(body: unknown, partial = false): McpServerDraft | Partial<McpServerDraft> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Request body must be an object');
  const input = body as Record<string, unknown>;
  const transport = input.transport ?? input.kind ?? input.type;
  const authMode = input.authMode ?? input.auth_mode ?? 'none';
  if (!partial && (transport !== 'stdio' && transport !== 'http')) throw new Error('transport must be stdio or http');
  if (transport !== undefined && transport !== 'stdio' && transport !== 'http') throw new Error('transport must be stdio or http');
  if (authMode !== 'none' && authMode !== 'headers' && authMode !== 'oauth') throw new Error('authMode must be none, headers, or oauth');

  const headers = normalizeStringMap(input.headers);
  if (authMode === 'oauth' && headers && Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    throw new Error('Authorization header is reserved for OAuth');
  }
  const normalizedAuthMode = authMode === 'none' && headers && Object.keys(headers).length > 0 ? 'headers' : authMode;
  const oauth = input.oauth && typeof input.oauth === 'object' && !Array.isArray(input.oauth)
    ? normalizeOAuth(input.oauth as Record<string, unknown>)
    : input.oauth === undefined ? undefined : (() => { throw new Error('oauth must be an object'); })();

  const result: Record<string, unknown> = {};
  if (input.id !== undefined) result.id = String(input.id);
  if (input.name !== undefined || !partial) {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('name is required');
    result.name = input.name.trim();
  }
  if (transport !== undefined) result.transport = transport;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    result.enabled = input.enabled;
  }
  for (const field of ['command', 'cwd', 'url'] as const) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== 'string') throw new Error(`${field} must be a string`);
      result[field] = input[field];
    }
  }
  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || input.args.some((value) => typeof value !== 'string')) throw new Error('args must be string[]');
    result.args = input.args;
  }
  if (input.env !== undefined) result.env = normalizeStringMap(input.env);
  if (headers !== undefined) result.headers = headers;
  if (oauth !== undefined) result.oauth = oauth;
  if (input.authMode !== undefined || input.auth_mode !== undefined || !partial) result.authMode = normalizedAuthMode;
  return result as McpServerDraft;
}

function normalizeOAuth(input: Record<string, unknown>) {
  const output: Record<string, string> = {};
  for (const field of ['clientId', 'clientSecret', 'scope', 'redirectUri'] as const) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== 'string') throw new Error(`oauth.${field} must be a string`);
      output[field] = input[field];
    }
  }
  return output;
}

function normalizeStringMap(input: unknown): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('headers/env must be an object');
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') throw new Error(`credential ${key} must be a string`);
    output[key] = value;
  }
  return output;
}

function respondManagerError(res: Response, error: unknown, fallbackStatus = 400) {
  const message = errorMessage(error, 'MCP operation failed');
  const status = message.startsWith('Unknown MCP server') ? 404 : fallbackStatus;
  res.status(status).json(failure(message));
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function readQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function isLoopback(host: string) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}
