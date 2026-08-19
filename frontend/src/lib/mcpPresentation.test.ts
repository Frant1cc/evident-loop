import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getMcpOAuthPollMessage,
  getMcpOAuthPollState,
  getMcpSaveNotice,
  mcpRequiresRetest
} from './mcpPresentation';
import type { McpServer } from '../types/mcp';

const server = (overrides: Partial<McpServer> = {}): McpServer => ({
  id: 'server-1',
  name: 'Research tools',
  transport: 'http',
  enabled: false,
  status: 'disabled',
  lastRefreshedAt: '2026-08-17T00:00:00.000Z',
  tools: [],
  hasCredentials: true,
  url: 'https://example.test/mcp',
  authMode: 'oauth',
  ...overrides
});

test('OAuth disabled drafts with a validation timestamp are a successful terminal state', () => {
  assert.equal(getMcpOAuthPollState(server()), 'verified');
  assert.equal(getMcpOAuthPollMessage('verified'), 'OAuth 授权完成，已验证，可以启用。');
  assert.equal(getMcpOAuthPollState(server({ status: 'connected' })), 'connected');
  assert.equal(getMcpOAuthPollState(server({ status: 'error', lastRefreshedAt: undefined })), 'failed');
  assert.equal(getMcpOAuthPollState(server({ status: 'credential_unavailable', lastRefreshedAt: undefined })), 'failed');
  assert.equal(getMcpOAuthPollState(server({ status: 'authorization_required', lastRefreshedAt: undefined })), 'pending');
});

test('configuration edits require a new test while a name-only edit keeps validation', () => {
  const before = server();
  assert.equal(mcpRequiresRetest(before, server({ name: 'Renamed' })), false);
  assert.equal(getMcpSaveNotice(before, server({ name: 'Renamed' })), 'renamed');
  assert.equal(mcpRequiresRetest(before, server({ url: 'https://other.test/mcp', lastRefreshedAt: undefined })), true);
  assert.equal(getMcpSaveNotice(before, server({ url: 'https://other.test/mcp', lastRefreshedAt: undefined })), 'changed');
  // A credential replacement keeps public fields identical, so the cleared
  // validation timestamp is the signal that it needs another test.
  assert.equal(mcpRequiresRetest(before, server({ lastRefreshedAt: undefined })), true);
  assert.equal(getMcpSaveNotice(undefined, server({ id: 'new' })), 'created');
});
