import type { ToolModule, ToolRuntime } from '../tools/contracts.js';
import type { McpManagedMetadata, McpPresetPublic } from './presets/index.js';

/** The lifecycle states intentionally describe management state, not transport details. */
export type McpServerStatus =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'unavailable'
  | 'authorization_required'
  | 'credential_unavailable'
  | 'error';

export type McpTransportKind = 'stdio' | 'http';
export type McpAuthMode = 'none' | 'headers' | 'oauth';

export type McpOAuthConfig = {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
  tokens?: Record<string, unknown>;
  clientInformation?: Record<string, unknown>;
  state?: string;
  codeVerifier?: string;
  discoveryState?: Record<string, unknown>;
};

/**
 * This is the decrypted, process-local configuration. It must never be sent from
 * an HTTP route. The store is the only component that persists sensitive members.
 */
export type McpServerConfig = {
  id: string;
  name: string;
  transport: McpTransportKind;
  enabled: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  authMode: McpAuthMode;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  /** Set when an encrypted field could not be read with the current key. */
  credentialUnavailable?: boolean;
};

export type McpServerDraft = Omit<McpServerConfig, 'id'> & { id?: string };

export type McpToolRecord = {
  serverId: string;
  remoteName: string;
  modelName: string;
  ordinal: number;
  description: string;
  inputSchema: Record<string, unknown>;
  /** SHA-256 of the model-visible name, description, and input schema. */
  definitionHash?: string;
  annotations?: Record<string, unknown>;
  tombstone: boolean;
  lastSeenAt?: string;
};

export type McpPublicTool = Omit<McpToolRecord, 'serverId' | 'inputSchema' | 'definitionHash'> & {
  inputSchema?: Record<string, unknown>;
};

export type McpPublicServer = {
  id: string;
  name: string;
  transport: McpTransportKind;
  enabled: boolean;
  status: McpServerStatus;
  lastError?: string;
  lastRefreshedAt?: string;
  authorizationUrl?: string;
  tools: McpPublicTool[];
  /** True when persisted auth material exists, without revealing its value. */
  hasCredentials: boolean;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  authMode: McpAuthMode;
  headerNames?: string[];
};

export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type McpToolPage = {
  tools: McpToolDescriptor[];
  nextCursor?: string;
};

export type McpContent =
  | { type: 'text'; text: string; [key: string]: unknown }
  | { type: 'image'; mimeType?: string; [key: string]: unknown }
  | { type: 'audio'; mimeType?: string; [key: string]: unknown }
  | { type: 'resource'; uri?: string; mimeType?: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export type McpToolResult = {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

export type McpNormalizedResult = {
  text?: string;
  structuredContent?: unknown;
  metadata?: Array<Record<string, unknown>>;
  unsupported?: Array<Record<string, unknown>>;
};

export type McpAdapterCallbacks = {
  onToolsChanged?: () => void;
  onClosed?: (error?: Error) => void;
  onOAuthState?: (state: McpOAuthConfig) => void;
  /**
   * Returns the latest decrypted OAuth state from the durable store. OAuth
   * callbacks may arrive after the adapter's original config object has been
   * replaced or rebuilt, so the SDK provider must be able to rehydrate its
   * client information and PKCE state before exchanging a code.
   */
  getOAuthState?: () => McpOAuthConfig | undefined;
};

export type McpAuthorizationRequired = Error & {
  code: 'authorization_required';
  authorizationUrl?: string;
  state?: string;
  connection?: McpConnection;
};

export type McpConnection = {
  listTools: () => Promise<McpToolPage>;
  callTool: (name: string, args: unknown, signal?: AbortSignal) => Promise<McpToolResult>;
  close: () => Promise<void>;
  authorizationUrl?: () => string | undefined;
  finishAuth?: (code: string, state?: string) => Promise<void>;
  refreshAuth?: () => Promise<void>;
};

export type McpAdapterFactory = (
  config: McpServerConfig,
  callbacks: McpAdapterCallbacks
) => Promise<McpConnection>;

export type McpStore = {
  ensureSchema: () => void;
  listServers: () => McpServerConfig[];
  getServer: (id: string) => McpServerConfig | undefined;
  getServerState?: (id: string) => McpServerState | undefined;
  saveServer: (draft: McpServerDraft) => McpServerConfig;
  deleteServer: (id: string) => void;
  setServerState: (id: string, state: Partial<Pick<McpServerState, 'status' | 'lastError' | 'lastRefreshedAt' | 'authorizationUrl'>>) => void;
  listTools: (serverId?: string) => McpToolRecord[];
  upsertTool: (tool: McpToolRecord) => void;
  deleteTools: (serverId: string) => void;
  saveManagedMetadata: (serverId: string, metadata: McpManagedMetadata) => void;
  getManagedMetadata: (serverId: string) => McpManagedMetadata | undefined;
  findServerByPresetId: (presetId: string) => McpServerConfig | undefined;
};

export type McpServerState = {
  status: McpServerStatus;
  lastError?: string;
  lastRefreshedAt?: string;
  authorizationUrl?: string;
};

export type McpManagerOptions = {
  runtime: ToolRuntime;
  store?: McpStore;
  adapterFactory?: McpAdapterFactory;
  host?: string;
  port?: number;
  reconnectBaseMs?: number;
  listChangedDebounceMs?: number;
  now?: () => Date;
};

export type McpManager = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  listServers: () => McpPublicServer[];
  getServer: (id: string) => McpPublicServer | undefined;
  saveServer: (draft: McpServerDraft) => McpPublicServer;
  updateServer: (id: string, draft: Partial<McpServerDraft>) => McpPublicServer;
  testServer: (id: string) => Promise<McpPublicServer>;
  setEnabled: (id: string, enabled: boolean) => Promise<McpPublicServer>;
  refresh: (id: string) => Promise<McpPublicServer>;
  authorize: (id: string, code: string, state?: string) => Promise<McpPublicServer>;
  getServerIdForOAuthState?: (state: string) => string | undefined;
  deleteServer: (id: string) => Promise<void>;
  getToolModules: () => ToolModule[];
  listPresets: () => McpPresetPublic[];
  enablePreset: (presetId: string, consentVersion: number) => Promise<McpPublicServer>;
  disablePreset: (presetId: string) => Promise<McpPublicServer>;
  getManagedMetadata: (serverId: string) => McpManagedMetadata | undefined;
};
