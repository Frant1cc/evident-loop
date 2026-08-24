import { createHash } from 'node:crypto';

import { ToolExecutionError, type JsonSchema, type ToolContext, type ToolModule, type ToolRuntime } from '../tools/contracts.js';
import { createSdkAdapterFactory } from './adapters/sdk.js';
import type {
  McpAdapterFactory,
  McpAuthorizationRequired,
  McpConnection,
  McpManager,
  McpManagerOptions,
  McpNormalizedResult,
  McpPublicServer,
  McpServerConfig,
  McpServerDraft,
  McpServerState,
  McpStore,
  McpToolDescriptor,
  McpToolRecord
} from './contracts.js';
import { mcpToolDefinitionHash } from './definitionHash.js';
import { createMcpStore } from './store.js';
import { McpSchemaValidator } from './validation.js';
import { MANAGED_PRESETS, getPresetById, describeApprovalPolicy, type McpManagedMetadata, type McpPresetPublic } from './presets/index.js';

type Entry = {
  config: McpServerConfig;
  state: McpServerState;
  connection?: McpConnection;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  refreshTimer?: ReturnType<typeof setTimeout>;
  refreshPromise?: Promise<void>;
  backoffAttempt: number;
  validated: boolean;
  generation: number;
};

export class McpManagerImpl implements McpManager {
  private readonly runtime: ToolRuntime;
  private readonly store: McpStore;
  private readonly adapterFactory: McpAdapterFactory;
  private readonly host: string;
  private readonly port: number;
  private readonly reconnectBaseMs: number;
  private readonly listChangedDebounceMs: number;
  private readonly now: () => Date;
  private readonly schemaValidator = new McpSchemaValidator();
  private readonly schemaErrors = new Map<string, string>();
  private readonly entries = new Map<string, Entry>();
  private stopped = false;

  constructor(options: McpManagerOptions) {
    this.runtime = options.runtime;
    this.store = options.store ?? createMcpStore();
    this.adapterFactory = options.adapterFactory ?? createSdkAdapterFactory({ host: options.host, port: options.port });
    this.host = options.host?.trim() || process.env.HOST?.trim() || '127.0.0.1';
    this.port = options.port ?? Number(process.env.PORT ?? 3000);
    this.reconnectBaseMs = options.reconnectBaseMs ?? 500;
    this.listChangedDebounceMs = options.listChangedDebounceMs ?? 250;
    this.now = options.now ?? (() => new Date());
    this.hydratePersistedState();
  }

  async start() {
    this.stopped = false;
    // Do not await connection attempts: a dead local process or an unavailable
    // HTTP endpoint must never block application startup.
    for (const entry of this.entries.values()) {
      if (entry.config.enabled) void this.connectEntry(entry, false);
    }
  }

