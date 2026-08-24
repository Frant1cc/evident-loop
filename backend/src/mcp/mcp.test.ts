import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createApp } from '../app.js';
import { createToolRuntime } from '../tools/runtime.js';
import { ToolExecutionError, type ToolCatalog } from '../tools/contracts.js';
import { toolCatalog } from '../tools/registry.js';
import { createCredentialCipher, generateCredentialKey } from './crypto.js';
import { mcpToolDefinitionHash } from './definitionHash.js';
import type {
  McpAdapterCallbacks,
  McpAdapterFactory,
  McpAuthorizationRequired,
  McpConnection,
  McpOAuthConfig,
  McpManager,
  McpServerConfig,
  McpToolDescriptor
} from './contracts.js';
import { createMcpManager, stableToolName } from './manager.js';
import { createMcpStore } from './store.js';
import { createSdkAdapterFactory } from './adapters/sdk.js';

type FakeAdapterState = {
  tools: McpToolDescriptor[];
  listCalls: number;
  callCalls: number;
  concurrentLists: number;
  maxConcurrentLists: number;
  listError?: Error;
  listDelayMs: number;
  callbacks?: McpAdapterCallbacks;
  connection?: McpConnection;
  authPending: boolean;
  authorized: boolean;
  authorizationUrl: string;
  closeCalls: number;
};

const objectSchema = (required: string[] = ['query']) => ({
  type: 'object',
  properties: { query: { type: 'string' } },
  required,
  additionalProperties: false
});

function descriptor(name: string, inputSchema: Record<string, unknown> = objectSchema()): McpToolDescriptor {
  return {
    name,
    description: `Description for ${name}`,
    inputSchema,
    annotations: { readOnlyHint: true }
  };
}

