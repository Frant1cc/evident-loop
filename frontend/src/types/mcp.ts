export type McpServerStatus =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'unavailable'
  | 'authorization_required'
  | 'credential_unavailable'
  | 'error';

export type McpTransport = 'stdio' | 'http';
export type McpAuthMode = 'none' | 'headers' | 'oauth';

export type McpOAuthInput = {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
};

export type McpServerDraft = {
  id?: string;
  name: string;
  transport: McpTransport;
  /** The API also accepts `type` as an alias for transport. */
  type?: McpTransport;
  enabled?: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  authMode: McpAuthMode;
  headers?: Record<string, string>;
  oauth?: McpOAuthInput;
};

export type McpTool = {
  remoteName: string;
  modelName: string;
  ordinal: number;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  tombstone: boolean;
  lastSeenAt?: string;
};

export type McpServer = {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  status: McpServerStatus;
  lastError?: string;
  lastRefreshedAt?: string;
  authorizationUrl?: string;
  tools: McpTool[];
  hasCredentials: boolean;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  authMode: McpAuthMode;
  headerNames?: string[];
};

export function isMcpToolReadOnly(tool: McpTool) {
  return tool.annotations?.readOnlyHint === true;
}