  async stop() {
    this.stopped = true;
    const closes: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      entry.generation += 1;
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
      entry.reconnectTimer = undefined;
      entry.refreshTimer = undefined;
      if (entry.connection) closes.push(entry.connection.close().catch(() => undefined));
      entry.connection = undefined;
    }
    await Promise.allSettled(closes);
  }

  listServers(): McpPublicServer[] {
    return [...this.entries.values()].map((entry) => this.toPublicServer(entry));
  }

  getServer(id: string): McpPublicServer | undefined {
    const entry = this.entries.get(id);
    return entry ? this.toPublicServer(entry) : undefined;
  }

  saveServer(draft: McpServerDraft): McpPublicServer {
    const existingEntry = draft.id ? this.entries.get(draft.id) : undefined;
    const saved = this.store.saveServer({ ...draft, enabled: false });
    if (existingEntry) void this.disconnectEntry(existingEntry);
    this.ensureEntry(saved);
    const entry = this.entries.get(saved.id)!;
    entry.config = saved;
    entry.state = { status: 'disabled' };
    entry.validated = false;
    this.store.setServerState(saved.id, entry.state);
    return this.toPublicServer(entry);
  }

  updateServer(id: string, draft: Partial<McpServerDraft>): McpPublicServer {
    const current = this.entries.get(id)?.config ?? this.store.getServer(id);
    if (!current) throw new Error(`Unknown MCP server: ${id}`);
    const currentEntry = this.entries.get(id);
    if (draft.enabled === true && (!currentEntry || !currentEntry.validated)) {
      throw new Error('MCP server must pass test before it can be enabled');
    }
    const normalizedDraft = normalizeServerUpdate(current, draft);
    const candidate = {
      ...current,
      ...normalizedDraft,
      id,
      enabled: normalizedDraft.enabled ?? current.enabled
    } as McpServerConfig;
    const connectionChanged = hasConnectionConfigChanged(current, candidate);
    if (candidate.enabled && candidate.transport === 'stdio') {
      this.assertTransportAllowed(candidate);
    }
    const wasEnabled = current.enabled;
    // Editing transport/authentication invalidates the previous test. Keep the
    // last-known tool schemas, but return the server to a disabled draft until
    // the new connection settings pass a fresh test.
    const next = this.store.saveServer({
      ...candidate,
      enabled: connectionChanged ? false : candidate.enabled
    });
    const entry = this.ensureEntry(next);
    entry.config = next;
    entry.validated = connectionChanged
      ? false
      : entry.validated || Boolean(entry.state.lastRefreshedAt);
    if (connectionChanged) {
      void this.disconnectEntry(entry);
      entry.state = { status: 'disabled' };
      // Empty text intentionally clears the persisted validation timestamp;
      // hydration therefore cannot treat an edited configuration as tested.
      this.store.setServerState(id, { status: 'disabled', lastRefreshedAt: '' });
    } else if (!next.enabled) {
      void this.disconnectEntry(entry);
      entry.state = { status: 'disabled' };
      this.store.setServerState(id, entry.state);
    } else if (!wasEnabled) {
      void this.disconnectEntry(entry).then(() => this.connectEntry(entry, false));
    }
    return this.toPublicServer(entry);
  }

  async testServer(id: string): Promise<McpPublicServer> {
    const entry = this.requireEntry(id);
    await this.disconnectEntry(entry);
    entry.validated = false;
    entry.state = {
      status: 'connecting',
      ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
    };
    this.store.setServerState(id, entry.state);
    try {
      await this.connectEntry(entry, true);
      if (entry.state.status === 'connected') {
        entry.validated = true;
        await this.disconnectEntry(entry);
        const lastRefreshedAt = entry.state.lastRefreshedAt;
        entry.state = { status: 'disabled', ...(lastRefreshedAt ? { lastRefreshedAt } : {}) };
        this.store.setServerState(id, entry.state);
      } else entry.validated = false;
    } catch (error) {
      // connectEntry records authorization_required/unavailable; preserve the
      // state for the callback route rather than converting it to a 500.
      if (!isAuthorizationRequired(error)) throw error;
    }
    return this.toPublicServer(entry);
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpPublicServer> {
    const entry = this.requireEntry(id);
    if (!enabled) {
      entry.config = this.store.saveServer({ ...entry.config, enabled: false });
      await this.disconnectEntry(entry);
      entry.state = { status: 'disabled' };
      this.store.setServerState(id, entry.state);
      return this.toPublicServer(entry);
    }

    if (!entry.validated) {
      throw new Error('MCP server must pass test before it can be enabled');
    }
    this.assertTransportAllowed(entry.config);
    entry.config = this.store.saveServer({ ...entry.config, enabled: true });
    void this.connectEntry(entry, false);
    return this.toPublicServer(entry);
  }

  async refresh(id: string): Promise<McpPublicServer> {
    const entry = this.requireEntry(id);
    if (!entry.connection) {
      if (entry.config.enabled) await this.connectEntry(entry, false);
      return this.toPublicServer(entry);
    }
    await this.refreshEntry(entry);
    return this.toPublicServer(entry);
  }

  async authorize(id: string, code: string, state?: string): Promise<McpPublicServer> {
    const entry = this.requireEntry(id);
    if (!entry.connection?.finishAuth) {
      throw new Error('MCP server has no pending authorization flow');
    }
    try {
      await entry.connection.finishAuth(code, state);
      await this.refreshEntry(entry);
      entry.validated = true;
      if (entry.config.enabled) {
        entry.state = { status: 'connected', lastRefreshedAt: entry.state.lastRefreshedAt };
        this.store.setServerState(id, entry.state);
      } else {
        const lastRefreshedAt = entry.state.lastRefreshedAt;
        await this.disconnectEntry(entry);
        entry.state = { status: 'disabled', ...(lastRefreshedAt ? { lastRefreshedAt } : {}) };
        this.store.setServerState(id, entry.state);
      }
    } catch (error) {
      entry.state = {
        status: 'authorization_required',
        authorizationUrl: entry.connection.authorizationUrl?.(),
        lastError: messageOf(error),
        ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
      };
      this.store.setServerState(id, entry.state);
      throw error;
    }
    return this.toPublicServer(entry);
  }

  getServerIdForOAuthState(state: string): string | undefined {
    for (const entry of this.entries.values()) {
      if (entry.config.oauth?.state === state) return entry.config.id;
    }
    return undefined;
  }

  async deleteServer(id: string) {
    const entry = this.entries.get(id);
    if (!entry && !this.store.getServer(id)) throw new Error(`Unknown MCP server: ${id}`);
    if (entry) await this.disconnectEntry(entry);
    const toolNames = this.store.listTools(id).map((tool) => tool.modelName);
    this.entries.delete(id);
    this.store.deleteServer(id);
    for (const modelName of toolNames) this.runtime.unregister?.(modelName);
  }

  getToolModules(): ToolModule[] {
    return this.runtime.listModules().filter((module) => module.source === 'mcp');
  }

  listPresets(): McpPresetPublic[] {
    return MANAGED_PRESETS.map((preset) => {
      const server = this.store.findServerByPresetId(preset.id);
      const entry = server ? this.entries.get(server.id) : undefined;

      if (!server || !entry) {
        return {
          id: preset.id,
          name: preset.name,
          description: preset.description,
          publisher: preset.publisher,
          package: preset.package,
          consentVersion: preset.consentVersion,
          status: 'not_installed',
          enabled: false,
          toolCount: 0,
          approvalPolicyDescription: describeApprovalPolicy(preset)
        };
      }

      const tools = this.store.listTools(server.id);
      return {
        id: preset.id,
        name: preset.name,
        description: preset.description,
        publisher: preset.publisher,
        package: preset.package,
        consentVersion: preset.consentVersion,
        status: entry.state.status === 'disabled' ? 'disabled' : entry.state.status,
        serverId: server.id,
        enabled: server.enabled,
        lastError: entry.state.lastError,
        lastRefreshedAt: entry.state.lastRefreshedAt,
        toolCount: tools.filter((t) => !t.tombstone).length,
        approvalPolicyDescription: describeApprovalPolicy(preset)
      };
    });
  }

  async enablePreset(presetId: string, consentVersion: number): Promise<McpPublicServer> {
    const preset = getPresetById(presetId);
    if (!preset) throw new Error(`Unknown preset: ${presetId}`);

    if (consentVersion < preset.consentVersion) {
      throw new Error(`Consent version ${consentVersion} is outdated, current version is ${preset.consentVersion}`);
    }

    // 查找或创建唯一 Server
    let server = this.store.findServerByPresetId(presetId);
    let entry = server ? this.entries.get(server.id) : undefined;

    if (!server) {
      // 创建新 Server
      const draft = preset.resolveDraft(process.platform);
      server = this.store.saveServer({ ...draft, enabled: false });
      entry = this.ensureEntry(server);

      // 保存 metadata
      const metadata: McpManagedMetadata = {
        presetId: preset.id,
        presetVersion: preset.version,
        consentVersion,
        consentedAt: this.now().toISOString()
      };
      this.store.saveManagedMetadata(server.id, metadata);
    } else if (entry) {
      // 幂等检查：已连接且启用 → 直接返回
      if (server.enabled && entry.state.status === 'connected') {
        return this.toPublicServer(entry);
      }

      // 检查 consent version
      const metadata = this.store.getManagedMetadata(server.id);
      if (metadata && metadata.consentVersion < preset.consentVersion) {
        throw new Error('Consent version outdated, re-confirmation required');
      }
    }

    if (!entry) throw new Error('Failed to create server entry');

    // 测试连接
    await this.testServer(server.id);

    // 启用
    await this.setEnabled(server.id, true);

    // 等待 connected（30秒超时，500ms 轮询）
    const timeoutMs = 30_000;
    const pollIntervalMs = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const current = this.getServer(server.id);
      if (!current) throw new Error('Server deleted during enable');

      if (current.status === 'connected') return current;
      if (current.status === 'error' || current.status === 'unavailable') {
        throw new Error(`Enable failed: ${current.lastError || 'Connection unavailable'}`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error('Preset enable timeout after 30 seconds');
  }

  async disablePreset(presetId: string): Promise<McpPublicServer> {
    const preset = getPresetById(presetId);
    if (!preset) throw new Error(`Unknown preset: ${presetId}`);

    const server = this.store.findServerByPresetId(presetId);
    if (!server) {
      throw new Error(`Preset ${presetId} is not installed`);
    }

    return this.setEnabled(server.id, false);
  }

  getManagedMetadata(serverId: string): McpManagedMetadata | undefined {
    return this.store.getManagedMetadata(serverId);
  }

  private hydratePersistedState() {
    for (const config of this.store.listServers()) this.ensureEntry(config);
    for (const tool of this.store.listTools()) this.upsertRuntimeTool(tool);
  }

  private ensureEntry(config: McpServerConfig): Entry {
    const existing = this.entries.get(config.id);
    if (existing) return existing;
    const persistedState = this.store.getServerState?.(config.id);
    const initialState: McpServerState = persistedState ?? { status: config.enabled ? 'connecting' : 'disabled' };
    if (config.enabled && initialState.status === 'connected') initialState.status = 'connecting';
    if (!config.enabled && initialState.status === 'connected') initialState.status = 'disabled';
    const entry: Entry = {
      config,
      state: initialState,
      backoffAttempt: 0,
      validated: Boolean(persistedState?.lastRefreshedAt),
      generation: 0
    };
    if (config.credentialUnavailable) entry.state = { ...entry.state, status: 'credential_unavailable' };
    this.entries.set(config.id, entry);
    return entry;
  }

  private requireEntry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown MCP server: ${id}`);
    return entry;
  }

  private async connectEntry(entry: Entry, forTest: boolean): Promise<void> {
    if (this.stopped && !forTest) return;
    if (!forTest && !entry.config.enabled) return;
    if (entry.config.transport === 'stdio' && !isLoopbackHost(this.host)) {
      entry.state = {
        status: 'unavailable',
        lastError: 'stdio MCP servers require a loopback backend host',
        ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
      };
      this.store.setServerState(entry.config.id, entry.state);
      if (forTest) throw new Error(entry.state.lastError);
      return;
    }
    if (entry.config.credentialUnavailable) {
      entry.state = {
        status: 'credential_unavailable',
        lastError: 'MCP credentials are unavailable',
        ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
      };
      this.store.setServerState(entry.config.id, entry.state);
      return;
    }
    const generation = entry.generation;
    if (entry.refreshPromise) await entry.refreshPromise;
    if (entry.generation !== generation || this.entries.get(entry.config.id) !== entry) return;
    entry.state = {
      status: 'connecting',
      ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
    };
    this.store.setServerState(entry.config.id, entry.state);
    let connection: McpConnection | undefined;
    try {
      connection = await this.adapterFactory(entry.config, {
        onToolsChanged: () => {
          if (entry.generation === generation) this.scheduleRefresh(entry);
        },
        onClosed: (error) => {
          if (this.stopped || entry.connection !== connection) return;
          entry.connection = undefined;
          entry.state = {
            status: 'unavailable',
            lastError: error?.message ?? 'MCP connection closed',
            ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
          };
          this.store.setServerState(entry.config.id, entry.state);
          this.scheduleReconnect(entry);
        },
        onOAuthState: (oauth) => {
          if (entry.generation !== generation || this.entries.get(entry.config.id) !== entry) return;
          // Saving the whole config invokes encryption in the store. The API
          // never receives this object, and no secret is logged here.
          entry.config = this.store.saveServer({ ...entry.config, oauth, enabled: entry.config.enabled });
          if (entry.config.credentialUnavailable) {
            entry.state = {
              status: 'credential_unavailable',
              lastError: 'MCP credentials are unavailable',
              ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
            };
            this.store.setServerState(entry.config.id, entry.state);
          }
        },
        getOAuthState: () => this.store.getServer(entry.config.id)?.oauth
      });
      if ((this.stopped && !forTest) || this.entries.get(entry.config.id) !== entry || entry.generation !== generation) {
        await connection.close().catch(() => undefined);
        return;
      }
      entry.connection = connection;
      entry.backoffAttempt = 0;
      await this.refreshEntry(entry);
      if (entry.generation !== generation || this.entries.get(entry.config.id) !== entry) {
        await connection.close().catch(() => undefined);
        return;
      }
    } catch (error) {
      const authorization = asAuthorizationRequired(error);
      if (authorization) {
        if (entry.config.credentialUnavailable) {
          entry.connection = undefined;
          await authorization.connection?.close().catch(() => undefined);
          entry.state = {
            status: 'credential_unavailable',
            lastError: 'MCP credentials are unavailable',
            ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
          };
          this.store.setServerState(entry.config.id, entry.state);
          return;
        }
        entry.connection = authorization.connection;
        entry.state = {
          status: 'authorization_required',
          ...(authorization.authorizationUrl ? { authorizationUrl: authorization.authorizationUrl } : {}),
          lastError: messageOf(error),
          ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
        };
        this.store.setServerState(entry.config.id, entry.state);
        throw error;
      }
      const failedConnection = entry.connection;
      entry.connection = undefined;
      await failedConnection?.close().catch(() => undefined);
      entry.state = {
        status: 'unavailable',
        lastError: messageOf(error),
        ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
      };
      this.store.setServerState(entry.config.id, entry.state);
      if (!forTest) this.scheduleReconnect(entry);
      if (forTest) throw error;
    }
  }

  private async refreshEntry(entry: Entry): Promise<void> {
    if (entry.refreshPromise) return entry.refreshPromise;
    const connection = entry.connection;
    if (!connection) return;
    const generation = entry.generation;
    entry.refreshPromise = (async () => {
      try {
        const page = await connection.listTools();
        // A configuration edit, shutdown, or close callback can invalidate a
        // list request while it is in flight. Never let that stale response
        // replace the LKG schema for the new generation.
        if (!this.isCurrentConnection(entry, connection, generation)) return;
        this.applyToolPage(entry.config.id, page.tools);
        const refreshedAt = this.now().toISOString();
        entry.state = {
          status: entry.config.enabled ? 'connected' : 'connected',
          lastRefreshedAt: refreshedAt
        };
        this.store.setServerState(entry.config.id, entry.state);
      } catch (error) {
        if (!this.isCurrentConnection(entry, connection, generation)) return;
        const authorization = asAuthorizationRequired(error);
        if (authorization) {
          entry.state = {
            status: 'authorization_required',
            authorizationUrl: authorization.authorizationUrl,
            lastError: messageOf(error),
            ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
          };
        } else {
          entry.state = {
            status: 'unavailable',
            lastError: messageOf(error),
            ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
          };
        }
        this.store.setServerState(entry.config.id, entry.state);
        // Keep the last-known-good schemas untouched. A refresh failure is
        // intentionally not a tombstone event.
        if (authorization?.connection) {
          entry.connection = authorization.connection;
        } else {
          const failedConnection = entry.connection;
          entry.connection = undefined;
          await failedConnection?.close().catch(() => undefined);
          this.scheduleReconnect(entry);
        }
        throw error;
      } finally {
        entry.refreshPromise = undefined;
      }
    })();
    return entry.refreshPromise;
  }

  private isCurrentConnection(entry: Entry, connection: McpConnection, generation: number) {
    return entry.generation === generation
      && entry.connection === connection
      && this.entries.get(entry.config.id) === entry;
  }

  private applyToolPage(serverId: string, descriptors: McpToolDescriptor[]) {
    const existing = this.store.listTools(serverId);
    const byName = new Map(existing.map((tool) => [tool.remoteName, tool]));
    const seen = new Set<string>();
    const invalid = new Set<string>();
    let nextOrdinal = existing.reduce((max, tool) => Math.max(max, tool.ordinal), 0) + 1;
    for (const descriptor of descriptors) {
      if (!descriptor.name) continue;
      const previous = byName.get(descriptor.name);
      const modelName = previous?.modelName ?? stableToolName(serverId, descriptor.name);
      const inputSchema = descriptor.inputSchema ?? previous?.inputSchema ?? { type: 'object', properties: {} };
      const schemaResult = this.schemaValidator.compile(modelName, inputSchema);
      if (!schemaResult.schemaValid) {
        invalid.add(descriptor.name);
        continue;
      }
      seen.add(descriptor.name);
      this.schemaErrors.delete(modelName);
      const tool: McpToolRecord = {
        serverId,
        remoteName: descriptor.name,
        modelName,
        ordinal: previous?.ordinal ?? nextOrdinal++,
        description: descriptor.description ?? previous?.description ?? '',
        inputSchema: normalizeSchema(inputSchema),
        ...(descriptor.annotations ?? previous?.annotations
          ? { annotations: descriptor.annotations ?? previous?.annotations }
          : {}),
        tombstone: false,
        definitionHash: mcpToolDefinitionHash(
          modelName,
          descriptor.description ?? previous?.description ?? '',
          normalizeSchema(inputSchema)
        ),
        lastSeenAt: this.now().toISOString()
      };
      this.store.upsertTool(tool);
      this.upsertRuntimeTool(tool);
    }
    for (const previous of existing) {
      if (seen.has(previous.remoteName) || invalid.has(previous.remoteName) || previous.tombstone) continue;
      const tombstone = { ...previous, tombstone: true };
      this.store.upsertTool(tombstone);
      this.upsertRuntimeTool(tombstone);
    }
  }

  private upsertRuntimeTool(tool: McpToolRecord) {
    const schemaResult = this.schemaValidator.compile(tool.modelName, tool.inputSchema);
    if (!schemaResult.schemaValid && schemaResult.reason) this.schemaErrors.set(tool.modelName, schemaResult.reason);
    if (schemaResult.schemaValid) this.schemaErrors.delete(tool.modelName);
    const module: ToolModule = {
      label: tool.remoteName,
      exposedToModel: true,
      source: 'mcp',
      annotations: tool.annotations,
      definition: {
        type: 'function',
        function: {
          name: tool.modelName,
          description: tool.description,
          parameters: normalizeSchema(tool.inputSchema)
        }
      },
      availability: () => this.toolAvailability(tool.serverId, tool.modelName),
      sourceInfo: {
        serverId: tool.serverId,
        serverName: this.entries.get(tool.serverId)?.config.name,
        remoteName: tool.remoteName
      },
      execute: async (args: unknown, context?: ToolContext) => this.executeTool(tool.serverId, tool.remoteName, args, context)
    };
    this.runtime.upsert?.(module);
  }

  private toolAvailability(serverId: string, modelName: string) {
    const entry = this.entries.get(serverId);
    const tool = this.store.listTools(serverId).find((candidate) => candidate.modelName === modelName);
    if (!entry || !tool) return { status: 'unavailable' as const, reason: 'MCP tool was removed', retryable: true };
    if (tool.tombstone) return { status: 'unavailable' as const, reason: 'MCP tool is no longer offered', retryable: false };
    if (this.schemaErrors.has(modelName)) {
      return {
        status: 'unavailable' as const,
        reason: `MCP tool schema is invalid: ${this.schemaErrors.get(modelName)}`,
        retryable: false
      };
    }
    if (entry.state.status !== 'connected') {
      return {
        status: 'unavailable' as const,
        reason: entry.state.lastError ?? `MCP server is ${entry.state.status}`,
        retryable: entry.state.status !== 'disabled'
      };
    }
    return { status: 'available' as const };
  }

  private async executeTool(serverId: string, remoteName: string, args: unknown, context?: ToolContext) {
    const entry = this.entries.get(serverId);
    const connection = entry?.connection;
    const tool = this.store.listTools(serverId).find((candidate) => candidate.remoteName === remoteName);
    if (tool) {
      const validation = this.schemaValidator.validate(tool.modelName, tool.inputSchema, args);
      if (!validation.schemaValid) {
        throw new ToolExecutionError({
          code: 'unavailable',
          message: `MCP tool schema is invalid: ${remoteName}`,
          retryable: false,
          reason: validation.reason
        });
      }
      if (!validation.valid) {
        throw new ToolExecutionError({
          code: 'invalid_arguments',
          message: `Invalid arguments for MCP tool: ${remoteName}`,
          retryable: false,
          reason: validation.reason
        });
      }
    }
    if (!entry || !connection) {
      throw new ToolExecutionError({
        code: 'unavailable',
        message: `MCP server is unavailable for ${remoteName}`,
        retryable: true
      });
    }
    try {
      const result = await connection.callTool(remoteName, args, context?.signal);
      if (result.isError) {
        throw new ToolExecutionError({
          code: 'tool_rejected',
          message: `MCP tool rejected the call: ${remoteName}`,
          retryable: false
        });
      }
      return normalizeResult(result);
    } catch (error) {
      if (error instanceof ToolExecutionError) throw error;
      const authorization = asAuthorizationRequired(error);
      if (authorization) {
        entry.state = {
          status: 'authorization_required',
          ...(authorization.authorizationUrl ? { authorizationUrl: authorization.authorizationUrl } : {}),
          lastError: messageOf(error),
          ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
        };
        this.store.setServerState(serverId, entry.state);
        throw new ToolExecutionError({ code: 'unavailable', message: messageOf(error), retryable: true });
      }
      entry.state = {
        status: 'unavailable',
        lastError: messageOf(error),
        ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {})
      };
      this.store.setServerState(serverId, entry.state);
      throw new ToolExecutionError({ code: 'execution_failed', message: messageOf(error), retryable: true });
    }
  }

  private scheduleRefresh(entry: Entry) {
    if (this.stopped || !entry.connection) return;
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
    entry.refreshTimer = setTimeout(() => {
      entry.refreshTimer = undefined;
      void this.refreshEntry(entry).catch(() => undefined);
    }, this.listChangedDebounceMs);
  }

  private scheduleReconnect(entry: Entry, jitter = true) {
    if (this.stopped || !entry.config.enabled || entry.reconnectTimer) return;
    const exponent = Math.min(entry.backoffAttempt++, 8);
    const base = Math.min(30_000, this.reconnectBaseMs * 2 ** exponent);
    const delay = jitter ? Math.round(base * (0.8 + Math.random() * 0.4)) : base;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      void this.connectEntry(entry, false);
    }, delay);
  }

  private async disconnectEntry(entry: Entry) {
    entry.generation += 1;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
    entry.reconnectTimer = undefined;
    entry.refreshTimer = undefined;
    const connection = entry.connection;
    entry.connection = undefined;
    if (connection) await connection.close().catch(() => undefined);
  }

  private toPublicServer(entry: Entry): McpPublicServer {
    const tools = this.store.listTools(entry.config.id).map((tool) => ({
      remoteName: tool.remoteName,
      modelName: tool.modelName,
      ordinal: tool.ordinal,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      tombstone: tool.tombstone,
      ...(tool.lastSeenAt ? { lastSeenAt: tool.lastSeenAt } : {})
    }));
    return {
      id: entry.config.id,
      name: entry.config.name,
      transport: entry.config.transport,
      enabled: entry.config.enabled,
      status: entry.state.status,
      ...(entry.state.lastError ? { lastError: entry.state.lastError } : {}),
      ...(entry.state.lastRefreshedAt ? { lastRefreshedAt: entry.state.lastRefreshedAt } : {}),
      ...(entry.state.authorizationUrl ? { authorizationUrl: entry.state.authorizationUrl } : {}),
      tools,
      hasCredentials: hasStoredCredentials(entry.config),
      ...(entry.config.url ? { url: redactUrl(entry.config.url) } : {}),
      ...(entry.config.command ? { command: entry.config.command } : {}),
      ...(entry.config.args ? { args: entry.config.args } : {}),
      ...(entry.config.cwd ? { cwd: entry.config.cwd } : {}),
      authMode: entry.config.authMode,
      ...(entry.config.headers ? { headerNames: Object.keys(entry.config.headers) } : {})
    };
  }

  private assertTransportAllowed(config: McpServerConfig) {
    if (config.transport === 'stdio' && !isLoopbackHost(this.host)) {
      throw new Error('stdio MCP servers require a loopback backend host');
    }
  }
}

export function createMcpManager(options: McpManagerOptions): McpManager {
  return new McpManagerImpl(options);
}

export const createMcpRuntimeManager = createMcpManager;

export function stableToolName(serverId: string, remoteName: string): string {
  const clean = remoteName.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  const hash = createHash('sha256').update(`${serverId}:${remoteName}`).digest('hex').slice(0, 10);
  const prefix = `mcp__${shortId(serverId)}__`;
  const suffix = `__${hash}`;
  return `${prefix}${clean.slice(0, Math.max(1, 64 - prefix.length - suffix.length))}${suffix}`.slice(0, 64);
}

export function normalizeResult(result: { content?: Array<Record<string, unknown>>; structuredContent?: unknown }): McpNormalizedResult {
  const MAX_SIZE = 1_000_000; // 1MB

  // 先检查整体大小
  const resultJson = JSON.stringify(result);
  if (resultJson.length > MAX_SIZE) {
    console.warn(`MCP result truncated: ${resultJson.length} bytes > ${MAX_SIZE} bytes`);
    return {
      text: resultJson.substring(0, MAX_SIZE) + '\n\n[结果已截断：输出超过 1MB 限制]'
    };
  }

  const textParts: string[] = [];
  const metadata: Array<Record<string, unknown>> = [];
  const unsupported: Array<Record<string, unknown>> = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text' && typeof item.text === 'string') {
      textParts.push(item.text);
      continue;
    }
    if (item.type === 'image' || item.type === 'audio' || item.type === 'resource' || item.type === 'resource_link') {
      const nestedResource = item.type === 'resource' && item.resource && typeof item.resource === 'object'
        ? item.resource as Record<string, unknown>
        : undefined;
      metadata.push({
        type: item.type,
        ...(item.name ? { name: item.name } : {}),
        ...(item.description ? { description: item.description } : {}),
        ...(item.size !== undefined ? { size: item.size } : {}),
        ...((item.mimeType ?? nestedResource?.mimeType) ? { mimeType: item.mimeType ?? nestedResource?.mimeType } : {}),
        ...((item.uri ?? nestedResource?.uri) ? { uri: item.uri ?? nestedResource?.uri } : {})
      });
      continue;
    }
    unsupported.push({ type: item.type ?? 'unknown', summary: 'Unsupported MCP content block' });
  }
  return {
    ...(textParts.length ? { text: textParts.join('\n') } : {}),
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(metadata.length ? { metadata } : {}),
    ...(unsupported.length ? { unsupported } : {})
  };
}

export const normalizeMcpToolResult = normalizeResult;
export const stableMcpToolName = stableToolName;

function normalizeSchema(schema: Record<string, unknown> | undefined): JsonSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  return { ...schema, type: 'object' };
}

function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || 'server';
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function hasConnectionConfigChanged(before: McpServerConfig, after: McpServerConfig): boolean {
  const connectionConfig = (config: McpServerConfig) => {
    const { id: _id, name: _name, enabled: _enabled, credentialUnavailable: _credentialUnavailable, ...rest } = config;
    return rest;
  };
  return stableStringify(connectionConfig(before)) !== stableStringify(connectionConfig(after));
}

/**
 * Merge a public update without making omitted secrets destructive. Explicit
 * transport/auth-mode changes clear credentials that no longer apply, while an
 * OAuth field edit preserves tokens, PKCE data, and DCR client information.
 */
function normalizeServerUpdate(
  current: McpServerConfig,
  draft: Partial<McpServerDraft>
): Partial<McpServerDraft> {
  const next: Partial<McpServerDraft> = { ...draft };
  const transport = draft.transport ?? current.transport;

  if (transport !== current.transport) {
    if (transport === 'stdio') {
      Object.assign(next, {
        url: '',
        authMode: 'none' as const,
        headers: {},
        oauth: {}
      });
    } else {
      Object.assign(next, {
        command: '',
        args: [],
        cwd: '',
        env: {}
      });
    }
  }

  // stdio has no HTTP authentication surface. This also prevents a partial
  // edit that only changes authMode from leaving stale HTTP secrets attached.
  if (transport === 'stdio') {
    next.authMode = 'none';
    next.headers = {};
    next.oauth = {};
    return next;
  }

  const authMode = (next.authMode ?? current.authMode) as McpServerConfig['authMode'];
  if (authMode === 'none') {
    // An explicit none transition is a real clear operation, even if the
    // caller omits headers. Non-empty headers are normalized back to headers
    // by the store, preserving the simple none-with-headers policy.
    if (draft.authMode !== undefined || current.authMode !== 'none') {
      if (draft.headers !== undefined || current.headers) next.headers = draft.headers ?? {};
      if (draft.oauth !== undefined || current.oauth || current.authMode === 'oauth') next.oauth = {};
    }
  } else if (authMode === 'headers') {
    if (draft.oauth !== undefined || current.authMode === 'oauth' || current.oauth) next.oauth = {};
  } else {
    const suppliedHeaders = draft.headers ?? current.headers;
    if (suppliedHeaders) next.headers = stripAuthorizationHeader(suppliedHeaders);
    const mergedOauth = mergeOAuthConfig(current.oauth, draft.oauth);
    if (mergedOauth) next.oauth = mergedOauth;
  }
  return next;
}

function mergeOAuthConfig(
  current: McpServerConfig['oauth'] | undefined,
  update: McpServerDraft['oauth'] | undefined
): McpServerDraft['oauth'] | undefined {
  if (current === undefined && update === undefined) return undefined;
  const merged = { ...(current ?? {}), ...(update ?? {}) } as NonNullable<McpServerDraft['oauth']>;
  for (const key of ['tokens', 'clientInformation', 'discoveryState'] as const) {
    const previous = current?.[key];
    const next = update?.[key];
    if (isRecord(previous) && isRecord(next)) merged[key] = { ...previous, ...next };
  }
  return merged;
}

function stripAuthorizationHeader(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization')
  );
}

function hasStoredCredentials(config: McpServerConfig): boolean {
  if (config.credentialUnavailable) return true;
  if (config.headers && Object.keys(config.headers).length > 0) return true;
  if (config.env && Object.keys(config.env).length > 0) return true;
  const oauth = config.oauth;
  if (!oauth) return false;
  return Boolean(
    oauth.clientId
    || oauth.clientSecret
    || (oauth.tokens && Object.keys(oauth.tokens).length > 0)
    || (oauth.clientInformation && Object.keys(oauth.clientInformation).length > 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(',')}}`;
}

function isAuthorizationRequired(error: unknown): error is McpAuthorizationRequired {
  return asAuthorizationRequired(error) !== undefined;
}

function asAuthorizationRequired(error: unknown): McpAuthorizationRequired | undefined {
  return error && typeof error === 'object' && (error as { code?: unknown }).code === 'authorization_required'
    ? error as McpAuthorizationRequired
    : undefined;
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s)]+/g, (url) => redactUrl(url));
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    const hadUserInfo = Boolean(url.username || url.password);
    const sensitiveKeys = [...url.searchParams.keys()].filter((key) => /(token|secret|password|passwd|authorization|api[-_]?key)/i.test(key));
    if (!hadUserInfo && sensitiveKeys.length === 0) return value;
    url.username = '';
    url.password = '';
    for (const key of sensitiveKeys) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return '[invalid URL]';
  }
}