function createFakeAdapter(state: FakeAdapterState): McpAdapterFactory {
  return async (_config, callbacks) => {
    state.callbacks = callbacks;
    const connection: McpConnection = {
      listTools: async () => {
        state.listCalls += 1;
        state.concurrentLists += 1;
        state.maxConcurrentLists = Math.max(state.maxConcurrentLists, state.concurrentLists);
        try {
          if (state.listDelayMs) await delay(state.listDelayMs);
          if (state.listError) throw state.listError;
          return { tools: state.tools.map((tool) => ({ ...tool })) };
        } finally {
          state.concurrentLists -= 1;
        }
      },
      callTool: async (_name, _args) => {
        state.callCalls += 1;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      close: async () => { state.closeCalls += 1; },
      authorizationUrl: () => state.authorizationUrl,
      finishAuth: state.authPending
        ? async (code, receivedState) => {
          assert.equal(code, 'test-code');
          assert.equal(receivedState, 'oauth-state');
          state.authPending = false;
          state.authorized = true;
        }
        : undefined
    };
    state.connection = connection;
    if (state.authPending) {
      const error = new Error('authorization required') as McpAuthorizationRequired;
      error.code = 'authorization_required';
      error.authorizationUrl = state.authorizationUrl;
      error.state = 'oauth-state';
      error.connection = connection;
      throw error;
    }
    return connection;
  };
}

function createFixture(options: {
  state?: Partial<FakeAdapterState>;
  host?: string;
  cipher?: ReturnType<typeof createCredentialCipher>;
  listChangedDebounceMs?: number;
  npxMajorVersion?: number;
} = {}) {
  const database = new Database(':memory:');
  const state: FakeAdapterState = {
    tools: [descriptor('search')],
    listCalls: 0,
    callCalls: 0,
    concurrentLists: 0,
    maxConcurrentLists: 0,
    listDelayMs: 0,
    authPending: false,
    authorized: false,
    authorizationUrl: 'http://127.0.0.1:3000/authorize?state=oauth-state',
    closeCalls: 0,
    ...options.state
  };
  const runtime = createToolRuntime(new Map() as ToolCatalog);
  const store = createMcpStore(database, options.cipher);
  const manager = createMcpManager({
    runtime,
    store,
    adapterFactory: createFakeAdapter(state),
    host: options.host ?? '127.0.0.1',
    listChangedDebounceMs: options.listChangedDebounceMs ?? 10,
    npxMajorVersion: options.npxMajorVersion ?? 10,
    reconnectBaseMs: 5
  });
  return { database, state, runtime, store, manager };
}

function saveDraft(manager: McpManager, overrides: Partial<McpServerConfig> = {}) {
  return manager.saveServer({
    name: 'Fixture MCP',
    transport: 'http',
    url: 'http://127.0.0.1:8765/mcp',
    authMode: 'none',
    enabled: false,
    ...overrides
  });
}

async function connectFixture(manager: McpManager, id: string) {
  await manager.testServer(id);
  await manager.setEnabled(id, true);
  await waitFor(() => manager.getServer(id)?.status === 'connected');
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for MCP fixture');
    await delay(5);
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test('managed preset enables a pinned package and remains idempotent', async () => {
  const fixture = createFixture();

  const enabled = await fixture.manager.enablePreset('context7', 1);
  assert.equal(enabled.status, 'connected');
  assert.equal(enabled.enabled, true);
  const persisted = fixture.store.getServer(enabled.id)!;
  assert.equal(persisted.command, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  assert.deepEqual(persisted.args, ['--yes', '@upstash/context7-mcp@4.0.3']);
  const metadata = fixture.store.getManagedMetadata(enabled.id)!;
  assert.equal(metadata.presetId, 'context7');
  assert.equal(metadata.presetVersion, 2);
  assert.equal(metadata.consentVersion, 1);
  assert.ok(metadata.consentedAt);

  const listCalls = fixture.state.listCalls;
  const repeated = await fixture.manager.enablePreset('context7', 1);
  assert.equal(repeated.id, enabled.id);
  assert.equal(fixture.state.listCalls, listCalls);
  assert.equal(fixture.manager.listServers().length, 1);

  await fixture.manager.stop();
  fixture.database.close();
});

test('managed preset upgrades stale persisted commands before testing', async () => {
  const fixture = createFixture();
  const stale = fixture.manager.saveServer({
    name: 'Context7 文档',
    transport: 'stdio',
    command: 'npx',
    args: ['--yes', '@upstash/context7-mcp@0.1.5'],
    authMode: 'none',
    enabled: false
  });
  fixture.store.saveManagedMetadata(stale.id, {
    presetId: 'context7',
    presetVersion: 1,
    consentVersion: 1,
    consentedAt: '2026-08-24T00:00:00.000Z'
  });

  const enabled = await fixture.manager.enablePreset('context7', 1);
  assert.equal(enabled.id, stale.id);
  assert.equal(enabled.status, 'connected');
  assert.deepEqual(fixture.store.getServer(stale.id)?.args, ['--yes', '@upstash/context7-mcp@4.0.3']);
  assert.deepEqual(fixture.store.getManagedMetadata(stale.id), {
    presetId: 'context7',
    presetVersion: 2,
    consentVersion: 1,
    consentedAt: '2026-08-24T00:00:00.000Z'
  });
  assert.equal(fixture.manager.listServers().length, 1);

  await fixture.manager.stop();
  fixture.database.close();
});

test('managed preset rejects a consent version that is not current', async () => {
  const fixture = createFixture();
  await assert.rejects(fixture.manager.enablePreset('context7', 2), /does not match/);
  assert.equal(fixture.manager.listServers().length, 0);
  await fixture.manager.stop();
  fixture.database.close();
});

test('credential cipher round-trips, detects tampering, and treats missing keys as unavailable', () => {
  const cipher = createCredentialCipher(generateCredentialKey());
  const encrypted = cipher.encrypt('secret-value');
  assert.ok(encrypted);
  assert.notEqual(encrypted, 'secret-value');
  assert.equal(cipher.decrypt(encrypted), 'secret-value');
  assert.equal(cipher.decrypt(`${encrypted}tampered`), undefined);
  assert.equal(createCredentialCipher('').available, false);
  assert.equal(createCredentialCipher('').encrypt('secret-value'), undefined);
  assert.equal(createCredentialCipher('').decrypt(encrypted), undefined);
});

test('stable MCP names are bounded and collision resistant', () => {
  const longName = `${'x'.repeat(300)}/remote tool`;
  const first = stableToolName('12345678-server-a', longName);
  const secondServer = stableToolName('12345678-server-b', longName);
  const differentRemote = stableToolName('12345678-server-a', longName.replace('/', ' '));
  assert.ok(first.length <= 64);
  assert.notEqual(first, secondServer);
  assert.notEqual(first, differentRemote);
  assert.equal(first, stableToolName('12345678-server-a', longName));
});

test('encrypted store does not persist or expose plaintext credentials', async () => {
  const key = generateCredentialKey();
  const fixture = createFixture({ cipher: createCredentialCipher(key) });
  const server = saveDraft(fixture.manager, {
    authMode: 'headers',
    headers: { Authorization: 'Bearer static-secret' },
    env: { MCP_SECRET: 'stdio-secret' },
    oauth: { clientId: 'client-id', clientSecret: 'client-secret' }
  });
  const raw = fixture.database.prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(server.id) as { config_json: string };
  assert.ok(!raw.config_json.includes('static-secret'));
  assert.ok(!raw.config_json.includes('stdio-secret'));
  assert.ok(!raw.config_json.includes('client-secret'));
  const publicServer = fixture.manager.getServer(server.id)!;
  assert.equal(JSON.stringify(publicServer).includes('static-secret'), false);
  assert.equal(JSON.stringify(publicServer).includes('client-secret'), false);
  await fixture.manager.stop();
});

test('missing credential key reports a safe state and refuses new secrets without changing ciphertext', async () => {
  const database = new Database(':memory:');
  const key = generateCredentialKey();
  const withKey = createMcpStore(database, createCredentialCipher(key));
  const saved = withKey.saveServer({
    name: 'Encrypted',
    transport: 'http',
    url: 'http://127.0.0.1:8765/mcp',
    authMode: 'headers',
    enabled: false,
    headers: { Authorization: 'Bearer original' }
  });
  const before = database.prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(saved.id) as { config_json: string };
  const withoutKey = createMcpStore(database, createCredentialCipher(''));
  assert.throws(() => withoutKey.saveServer({
    id: saved.id,
    name: 'Changed',
    transport: 'http',
    url: 'http://127.0.0.1:8765/mcp',
    authMode: 'headers',
    enabled: false,
    headers: { Authorization: 'Bearer replacement' }
  }), /MCP_CREDENTIALS_KEY/);
  const after = database.prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(saved.id) as { config_json: string };
  assert.equal(after.config_json, before.config_json);
  const safeStore = createMcpStore(database, createCredentialCipher(''));
  const config = safeStore.getServer(saved.id)!;
  assert.equal(config.credentialUnavailable, true);
  assert.equal(config.headers, undefined);
  database.close();
});

test('manager edits preserve LKG while invalidating connection changes and merging OAuth state', async () => {
  const fixture = createFixture({ cipher: createCredentialCipher(generateCredentialKey()) });
  const server = saveDraft(fixture.manager, {
    authMode: 'headers',
    headers: { 'X-Static': 'keep-me' }
  });
  await connectFixture(fixture.manager, server.id);
  const beforeRefresh = fixture.manager.getServer(server.id)!.lastRefreshedAt;
  const beforeCloses = fixture.state.closeCalls;

  const renamed = fixture.manager.updateServer(server.id, { name: 'Renamed MCP' });
  assert.equal(renamed.name, 'Renamed MCP');
  assert.equal(renamed.enabled, true);
  assert.equal(renamed.status, 'connected');
  assert.equal(renamed.lastRefreshedAt, beforeRefresh);
  assert.equal(fixture.state.closeCalls, beforeCloses);

  const edited = fixture.manager.updateServer(server.id, { url: 'http://127.0.0.1:8766/mcp' });
  assert.equal(edited.enabled, false);
  assert.equal(edited.status, 'disabled');
  assert.equal(edited.lastRefreshedAt, undefined);
  assert.equal(edited.tools.length, 1);
  await waitFor(() => fixture.state.closeCalls > beforeCloses);
  await assert.rejects(fixture.manager.setEnabled(server.id, true), /must pass test/);

  const oauth = fixture.manager.updateServer(server.id, {
    authMode: 'oauth',
    oauth: {
      clientId: 'registered-client',
      clientSecret: 'registered-secret',
      tokens: { access_token: 'access', refresh_token: 'refresh' },
      clientInformation: { client_id: 'registered-client', token_endpoint_auth_method: 'none' },
      state: 'oauth-state',
      codeVerifier: 'pkce-verifier',
      discoveryState: { authorizationServerUrl: 'http://auth.example.test' }
    },
    headers: { 'X-Trace': 'keep-custom', Authorization: 'Bearer ignored' }
  });
  assert.equal(oauth.authMode, 'oauth');
  const oauthConfig = fixture.store.getServer(server.id)!;
  assert.equal(oauthConfig.headers?.['X-Trace'], 'keep-custom');
  assert.equal(oauthConfig.headers?.Authorization, undefined);
  assert.equal(oauthConfig.oauth?.tokens?.access_token, 'access');

  fixture.manager.updateServer(server.id, {
    authMode: 'oauth',
    oauth: {
      tokens: { expires_in: 3600 },
      discoveryState: { resource: 'http://127.0.0.1:8766/mcp' }
    }
  });
  const mergedOauth = fixture.store.getServer(server.id)!.oauth!;
  assert.equal(mergedOauth.tokens?.access_token, 'access');
  assert.equal(mergedOauth.tokens?.expires_in, 3600);
  assert.equal(mergedOauth.discoveryState?.authorizationServerUrl, 'http://auth.example.test');
  assert.equal(mergedOauth.discoveryState?.resource, 'http://127.0.0.1:8766/mcp');
  assert.equal(mergedOauth.codeVerifier, 'pkce-verifier');

  fixture.manager.updateServer(server.id, {
    authMode: 'headers',
    headers: { Authorization: 'Bearer static', 'X-Other': 'present' }
  });
  const headersConfig = fixture.store.getServer(server.id)!;
  assert.equal(headersConfig.oauth, undefined);
  assert.equal(headersConfig.headers?.Authorization, 'Bearer static');
  fixture.manager.updateServer(server.id, { authMode: 'none' });
  const noneConfig = fixture.store.getServer(server.id)!;
  assert.equal(noneConfig.authMode, 'none');
  assert.equal(noneConfig.headers, undefined);

  fixture.manager.updateServer(server.id, {
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: { MCP_FIXTURE: 'yes' }
  });
  const stdioConfig = fixture.store.getServer(server.id)!;
  assert.equal(stdioConfig.transport, 'stdio');
  assert.equal(stdioConfig.url, undefined);
  assert.equal(stdioConfig.headers, undefined);
  assert.equal(stdioConfig.oauth, undefined);
  assert.equal(stdioConfig.env?.MCP_FIXTURE, 'yes');

  fixture.manager.updateServer(server.id, {
    transport: 'http',
    url: 'http://127.0.0.1:8767/mcp',
    authMode: 'none'
  });
  const httpConfig = fixture.store.getServer(server.id)!;
  assert.equal(httpConfig.command, undefined);
  assert.equal(httpConfig.args, undefined);
  assert.equal(httpConfig.cwd, undefined);
  assert.equal(httpConfig.env, undefined);
  assert.equal(httpConfig.authMode, 'none');
  await assert.rejects(fixture.manager.setEnabled(server.id, true), /must pass test/);
  await fixture.manager.stop();
  fixture.database.close();
});

test('missing-key manager edits can explicitly clear old OAuth ciphertext without accepting new secrets', () => {
  const database = new Database(':memory:');
  const key = generateCredentialKey();
  const withKey = createMcpStore(database, createCredentialCipher(key));
  const saved = withKey.saveServer({
    id: 'missing-key-oauth',
    name: 'Missing key OAuth',
    transport: 'http',
    url: 'http://127.0.0.1:8777/mcp',
    authMode: 'oauth',
    enabled: false,
    oauth: { clientId: 'registered', clientSecret: 'secret-to-clear' }
  });
  const before = database.prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(saved.id) as { config_json: string };
  assert.ok(before.config_json.includes('oauthValues'));
  const withoutKey = createMcpStore(database, createCredentialCipher(''));
  const runtime = createToolRuntime(new Map() as ToolCatalog);
  const manager = createMcpManager({
    runtime,
    store: withoutKey,
    adapterFactory: createFakeAdapter({
      tools: [], listCalls: 0, callCalls: 0, concurrentLists: 0, maxConcurrentLists: 0,
      listDelayMs: 0, authPending: false, authorized: false,
      authorizationUrl: 'http://127.0.0.1:3000/authorize', closeCalls: 0
    })
  });
  assert.equal(manager.getServer(saved.id)?.status, 'credential_unavailable');
  manager.updateServer(saved.id, { authMode: 'none' });
  const cleared = withoutKey.getServer(saved.id)!;
  assert.equal(cleared.authMode, 'none');
  assert.equal(cleared.oauth, undefined);
  assert.equal(cleared.credentialUnavailable, undefined);
  const after = database.prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(saved.id) as { config_json: string };
  assert.equal(after.config_json.includes('secret-to-clear'), false);
  database.close();
});

test('stale refresh generations cannot overwrite an edited server LKG', async () => {
  const fixture = createFixture({ listChangedDebounceMs: 1, state: { listDelayMs: 45 } });
  const server = saveDraft(fixture.manager);
  await connectFixture(fixture.manager, server.id);
  const originalName = fixture.manager.getServer(server.id)!.tools[0].modelName;
  fixture.state.tools = [descriptor('search'), descriptor('late-tool')];
  fixture.state.callbacks?.onToolsChanged?.();
  await delay(8);
  fixture.manager.updateServer(server.id, { url: 'http://127.0.0.1:8799/mcp' });
  await delay(80);
  const tools = fixture.manager.getServer(server.id)!.tools;
  assert.equal(tools.some((tool) => tool.remoteName === 'late-tool'), false);
  assert.equal(tools[0]?.modelName, originalName);
  await fixture.manager.stop();
  fixture.database.close();
});

test('MCP store migrates definition hashes and keeps creation/tool order across restart', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'disabled',
      last_error TEXT, last_refreshed_at TEXT, authorization_url TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE mcp_tools (
      server_id TEXT NOT NULL, remote_name TEXT NOT NULL, model_name TEXT NOT NULL,
      ordinal INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '',
      input_schema_json TEXT NOT NULL, annotations_json TEXT,
      tombstone INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT,
      PRIMARY KEY (server_id, remote_name)
    );
  `);
  const cipher = createCredentialCipher(generateCredentialKey());
  const store = createMcpStore(database, cipher);
  const columns = database.prepare('PRAGMA table_info(mcp_tools)').all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === 'definition_hash'));
  const serverZ = store.saveServer({ id: 'server-z', name: 'First', transport: 'http', url: 'http://z', authMode: 'none', enabled: false });
  const serverA = store.saveServer({ id: 'server-a', name: 'Second', transport: 'http', url: 'http://a', authMode: 'none', enabled: false });
  database.prepare('UPDATE mcp_servers SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', serverZ.id);
  database.prepare('UPDATE mcp_servers SET created_at = ? WHERE id = ?').run('2020-01-02T00:00:00.000Z', serverA.id);
  const schema = objectSchema();
  store.upsertTool({ serverId: serverA.id, remoteName: 'a-tool', modelName: 'mcp__a__a-tool__hash', ordinal: 1, description: 'A', inputSchema: schema, annotations: { readOnlyHint: true }, tombstone: false });
  store.upsertTool({ serverId: serverZ.id, remoteName: 'z-tool', modelName: 'mcp__z__z-tool__hash', ordinal: 1, description: 'Z', inputSchema: schema, annotations: { readOnlyHint: true }, tombstone: false });
  const firstOrder = store.listTools().map((tool) => tool.remoteName);
  assert.deepEqual(firstOrder, ['z-tool', 'a-tool']);
  const firstHash = store.listTools(serverZ.id)[0].definitionHash;
  assert.equal(firstHash, mcpToolDefinitionHash('mcp__z__z-tool__hash', 'Z', schema));
  const rawHash = database.prepare('SELECT definition_hash FROM mcp_tools WHERE server_id = ?').get(serverZ.id) as { definition_hash: string };
  assert.equal(rawHash.definition_hash, firstHash);
  store.upsertTool({ serverId: serverZ.id, remoteName: 'z-tool', modelName: 'mcp__z__z-tool__hash', ordinal: 1, description: 'Z', inputSchema: schema, annotations: { readOnlyHint: false }, tombstone: false });
  assert.equal(store.listTools(serverZ.id)[0].definitionHash, firstHash);
  store.upsertTool({ serverId: serverZ.id, remoteName: 'z-tool', modelName: 'mcp__z__z-tool__hash', ordinal: 1, description: 'Z changed', inputSchema: schema, tombstone: false });
  assert.notEqual(store.listTools(serverZ.id)[0].definitionHash, firstHash);
  const restartedStore = createMcpStore(database, cipher);
  assert.deepEqual(restartedStore.listTools().map((tool) => tool.remoteName), firstOrder);
  database.close();
});

test('manager preserves persisted schemas before start and refreshes add/change/tombstone/recover/delete', async () => {
  const fixture = createFixture();
  const server = saveDraft(fixture.manager);
  await fixture.manager.testServer(server.id);
  const first = fixture.manager.getServer(server.id)!.tools[0];
  assert.equal(first.remoteName, 'search');
  await fixture.manager.stop();

  const runtimeAfterRestart = createToolRuntime(new Map() as ToolCatalog);
  const restarted = createMcpManager({
    runtime: runtimeAfterRestart,
    store: fixture.store,
    adapterFactory: createFakeAdapter(fixture.state),
    host: '127.0.0.1'
  });
  assert.ok(runtimeAfterRestart.listModules().some((module) => module.definition.function.name === first.modelName));
  fixture.state.tools = [descriptor('search', objectSchema(['query'])), descriptor('new_tool')];
  await restarted.testServer(server.id);
  await restarted.setEnabled(server.id, true);
  await waitFor(() => restarted.getServer(server.id)?.status === 'connected');
  let publicServer = restarted.getServer(server.id)!;
  const newTool = publicServer.tools.find((tool) => tool.remoteName === 'new_tool')!;
  assert.equal(newTool.ordinal, 2);
  fixture.state.tools = [descriptor('search', { type: 'object', properties: { query: { type: 'number' } } })];
  await restarted.refresh(server.id);
  publicServer = restarted.getServer(server.id)!;
  assert.equal(publicServer.tools.find((tool) => tool.remoteName === 'new_tool')?.tombstone, true);
  assert.deepEqual(publicServer.tools.find((tool) => tool.remoteName === 'new_tool')?.inputSchema, objectSchema());
  assert.deepEqual(publicServer.tools.find((tool) => tool.remoteName === 'search')?.inputSchema, {
    type: 'object',
    properties: { query: { type: 'number' } }
  });
  fixture.state.tools = [descriptor('search'), descriptor('new_tool')];
  await restarted.refresh(server.id);
  publicServer = restarted.getServer(server.id)!;
  assert.equal(publicServer.tools.find((tool) => tool.remoteName === 'new_tool')?.tombstone, false);
  assert.equal(publicServer.tools.find((tool) => tool.remoteName === 'new_tool')?.ordinal, newTool.ordinal);
  await restarted.deleteServer(server.id);
  assert.equal(restarted.getServer(server.id), undefined);
  assert.equal(runtimeAfterRestart.listModules().length, 0);
  await restarted.stop();
  fixture.database.close();
});

test('invalid remote schemas preserve LKG and Ajv rejects invalid arguments before a remote call', async () => {
  const fixture = createFixture();
  const server = saveDraft(fixture.manager);
  await fixture.manager.testServer(server.id);
  await fixture.manager.setEnabled(server.id, true);
  await waitFor(() => fixture.manager.getServer(server.id)?.status === 'connected');
  const beforeSnapshot = fixture.state.listCalls;
  const snapshot = fixture.runtime.getSnapshot({ mode: 'all' });
  assert.equal(fixture.state.listCalls, beforeSnapshot);
  const modelName = fixture.manager.getServer(server.id)!.tools[0].modelName;
  await assert.rejects(
    fixture.runtime.execute(snapshot, { name: modelName, arguments: {} }),
    (error: unknown) => error instanceof ToolExecutionError
      && error.code === 'invalid_arguments'
      && Boolean(error.reason)
  );
  assert.equal(fixture.state.callCalls, 0);
  const valid = await fixture.runtime.execute(snapshot, { name: modelName, arguments: { query: 'hello' } });
  assert.deepEqual(valid, { text: 'ok' });
  fixture.state.tools = [descriptor('search', { type: 'not-json-schema' })];
  await fixture.manager.refresh(server.id);
  const preserved = fixture.manager.getServer(server.id)!.tools.find((tool) => tool.remoteName === 'search')!;
  assert.deepEqual(preserved.inputSchema, objectSchema());
  const availability = fixture.runtime.listModules()[0].availability;
  assert.equal(typeof availability, 'function');
  assert.deepEqual((availability as () => { status: string })(), { status: 'available' });
  await fixture.manager.stop();
  fixture.database.close();
});

test('disabled and offline MCP modules remain exposed but unavailable', async () => {
  const fixture = createFixture();
  const server = saveDraft(fixture.manager);
  await fixture.manager.testServer(server.id);
  const module = fixture.runtime.listModules()[0];
  assert.equal(typeof module.availability, 'function');
  assert.deepEqual((module.availability as () => { status: string; reason?: string; retryable?: boolean })(), {
    status: 'unavailable',
    reason: 'MCP server is disabled',
    retryable: false
  });
  await fixture.manager.setEnabled(server.id, true);
  await waitFor(() => fixture.manager.getServer(server.id)?.status === 'connected');
  fixture.state.listError = new Error('fixture offline');
  await assert.rejects(fixture.manager.refresh(server.id), /fixture offline/);
  assert.equal(fixture.manager.getServer(server.id)?.status, 'unavailable');
  assert.equal(fixture.runtime.listModules()[0].definition.function.name, module.definition.function.name);
  await fixture.manager.stop();
  fixture.database.close();
});

test('notifications are debounced and refreshes are single-flight', async () => {
  const fixture = createFixture({ listChangedDebounceMs: 15, state: { listDelayMs: 30 } });
  const server = saveDraft(fixture.manager);
  await fixture.manager.testServer(server.id);
  await fixture.manager.setEnabled(server.id, true);
  await waitFor(() => fixture.manager.getServer(server.id)?.status === 'connected');
  const baseline = fixture.state.listCalls;
  fixture.state.callbacks?.onToolsChanged?.();
  fixture.state.callbacks?.onToolsChanged?.();
  fixture.state.callbacks?.onToolsChanged?.();
  await delay(100);
  assert.equal(fixture.state.listCalls, baseline + 1);
  assert.equal(fixture.state.maxConcurrentLists, 1);
  await fixture.manager.stop();
  fixture.database.close();
});

test('OAuth authorization state can recover a fake pending connection without exposing credentials', async () => {
  const fixture = createFixture({ state: { authPending: true } });
  const server = saveDraft(fixture.manager, { authMode: 'oauth', oauth: {} });
  const pending = await fixture.manager.testServer(server.id);
  assert.equal(pending.status, 'authorization_required');
  assert.equal(pending.authorizationUrl, fixture.state.authorizationUrl);
  await assert.rejects(fixture.manager.authorize(server.id, 'test-code', 'wrong-state'));
  assert.equal(fixture.manager.getServer(server.id)?.status, 'authorization_required');
  const authorized = await fixture.manager.authorize(server.id, 'test-code', 'oauth-state');
  assert.equal(authorized.status, 'disabled');
  assert.equal(authorized.tools.length, 1);
  assert.equal(JSON.stringify(authorized).includes('test-code'), false);
  await fixture.manager.stop();
  fixture.database.close();
});

test('non-loopback hosts refuse stdio test and enable while retaining LKG', async () => {
  const fixture = createFixture({ host: '0.0.0.0' });
  const server = saveDraft(fixture.manager, {
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', '']
  });
  await assert.rejects(fixture.manager.testServer(server.id), /loopback/);
  assert.equal(fixture.manager.getServer(server.id)?.status, 'unavailable');
  await fixture.manager.stop();
  fixture.database.close();
});

test('MCP routes permit static Authorization, reject OAuth Authorization, and apply default origin policy', async () => {
  const previousOrigins = process.env.APP_ORIGINS;
  const previousHost = process.env.HOST;
  process.env.APP_ORIGINS = '';
  process.env.HOST = '127.0.0.1';
  let savedDraft: unknown;
  const server = {
    id: 'route-server',
    name: 'Route MCP',
    transport: 'http' as const,
    enabled: false,
    status: 'disabled' as const,
    tools: [],
    hasCredentials: false,
    authMode: 'headers' as const
  };
  const manager = {
    start: async () => undefined,
    stop: async () => undefined,
    listServers: () => [server],
    getServer: () => server,
    saveServer: (draft: McpServerConfig) => {
      savedDraft = draft;
      return server;
    },
    updateServer: () => server,
    testServer: async () => server,
    setEnabled: async () => server,
    refresh: async () => server,
    authorize: async () => server,
    deleteServer: async () => undefined,
    getToolModules: () => [],
    listPresets: () => [],
    enablePreset: async () => server,
    disablePreset: async () => server,
    getManagedMetadata: () => undefined
  } as McpManager;
  const app = createApp({ mcpManager: manager, tools: toolCatalog });
  const listener = createServer(app);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const staticHeaders = await fetch(`${base}/api/mcp/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ name: 'Static', transport: 'http', url: 'http://127.0.0.1/mcp', authMode: 'headers', headers: { Authorization: 'Bearer static' } })
    });
    assert.equal(staticHeaders.status, 201);
    assert.equal((savedDraft as { headers?: Record<string, string> }).headers?.Authorization, 'Bearer static');

    const normalizedNone = await fetch(`${base}/api/mcp/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ name: 'Normalized', transport: 'http', url: 'http://127.0.0.1/mcp', authMode: 'none', headers: { Authorization: 'Bearer static' } })
    });
    assert.equal(normalizedNone.status, 201);
    assert.equal((savedDraft as { authMode?: string }).authMode, 'headers');

    const oauthHeaders = await fetch(`${base}/api/mcp/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ name: 'OAuth', transport: 'http', url: 'http://127.0.0.1/mcp', authMode: 'oauth', headers: { Authorization: 'Bearer static' } })
    });
    assert.equal(oauthHeaders.status, 400);

    const sameOrigin = await fetch(`${base}/api/mcp/servers`, { headers: { origin: base } });
    assert.equal(sameOrigin.status, 200);
    const healthAllowed = await fetch(`${base}/api/health`, {
      headers: { origin: 'http://localhost:5173' }
    });
    assert.equal(healthAllowed.status, 200);
    const healthCli = await fetch(`${base}/api/health`);
    assert.equal(healthCli.status, 200);
    const healthBadHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/api/health`, { headers: { host: 'evil.example' } }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
      request.end();
    });
    assert.equal(healthBadHost, 403);
    const options = await fetch(`${base}/api/mcp/servers`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' }
    });
    assert.equal(options.status, 204);
    const evilOrigin = await fetch(`${base}/api/mcp/servers`, { headers: { origin: 'https://evil.example' } });
    assert.equal(evilOrigin.status, 403);
    const healthEvilOrigin = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(healthEvilOrigin.status, 403);
  } finally {
    listener.close();
    await once(listener, 'close');
    if (previousOrigins === undefined) delete process.env.APP_ORIGINS;
    else process.env.APP_ORIGINS = previousOrigins;
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
  }
});

test('SDK adapter allows static Authorization and none-with-headers, but rejects it for OAuth', async () => {
  const factory = createSdkAdapterFactory();
  const base = {
    transport: 'http' as const,
    url: 'not-a-url',
    enabled: false,
    name: 'Adapter fixture',
    id: 'adapter-fixture'
  };
  await assert.rejects(factory({ ...base, authMode: 'headers', headers: { Authorization: 'Bearer static' } }, {}), /Invalid URL/);
  await assert.rejects(factory({ ...base, authMode: 'none', headers: { Authorization: 'Bearer static' } }, {}), /Invalid URL/);
  await assert.rejects(factory({ ...base, authMode: 'oauth', oauth: {}, headers: { Authorization: 'Bearer static' } }, {}), /reserved for OAuth/);
});

test('SDK OAuth adapter performs fake discovery, DCR, state, and PKCE before returning authorization_required', async () => {
  const serverUrl = 'http://127.0.0.1:8765/mcp';
  const authorizationServer = 'http://auth.example.test';
  const resourceMetadataUrl = `${serverUrl}/resource-metadata`;
  const calls: string[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === serverUrl && (init?.method ?? 'GET') === 'GET') return new Response(null, { status: 405 });
    if (url === serverUrl && init?.method === 'POST') {
      return new Response('', {
        status: 401,
        headers: { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` }
      });
    }
    if (url === resourceMetadataUrl) {
      return jsonResponse({ resource: serverUrl, authorization_servers: [authorizationServer] });
    }
    if (url.startsWith(`${authorizationServer}/.well-known/`)) {
      return jsonResponse({
        issuer: authorizationServer,
        authorization_endpoint: `${authorizationServer}/authorize`,
        token_endpoint: `${authorizationServer}/token`,
        registration_endpoint: `${authorizationServer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256']
      });
    }
    if (url === `${authorizationServer}/register` && init?.method === 'POST') {
      return jsonResponse({
        client_id: 'dcr-client',
        client_name: 'EvidentLoop',
        redirect_uris: ['http://127.0.0.1:3000/api/mcp/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      });
    }
    throw new Error(`Unexpected fake OAuth request: ${url}`);
  };
  const config: McpServerConfig = {
    id: 'oauth-fixture',
    name: 'OAuth fixture',
    transport: 'http',
    enabled: false,
    url: serverUrl,
    authMode: 'oauth',
    oauth: {}
  };
  let authorizationUrl: string | undefined;
  const factory = createSdkAdapterFactory({ fetch: fakeFetch, port: 3000 });
  await assert.rejects(
    factory(config, { onOAuthState: (state) => { config.oauth = { ...state }; } }),
    (error: unknown) => {
      const candidate = error as { code?: string; authorizationUrl?: string };
      authorizationUrl = candidate.authorizationUrl;
      return candidate.code === 'authorization_required' && Boolean(candidate.authorizationUrl);
    }
  );
  assert.ok(authorizationUrl);
  const parsedAuthorization = new URL(authorizationUrl!);
  assert.equal(parsedAuthorization.searchParams.get('client_id'), 'dcr-client');
  assert.equal(parsedAuthorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsedAuthorization.searchParams.get('state'), config.oauth?.state);
  assert.ok(config.oauth?.codeVerifier);
  assert.equal(config.oauth?.clientInformation?.client_id, 'dcr-client');
  assert.ok(config.oauth?.discoveryState?.authorizationServerUrl);
  assert.ok(calls.some((call) => call.includes('/register')));
});

test('SDK OAuth callback rehydrates provider state before SDK transport finishAuth', async () => {
  const serverUrl = 'http://127.0.0.1:8768/mcp';
  const authorizationServer = 'http://auth.example.test';
  const resourceMetadataUrl = `${serverUrl}/resource-metadata`;
  let initialUnauthorized = true;
  let initialized = false;
  let persistedOAuth: McpOAuthConfig = {};
  const finishAuthEntryChecks: Array<{
    clientId: string;
    hasCodeVerifier: boolean;
    hasDiscoveryState: boolean;
  }> = [];
  const calls: string[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === serverUrl && (init?.method ?? 'GET') === 'GET') return new Response(null, { status: 405 });
    if (url === serverUrl && init?.method === 'POST') {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as { method?: string; id?: number } : undefined;
      if (initialUnauthorized) {
        initialUnauthorized = false;
        return new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` }
        });
      }
      if (body?.method === 'initialize') {
        initialized = true;
        return jsonRpcResponse(body.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-oauth-server', version: '1' }
        });
      }
      if (body?.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body?.method === 'tools/list') return jsonRpcResponse(body.id, { tools: [] });
    }
    if (url === resourceMetadataUrl) {
      return jsonResponse({ resource: serverUrl, authorization_servers: [authorizationServer] });
    }
    if (url.startsWith(`${authorizationServer}/.well-known/`)) {
      return jsonResponse({
        issuer: authorizationServer,
        authorization_endpoint: `${authorizationServer}/authorize`,
        token_endpoint: `${authorizationServer}/token`,
        registration_endpoint: `${authorizationServer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256']
      });
    }
    if (url === `${authorizationServer}/register` && init?.method === 'POST') {
      return jsonResponse({
        client_id: 'dcr-client',
        client_name: 'EvidentLoop',
        redirect_uris: ['http://127.0.0.1:3000/api/mcp/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      });
    }
    if (url === `${authorizationServer}/token` && init?.method === 'POST') {
      assert.match(String(init.body), /client_id=dcr-client/);
      initialized = true;
      return jsonResponse({ access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer' });
    }
    throw new Error(`Unexpected fake OAuth request: ${url}`);
  };
  const config: McpServerConfig = {
    id: 'oauth-dcr-callback-fixture',
    name: 'OAuth DCR callback fixture',
    transport: 'http',
    enabled: false,
    url: serverUrl,
    authMode: 'oauth',
    oauth: {}
  };
  const providerOAuth = config.oauth!;
  const factory = createSdkAdapterFactory({
    fetch: fakeFetch,
    port: 3000,
    // This is a narrow adapter seam for the SDK transport boundary. It models
    // transport.finishAuth checking its provider state before doing any SDK
    // work; it must not call provider.clientInformation(), because that getter
    // is itself allowed to rehydrate state.
    onOAuthFinishAuth: (oauth) => {
      finishAuthEntryChecks.push({
        clientId: String(oauth.clientInformation?.client_id ?? 'missing'),
        hasCodeVerifier: Boolean(oauth.codeVerifier),
        hasDiscoveryState: Boolean(oauth.discoveryState)
      });
    }
  });
  let pendingConnection: McpConnection | undefined;
  await assert.rejects(
    factory(config, {
      onOAuthState: (state) => { persistedOAuth = structuredClone(state); },
      getOAuthState: () => structuredClone(persistedOAuth)
    }),
    (error: unknown) => {
      const candidate = error as { code?: string; connection?: McpConnection };
      pendingConnection = candidate.connection;
      return candidate.code === 'authorization_required' && Boolean(candidate.connection);
    }
  );
  assert.ok(pendingConnection);
  assert.equal(persistedOAuth.clientInformation?.client_id, 'dcr-client');
  const state = persistedOAuth.state;
  assert.ok(state);

  // Model a callback connection whose in-memory OAuth object was rebuilt from
  // a stale draft while the encrypted store still contains the DCR record.
  for (const key of Object.keys(providerOAuth) as Array<keyof McpOAuthConfig>) delete providerOAuth[key];
  assert.equal(providerOAuth.clientInformation, undefined);
  await pendingConnection!.finishAuth?.('fake-code', state);

  assert.equal(initialized, true);
  assert.equal(persistedOAuth.tokens?.access_token, 'access-token');
  assert.deepEqual(finishAuthEntryChecks, [{
    clientId: 'dcr-client',
    hasCodeVerifier: true,
    hasDiscoveryState: true
  }]);
  assert.equal(calls.filter((call) => call.includes('/register')).length, 1);
  assert.equal((await pendingConnection!.listTools()).tools.length, 0);
});

test('SDK OAuth adapter uses client_secret_post for contradictory DCR metadata', async () => {
  const result = await runDcrCodeExchangeFixture({
    id: 'oauth-dcr-secret-post-fixture',
    clientSecret: 'dcr-secret',
    tokenEndpointAuthMethods: ['client_secret_post', 'none'],
    expectedTokenAuthMethod: 'client_secret_post'
  });
  const request = result.tokenRequests[0];
  assert.ok(request);
  assert.equal(request.body.get('client_secret'), 'dcr-secret');
  assert.equal(request.authorization, null);
  assert.equal(result.persistedOAuth.clientInformation?.client_secret, 'dcr-secret');
  assert.equal(result.persistedOAuth.clientInformation?.token_endpoint_auth_method, 'none');
});

test('SDK OAuth adapter keeps none when DCR has no client secret', async () => {
  const result = await runDcrCodeExchangeFixture({
    id: 'oauth-dcr-no-secret-fixture',
    tokenEndpointAuthMethods: ['client_secret_post', 'none'],
    expectedTokenAuthMethod: 'none'
  });
  const request = result.tokenRequests[0];
  assert.ok(request);
  assert.equal(request.body.get('client_secret'), null);
  assert.equal(request.authorization, null);
  assert.equal(result.persistedOAuth.clientInformation?.client_secret, undefined);
  assert.equal(result.persistedOAuth.clientInformation?.token_endpoint_auth_method, 'none');
});

test('SDK OAuth adapter keeps an explicit none method when client_secret_post is unsupported', async () => {
  const result = await runDcrCodeExchangeFixture({
    id: 'oauth-dcr-no-post-fixture',
    clientSecret: 'dcr-secret',
    tokenEndpointAuthMethods: ['none'],
    expectedTokenAuthMethod: 'none'
  });
  const request = result.tokenRequests[0];
  assert.ok(request);
  assert.equal(request.body.get('client_secret'), null);
  assert.equal(request.authorization, null);
  assert.equal(result.persistedOAuth.clientInformation?.client_secret, 'dcr-secret');
  assert.equal(result.persistedOAuth.clientInformation?.token_endpoint_auth_method, 'none');
});

test('MCP public credential flag ignores OAuth draft metadata but marks stored client state', async () => {
  const fixture = createFixture({ cipher: createCredentialCipher(generateCredentialKey()) });
  const draft = saveDraft(fixture.manager, { authMode: 'oauth', oauth: { scope: 'devspace' } });
  assert.equal(fixture.manager.getServer(draft.id)?.hasCredentials, false);

  const registered = saveDraft(fixture.manager, {
    authMode: 'oauth',
    oauth: { clientInformation: { client_id: 'registered-client' } }
  });
  assert.equal(fixture.manager.getServer(registered.id)?.hasCredentials, true);
  await fixture.manager.stop();
  fixture.database.close();
});

test('SDK OAuth callback exchanges a fake code, persists tokens, and reconnects the MCP session', async () => {
  const serverUrl = 'http://127.0.0.1:8766/mcp';
  const authorizationServer = 'http://auth.example.test';
  const resourceMetadataUrl = `${serverUrl}/resource-metadata`;
  let initialUnauthorized = true;
  const calls: string[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === serverUrl && (init?.method ?? 'GET') === 'GET') return new Response(null, { status: 405 });
    if (url === serverUrl && init?.method === 'POST') {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as { method?: string; id?: number } : undefined;
      if (initialUnauthorized) {
        initialUnauthorized = false;
        return new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` }
        });
      }
      if (body?.method === 'initialize') {
        return jsonRpcResponse(body.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-oauth-server', version: '1' }
        });
      }
      if (body?.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body?.method === 'tools/list') return jsonRpcResponse(body.id, { tools: [] });
    }
    if (url === resourceMetadataUrl) {
      return jsonResponse({ resource: serverUrl, authorization_servers: [authorizationServer] });
    }
    if (url.startsWith(`${authorizationServer}/.well-known/`)) {
      return jsonResponse({
        issuer: authorizationServer,
        authorization_endpoint: `${authorizationServer}/authorize`,
        token_endpoint: `${authorizationServer}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256']
      });
    }
    if (url === `${authorizationServer}/token` && init?.method === 'POST') {
      return jsonResponse({ access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer', expires_in: 3600 });
    }
    throw new Error(`Unexpected fake callback request: ${url}`);
  };
  const config: McpServerConfig = {
    id: 'oauth-callback-fixture',
    name: 'OAuth callback fixture',
    transport: 'http',
    enabled: false,
    url: serverUrl,
    authMode: 'oauth',
    oauth: { clientId: 'registered-client', clientSecret: 'registered-secret' }
  };
  const factory = createSdkAdapterFactory({ fetch: fakeFetch, port: 3000 });
  let pendingConnection: McpConnection | undefined;
  await assert.rejects(
    factory(config, { onOAuthState: (state) => { config.oauth = { ...state }; } }),
    (error: unknown) => {
      const candidate = error as { code?: string; connection?: McpConnection };
      pendingConnection = candidate.connection;
      return candidate.code === 'authorization_required' && Boolean(candidate.connection);
    }
  );
  assert.ok(pendingConnection);
  const state = config.oauth?.state;
  assert.ok(state);
  await pendingConnection!.finishAuth?.('fake-code', state);
  assert.equal(config.oauth?.tokens?.access_token, 'access-token');
  assert.equal((await pendingConnection!.listTools()).tools.length, 0);
  assert.equal(calls.some((call) => call.includes('/register')), false);
});

test('SDK OAuth refresh failure invalidates the token and returns authorization_required', async () => {
  const serverUrl = 'http://127.0.0.1:8767/mcp';
  const authorizationServer = 'http://auth.example.test';
  const metadata = {
    issuer: authorizationServer,
    authorization_endpoint: `${authorizationServer}/authorize`,
    token_endpoint: `${authorizationServer}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    code_challenge_methods_supported: ['S256']
  };
  const config: McpServerConfig = {
    id: 'oauth-refresh-fixture',
    name: 'OAuth refresh fixture',
    transport: 'http',
    enabled: false,
    url: serverUrl,
    authMode: 'oauth',
    oauth: {
      clientId: 'registered-client',
      clientSecret: 'registered-secret',
      tokens: { access_token: 'expired', refresh_token: 'refresh-token', token_type: 'Bearer' },
      discoveryState: {
        authorizationServerUrl: authorizationServer,
        resourceMetadata: { resource: serverUrl, authorization_servers: [authorizationServer] },
        authorizationServerMetadata: metadata
      }
    }
  };
  const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.method, 'POST');
    return jsonResponse({ error: 'invalid_grant', error_description: 'expired refresh token' }, 400);
  };
  let authorizationUrl: string | undefined;
  const factory = createSdkAdapterFactory({ fetch: fakeFetch, port: 3000 });
  await assert.rejects(
    factory(config, {
      onOAuthState: (state) => {
        config.oauth = { ...state };
        authorizationUrl = undefined;
      }
    }),
    (error: unknown) => {
      const candidate = error as { code?: string; authorizationUrl?: string };
      authorizationUrl = candidate.authorizationUrl;
      return candidate.code === 'authorization_required';
    }
  );
  assert.ok(authorizationUrl);
  assert.equal(config.oauth?.tokens, undefined);
});

