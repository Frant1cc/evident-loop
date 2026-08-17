import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpServer, listMcpServers, McpApiError } from './mcp';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('MCP list parses the safe public shape without expecting credential values', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 1,
    message: 'ok',
    data: {
      servers: [{
        id: 'server-1',
        name: 'Docs',
        transport: 'http',
        enabled: false,
        status: 'disabled',
        tools: [],
        hasCredentials: true,
        authMode: 'headers',
        headerNames: ['X-Api-Key']
      }]
    }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const result = await listMcpServers();
  assert.equal(result.servers[0]?.hasCredentials, true);
  assert.deepEqual(result.servers[0]?.headerNames, ['X-Api-Key']);
  assert.equal('headers' in (result.servers[0] ?? {}), false);
});

test('MCP API accepts credential input for transport but never exposes it in parsed server output', async () => {
  let requestBody = '';
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({
      code: 1,
      message: 'saved',
      data: {
        server: {
          id: 'server-2', name: 'Private', transport: 'http', enabled: false,
          status: 'disabled', tools: [], hasCredentials: true, authMode: 'headers', headerNames: ['X-Secret']
        }
      }
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await createMcpServer({
    name: 'Private', transport: 'http', url: 'https://example.test/mcp', authMode: 'headers',
    headers: { 'X-Secret': 'in-memory-only' }
  });
  assert.match(requestBody, /X-Secret/);
  assert.equal(result.server.hasCredentials, true);
  assert.equal('headers' in result.server, false);
});

test('MCP API turns error envelopes into a status-bearing error without echoing request data', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 0,
    message: 'MCP_CREDENTIALS_KEY is required to save MCP credentials',
    data: null
  }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  await assert.rejects(
    () => createMcpServer({ name: 'Private', transport: 'http', url: 'https://example.test/mcp', authMode: 'headers', headers: { Authorization: 'secret-value' } }),
    (error: unknown) => error instanceof McpApiError
      && error.status === 400
      && !error.message.includes('secret-value')
  );
});

