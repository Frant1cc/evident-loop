import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { sqlite } from '../db.js';
import { createCredentialCipher, type CredentialCipher } from './crypto.js';
import { mcpToolDefinitionHash } from './definitionHash.js';
import type {
  McpAuthMode,
  McpOAuthConfig,
  McpServerConfig,
  McpServerDraft,
  McpServerState,
  McpStore,
  McpToolRecord,
  McpTransportKind
} from './contracts.js';

type StoredConfig = {
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  authMode: McpAuthMode;
  envNames?: string[];
  envValues?: Record<string, string>;
  headerNames?: string[];
  headerValues?: Record<string, string>;
  oauthValues?: string;
  credentialsUnavailable?: boolean;
};

type ServerRow = {
  id: string;
  name: string;
  config_json: string;
  enabled: number;
  status: McpServerState['status'];
  last_error: string | null;
  last_refreshed_at: string | null;
  authorization_url: string | null;
};

type ToolRow = {
  server_id: string;
  remote_name: string;
  model_name: string;
  ordinal: number;
  description: string;
  input_schema_json: string;
  definition_hash: string | null;
  annotations_json: string | null;
  tombstone: number;
  last_seen_at: string | null;
};

export class SqliteMcpStore implements McpStore {
  private readonly database: Database.Database;
  private readonly cipher: CredentialCipher;

  constructor(database: Database.Database = sqlite, cipher = createCredentialCipher()) {
    this.database = database;
    this.cipher = cipher;
    this.ensureSchema();
  }

  ensureSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'disabled',
        last_error TEXT,
        last_refreshed_at TEXT,
        authorization_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_tools (
        server_id TEXT NOT NULL,
        remote_name TEXT NOT NULL,
        model_name TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        input_schema_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL DEFAULT '',
        annotations_json TEXT,
        tombstone INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        PRIMARY KEY (server_id, remote_name),
        FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS mcp_tools_server_ordinal_idx ON mcp_tools(server_id, ordinal);
    `);
    // Existing installations may have the pre-hash table shape. SQLite does
    // not support ADD COLUMN IF NOT EXISTS, so keep this migration idempotent.
    const columns = this.database.prepare('PRAGMA table_info(mcp_tools)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'definition_hash')) {
      this.database.exec("ALTER TABLE mcp_tools ADD COLUMN definition_hash TEXT NOT NULL DEFAULT ''");
    }
  }

  listServers(): McpServerConfig[] {
    const rows = this.database.prepare('SELECT * FROM mcp_servers ORDER BY created_at, id').all() as ServerRow[];
    return rows.map((row) => this.fromRow(row));
  }

  getServer(id: string): McpServerConfig | undefined {
    const row = this.database.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as ServerRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  getServerState(id: string): McpServerState | undefined {
    const row = this.database.prepare('SELECT status, last_error, last_refreshed_at, authorization_url FROM mcp_servers WHERE id = ?').get(id) as {
      status: McpServerState['status'];
      last_error: string | null;
      last_refreshed_at: string | null;
      authorization_url: string | null;
    } | undefined;
    if (!row) return undefined;
    return {
      status: row.status,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      ...(row.last_refreshed_at ? { lastRefreshedAt: row.last_refreshed_at } : {}),
      ...(row.authorization_url ? { authorizationUrl: row.authorization_url } : {})
    };
  }

  saveServer(draft: McpServerDraft): McpServerConfig {
    const existingRow = draft.id
      ? this.database.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(draft.id) as ServerRow | undefined
      : undefined;
    const existing = existingRow ? this.fromRow(existingRow) : undefined;
    if (hasSensitiveValues(draft) && !this.cipher.available) {
      throw new Error('MCP_CREDENTIALS_KEY is required to save MCP credentials');
    }
    const id = existing?.id ?? draft.id ?? randomUUID();
    const now = new Date().toISOString();
    let merged = mergeDraft(existing, { ...draft, id });
    if (merged.authMode === 'none' && merged.headers && Object.keys(merged.headers).length > 0) {
      merged = { ...merged, authMode: 'headers' };
    }
    if (merged.authMode === 'oauth' && hasAuthorizationHeader(merged.headers)) {
      throw new Error('Authorization header is reserved for OAuth');
    }
    const preserved = existingRow ? parseStoredConfig(existingRow.config_json) : undefined;
    const config = this.toStoredConfig(merged, preserved, draft);
    const enabled = merged.enabled ? 1 : 0;
    const status = merged.enabled ? 'connecting' : 'disabled';
    this.database.prepare(`
      INSERT INTO mcp_servers
        (id, name, config_json, enabled, status, last_error, last_refreshed_at, authorization_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        config_json = excluded.config_json,
        enabled = excluded.enabled,
        status = CASE WHEN excluded.enabled = 0 THEN 'disabled' ELSE mcp_servers.status END,
        updated_at = excluded.updated_at
    `).run(id, merged.name, JSON.stringify(config), enabled, status, now, now);
    return this.getServer(id)!;
  }

  deleteServer(id: string) {
    const remove = this.database.transaction(() => {
      this.database.prepare('DELETE FROM mcp_tools WHERE server_id = ?').run(id);
      this.database.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    });
    remove();
  }

  setServerState(id: string, state: Partial<McpServerState>) {
    const current = this.database.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as ServerRow | undefined;
    if (!current) return;
    const nextStatus = state.status ?? current.status;
    const healthy = nextStatus === 'disabled' || nextStatus === 'connecting' || nextStatus === 'connected' || nextStatus === 'credential_unavailable';
    const nextError = state.lastError === undefined ? healthy ? null : current.last_error : state.lastError ?? null;
    const nextRefreshed = state.lastRefreshedAt === undefined ? current.last_refreshed_at : state.lastRefreshedAt ?? null;
    const nextAuthorization = state.authorizationUrl === undefined
      ? healthy ? null : current.authorization_url
      : state.authorizationUrl ?? null;
    this.database.prepare(`
      UPDATE mcp_servers
      SET status = ?, last_error = ?, last_refreshed_at = ?, authorization_url = ?, updated_at = ?
      WHERE id = ?
    `).run(nextStatus, nextError, nextRefreshed, nextAuthorization, new Date().toISOString(), id);
  }

  listTools(serverId?: string): McpToolRecord[] {
    const rows = (serverId
      ? this.database.prepare('SELECT * FROM mcp_tools WHERE server_id = ? ORDER BY ordinal, remote_name').all(serverId)
      : this.database.prepare(`
        SELECT mcp_tools.*
        FROM mcp_tools
        INNER JOIN mcp_servers ON mcp_servers.id = mcp_tools.server_id
        ORDER BY mcp_servers.created_at, mcp_servers.id, mcp_tools.ordinal, mcp_tools.remote_name
      `).all()) as ToolRow[];
    return rows.map((row) => ({
      serverId: row.server_id,
      remoteName: row.remote_name,
      modelName: row.model_name,
      ordinal: row.ordinal,
      description: row.description,
      inputSchema: parseJsonObject(row.input_schema_json),
      definitionHash: row.definition_hash || mcpToolDefinitionHash(
        row.model_name,
        row.description,
        parseJsonObject(row.input_schema_json)
      ),
      ...(row.annotations_json ? { annotations: parseJsonObject(row.annotations_json) } : {}),
      tombstone: row.tombstone === 1,
      ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {})
    }));
  }

  upsertTool(tool: McpToolRecord) {
    const definitionHash = tool.definitionHash
      ?? mcpToolDefinitionHash(tool.modelName, tool.description, tool.inputSchema);
    this.database.prepare(`
      INSERT INTO mcp_tools
        (server_id, remote_name, model_name, ordinal, description, input_schema_json, definition_hash, annotations_json, tombstone, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, remote_name) DO UPDATE SET
        model_name = excluded.model_name,
        ordinal = excluded.ordinal,
        description = excluded.description,
        input_schema_json = excluded.input_schema_json,
        definition_hash = excluded.definition_hash,
        annotations_json = excluded.annotations_json,
        tombstone = excluded.tombstone,
        last_seen_at = excluded.last_seen_at
    `).run(
      tool.serverId,
      tool.remoteName,
      tool.modelName,
      tool.ordinal,
      tool.description,
      JSON.stringify(tool.inputSchema),
      definitionHash,
      tool.annotations ? JSON.stringify(tool.annotations) : null,
      tool.tombstone ? 1 : 0,
      tool.lastSeenAt ?? null
    );
  }

  deleteTools(serverId: string) {
    this.database.prepare('DELETE FROM mcp_tools WHERE server_id = ?').run(serverId);
  }

  private fromRow(row: ServerRow): McpServerConfig {
    const stored = parseStoredConfig(row.config_json);
    const env = decryptMap(stored.envValues, this.cipher);
    const headers = decryptMap(stored.headerValues, this.cipher);
    const oauthText = stored.oauthValues ? this.cipher.decrypt(stored.oauthValues) : undefined;
    const oauth = oauthText ? parseJsonObject(oauthText) as McpOAuthConfig : undefined;
    const credentialsExpected = Boolean(stored.envValues || stored.headerValues || stored.oauthValues || stored.credentialsUnavailable);
    const credentialsUnavailable = stored.credentialsUnavailable === true
      || (credentialsExpected && !this.cipher.available)
      || (Boolean(stored.envValues) && !env)
      || (Boolean(stored.headerValues) && !headers)
      || (Boolean(stored.oauthValues) && !oauth);
    const authMode = stored.authMode === 'none'
      && (Boolean(stored.headerValues) || Boolean(headers && Object.keys(headers).length))
      ? 'headers'
      : stored.authMode;

    return {
      id: row.id,
      name: row.name,
      transport: stored.transport,
      enabled: row.enabled === 1,
      ...(stored.command ? { command: stored.command } : {}),
      ...(stored.args ? { args: stored.args } : {}),
      ...(stored.cwd ? { cwd: stored.cwd } : {}),
      ...(stored.url ? { url: stored.url } : {}),
      authMode,
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {}),
      ...(oauth ? { oauth } : {}),
      ...(credentialsUnavailable ? { credentialUnavailable: true } : {})
    };
  }

  private toStoredConfig(config: McpServerConfig, preserved?: StoredConfig, draft?: McpServerDraft): StoredConfig {
    const stored: StoredConfig = {
      transport: config.transport,
      ...(config.command ? { command: config.command } : {}),
      ...(config.args && config.args.length > 0 ? { args: config.args } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.url ? { url: config.url } : {}),
      authMode: config.authMode
    };

    let unavailable = false;
    if (config.env && Object.keys(config.env).length > 0) {
      stored.envNames = Object.keys(config.env);
      stored.envValues = encryptMap(config.env, this.cipher);
      unavailable ||= stored.envValues === undefined;
    } else if (draft?.env === undefined && preserved?.envValues) {
      stored.envNames = preserved.envNames;
      stored.envValues = preserved.envValues;
    }
    if (config.headers && Object.keys(config.headers).length > 0) {
      stored.headerNames = Object.keys(config.headers);
      stored.headerValues = encryptMap(config.headers, this.cipher);
      unavailable ||= stored.headerValues === undefined;
    } else if (draft?.headers === undefined && preserved?.headerValues) {
      stored.headerNames = preserved.headerNames;
      stored.headerValues = preserved.headerValues;
    }
    if (config.oauth && Object.keys(config.oauth).length > 0) {
      const encrypted = this.cipher.encrypt(JSON.stringify(config.oauth));
      stored.oauthValues = encrypted;
      unavailable ||= encrypted === undefined;
    } else if (draft?.oauth === undefined && preserved?.oauthValues) {
      stored.oauthValues = preserved.oauthValues;
    }
    // Keep the unavailable marker only while an encrypted field remains. An
    // explicit auth/transport switch can clear the old ciphertext even when
    // the current process lacks the key, after which the draft is usable
    // again without silently dropping any still-retained credential.
    const retainedEncryptedValues = Boolean(stored.envValues || stored.headerValues || stored.oauthValues);
    if (unavailable
      || (config.credentialUnavailable === true && retainedEncryptedValues)
      || (preserved?.credentialsUnavailable && retainedEncryptedValues)) {
      stored.credentialsUnavailable = true;
    }
    return stored;
  }
}

export function createMcpStore(database: Database.Database = sqlite, cipher = createCredentialCipher()): McpStore {
  return new SqliteMcpStore(database, cipher);
}

function mergeDraft(existing: McpServerConfig | undefined, draft: McpServerDraft): McpServerConfig {
  const source = existing ?? {
    id: draft.id ?? randomUUID(),
    name: draft.name,
    transport: draft.transport,
    enabled: false,
    authMode: draft.authMode
  };
  const merged = { ...source, ...draft, id: source.id } as McpServerConfig;
  // PUT callers commonly omit secrets to keep them unchanged. Preserve the
  // decrypted values in that case, while an explicit empty object clears them.
  if (draft.env === undefined && existing?.env) merged.env = existing.env;
  if (draft.headers === undefined && existing?.headers) merged.headers = existing.headers;
  if (draft.oauth === undefined && existing?.oauth) merged.oauth = existing.oauth;
  if (draft.oauth && Object.keys(draft.oauth).length > 0 && existing?.oauth) {
    merged.oauth = mergeOAuthConfig(existing.oauth, draft.oauth);
  }
  return merged;
}

function mergeOAuthConfig(current: McpOAuthConfig, update: McpOAuthConfig): McpOAuthConfig {
  const merged = { ...current, ...update };
  for (const key of ['tokens', 'clientInformation', 'discoveryState'] as const) {
    const previous = current[key];
    const next = update[key];
    if (previous && typeof previous === 'object' && !Array.isArray(previous)
      && next && typeof next === 'object' && !Array.isArray(next)) {
      merged[key] = { ...previous, ...next };
    }
  }
  return merged;
}

function hasSensitiveValues(draft: McpServerDraft): boolean {
  return Boolean(
    (draft.env && Object.keys(draft.env).length > 0)
    || (draft.headers && Object.keys(draft.headers).length > 0)
    || (draft.oauth && Object.keys(draft.oauth).length > 0)
  );
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Boolean(headers && Object.keys(headers).some((name) => name.toLowerCase() === 'authorization'));
}

function encryptMap(values: Record<string, string>, cipher: CredentialCipher): Record<string, string> | undefined {
  if (!cipher.available) return undefined;
  const encrypted: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const item = cipher.encrypt(value);
    if (!item) return undefined;
    encrypted[key] = item;
  }
  return encrypted;
}

function decryptMap(values: Record<string, string> | undefined, cipher: CredentialCipher): Record<string, string> | undefined {
  if (!values) return undefined;
  const decrypted: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const item = cipher.decrypt(value);
    if (item === undefined) return undefined;
    decrypted[key] = item;
  }
  return decrypted;
}

function parseStoredConfig(value: string): StoredConfig {
  try {
    const parsed = JSON.parse(value) as StoredConfig;
    return {
      transport: parsed.transport,
      authMode: parsed.authMode,
      ...(parsed.command ? { command: parsed.command } : {}),
      ...(parsed.args ? { args: parsed.args } : {}),
      ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
      ...(parsed.url ? { url: parsed.url } : {}),
      ...(parsed.envNames ? { envNames: parsed.envNames } : {}),
      ...(parsed.envValues ? { envValues: parsed.envValues } : {}),
      ...(parsed.headerNames ? { headerNames: parsed.headerNames } : {}),
      ...(parsed.headerValues ? { headerValues: parsed.headerValues } : {}),
      ...(parsed.oauthValues ? { oauthValues: parsed.oauthValues } : {}),
      ...(parsed.credentialsUnavailable ? { credentialsUnavailable: true } : {})
    };
  } catch {
    return { transport: 'http', authMode: 'none', credentialsUnavailable: true };
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