type DcrTokenAuthMethod = 'client_secret_post' | 'none';

type DcrCodeExchangeFixture = {
  id: string;
  clientSecret?: string;
  tokenEndpointAuthMethods: unknown;
  expectedTokenAuthMethod: DcrTokenAuthMethod;
};

type DcrTokenRequest = {
  body: URLSearchParams;
  authorization: string | null;
};

async function runDcrCodeExchangeFixture(options: DcrCodeExchangeFixture) {
  const serverUrl = `http://127.0.0.1/${options.id}/mcp`;
  const authorizationServer = `http://${options.id}.test`;
  const resourceMetadataUrl = `${serverUrl}/resource-metadata`;
  let initialUnauthorized = true;
  const tokenRequests: DcrTokenRequest[] = [];
  let persistedOAuth: McpOAuthConfig = {};
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === serverUrl && (init?.method ?? 'GET') === 'GET') return new Response(null, { status: 405 });
    if (url === serverUrl && init?.method === 'POST') {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as { method?: string; id?: number } : undefined;
      if (initialUnauthorized) {
        initialUnauthorized = false;
        return new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` }
        });
      }
      if (body?.method === 'initialize') {
        return jsonRpcResponse(body.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-oauth-server', version: '1' }
        });
      }
      if (body?.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body?.method === 'tools/list') return jsonRpcResponse(body.id, { tools: [] });
    }
    if (url === resourceMetadataUrl) {
      return jsonResponse({ resource: serverUrl, authorization_servers: [authorizationServer] });
    }
    if (url.startsWith(`${authorizationServer}/.well-known/`)) {
      return jsonResponse({
        issuer: authorizationServer,
        authorization_endpoint: `${authorizationServer}/authorize`,
        token_endpoint: `${authorizationServer}/token`,
        registration_endpoint: `${authorizationServer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: options.tokenEndpointAuthMethods,
        code_challenge_methods_supported: ['S256']
      });
    }
    if (url === `${authorizationServer}/register` && init?.method === 'POST') {
      return jsonResponse({
        client_id: 'dcr-client',
        ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
        client_name: 'EvidentLoop',
        redirect_uris: ['http://127.0.0.1:3000/api/mcp/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      });
    }
    if (url === `${authorizationServer}/token` && init?.method === 'POST') {
      const body = new URLSearchParams(String(init.body));
      const authorization = new Headers(init.headers).get('authorization');
      tokenRequests.push({ body, authorization });
      const hasExpectedAuthentication = options.expectedTokenAuthMethod === 'client_secret_post'
        ? body.get('client_secret') === options.clientSecret && authorization === null
        : !body.has('client_secret') && authorization === null;
      if (!hasExpectedAuthentication) {
        return jsonResponse({ error: 'invalid_client', error_description: 'unexpected client authentication' }, 400);
      }
      return jsonResponse({ access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer' });
    }
    throw new Error(`Unexpected fake OAuth request: ${url}`);
  };
  const config: McpServerConfig = {
    id: options.id,
    name: 'DCR code exchange fixture',
    transport: 'http',
    enabled: false,
    url: serverUrl,
    authMode: 'oauth',
    oauth: {}
  };
  const factory = createSdkAdapterFactory({ fetch: fakeFetch, port: 3000 });
  let pendingConnection: McpConnection | undefined;
  await assert.rejects(
    factory(config, {
      onOAuthState: (state) => { persistedOAuth = structuredClone(state); },
      getOAuthState: () => structuredClone(persistedOAuth)
    }),
    (error: unknown) => {
      const candidate = error as { code?: string; connection?: McpConnection };
      pendingConnection = candidate.connection;
      return candidate.code === 'authorization_required' && Boolean(candidate.connection);
    }
  );
  assert.ok(pendingConnection);
  const state = persistedOAuth.state;
  assert.ok(state);
  await pendingConnection!.finishAuth?.('fake-code', state);
  assert.equal((await pendingConnection!.listTools()).tools.length, 0);
  return { persistedOAuth, tokenRequests };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function jsonRpcResponse(id: number | undefined, result: unknown) {
  return jsonResponse({ jsonrpc: '2.0', id, result });
}
