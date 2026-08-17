import { randomBytes } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type {
  McpAdapterCallbacks,
  McpAdapterFactory,
  McpAuthorizationRequired,
  McpConnection,
  McpOAuthConfig,
  McpServerConfig,
  McpToolPage,
  McpToolResult
} from '../contracts.js';

export type SdkAdapterOptions = {
  host?: string;
  port?: number;
  fetch?: FetchLike;
  /**
   * Narrow test seam for the SDK transport boundary. It runs immediately
   * before StreamableHTTPClientTransport.finishAuth, without calling any
   * provider getter that could hide a missing rehydration.
   */
  onOAuthFinishAuth?: (oauth: McpOAuthConfig) => void;
};

type OAuthProviderHandle = {
  provider: OAuthClientProvider;
  oauth: McpOAuthConfig;
  rehydrate: (persisted?: McpOAuthConfig) => void;
};

/**
 * SDK-facing code is deliberately isolated in this adapter. No SDK class or
 * result type crosses the neutral MCP manager boundary.
 */
export function createSdkAdapterFactory(options: SdkAdapterOptions = {}): McpAdapterFactory {
  return async (config, callbacks) => {
    if (config.transport === 'stdio') return createStdioConnection(config, callbacks, options);
    return createHttpConnection(config, callbacks, options);
  };
}

export const createMcpClientAdapter = createSdkAdapterFactory;

async function createStdioConnection(
  config: McpServerConfig,
  callbacks: McpAdapterCallbacks,
  options: SdkAdapterOptions
): Promise<McpConnection> {
  if (!isLoopbackHost(options.host?.trim() || process.env.HOST?.trim() || '127.0.0.1')) {
    throw new Error('stdio MCP servers require a loopback backend host');
  }
  if (!config.command) throw new Error('stdio command is required');

  const transport = new StdioClientTransport({
    command: config.command,
    ...(config.args ? { args: config.args } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.env ? { env: config.env } : {})
  });
  const client = createClient(callbacks);
  transport.onclose = () => callbacks.onClosed?.();
  transport.onerror = (error) => callbacks.onClosed?.(error);
  await client.connect(transport);
  return createConnection(client, transport, callbacks);
}

async function createHttpConnection(
  config: McpServerConfig,
  callbacks: McpAdapterCallbacks,
  options: SdkAdapterOptions
): Promise<McpConnection> {
  if (!config.url) throw new Error('HTTP MCP URL is required');
  const userHeaders = config.headers ?? {};
  const authMode = config.authMode === 'none' && Object.keys(userHeaders).length > 0 ? 'headers' : config.authMode;
  rejectAuthorizationHeader(userHeaders, authMode);

  let provider: OAuthClientProvider | undefined;
  let oauthState: McpOAuthConfig | undefined;
  let rehydrateOAuth: ((persisted?: McpOAuthConfig) => void) | undefined;
  let latestAuthorizationUrl: string | undefined;
  if (authMode === 'oauth') {
    const oauthProvider = createOAuthProvider(config, callbacks, (url) => {
      latestAuthorizationUrl = url;
    }, options);
    provider = oauthProvider.provider;
    oauthState = oauthProvider.oauth;
    rehydrateOAuth = oauthProvider.rehydrate;
  }

  let client!: Client;
  let transport!: StreamableHTTPClientTransport;
  let closed = false;
  let suppressClose = false;

  const createConnectedClient = async () => {
    transport = new StreamableHTTPClientTransport(new URL(config.url!), {
      ...(provider ? { authProvider: provider } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      requestInit: { headers: userHeaders },
      reconnectionOptions: {
        initialReconnectionDelay: 500,
        maxReconnectionDelay: 10_000,
        reconnectionDelayGrowFactor: 1.8,
        maxRetries: 1
      }
    });
    transport.onclose = () => {
      if (!closed && !suppressClose) callbacks.onClosed?.();
    };
    transport.onerror = (error) => {
      if (!closed && !suppressClose) callbacks.onClosed?.(error);
    };
    client = createClient(callbacks);
    await client.connect(transport);
  };

  const connection: McpConnection = {
    listTools: async () => {
      try {
        let cursor: string | undefined;
        const tools: McpToolPage['tools'] = [];
        do {
          const result = await client.listTools(cursor ? { cursor } : undefined);
          tools.push(...result.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema as Record<string, unknown>,
            ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {})
          })));
          cursor = result.nextCursor;
        } while (cursor);
        return { tools };
      } catch (error) {
        if (isUnauthorized(error) && provider) {
          throw authorizationRequired(latestAuthorizationUrl, config.oauth?.state, connection);
        }
        throw error;
      }
    },
    callTool: async (name, args, signal) => {
      try {
        const result = await client.callTool({ name, arguments: toArguments(args) }, undefined, signal ? { signal } : undefined);
        return result as unknown as McpToolResult;
      } catch (error) {
        if (isUnauthorized(error) && provider) {
          throw authorizationRequired(latestAuthorizationUrl, config.oauth?.state, connection);
        }
        throw error;
      }
    },
    close: async () => {
      closed = true;
      await client.close().catch(() => undefined);
    },
    authorizationUrl: () => latestAuthorizationUrl,
    finishAuth: async (code, state) => {
      if (!provider) throw new Error('OAuth is not enabled for this MCP server');
      const persistedOAuth = callbacks.getOAuthState?.();
      const expectedState = persistedOAuth?.state ?? config.oauth?.state;
      if (expectedState && (!state || !matchesState(expectedState, state))) {
        throw new Error('OAuth state mismatch');
      }
      // The SDK calls authProvider.clientInformation() from transport.finishAuth,
      // but a callback can outlive the adapter's original config object. Restore
      // the provider's actual closure state before entering the SDK boundary;
      // relying on a getter here makes this lifecycle race invisible to tests
      // and to SDK implementations that inspect provider state eagerly.
      rehydrateOAuth?.(persistedOAuth);
      if (oauthState) options.onOAuthFinishAuth?.(oauthState);
      if (transport) await transport.finishAuth(code);
      suppressClose = true;
      await client.close().catch(() => undefined);
      suppressClose = false;
      await createConnectedClient();
      latestAuthorizationUrl = undefined;
      if (config.oauth) {
        config.oauth.state = undefined;
        config.oauth.codeVerifier = undefined;
        callbacks.onOAuthState?.(config.oauth);
      }
    },
    refreshAuth: async () => {
      if (!provider) return;
      const result = await auth(provider, {
        serverUrl: new URL(config.url!),
        ...(options.fetch ? { fetchFn: withHeaders(options.fetch, userHeaders) } : {})
      });
      if (result !== 'AUTHORIZED') {
        throw authorizationRequired(latestAuthorizationUrl, config.oauth?.state, connection);
      }
      suppressClose = true;
      await client.close().catch(() => undefined);
      suppressClose = false;
      await createConnectedClient();
    }
  };

  try {
    if (provider && config.oauth?.tokens?.refresh_token) {
      const refreshed = await auth(provider, {
        serverUrl: new URL(config.url!),
        ...(options.fetch ? { fetchFn: withHeaders(options.fetch, userHeaders) } : {})
      });
      if (refreshed !== 'AUTHORIZED') {
        throw authorizationRequired(latestAuthorizationUrl, config.oauth?.state, connection);
      }
    }
    await createConnectedClient();
    return connection;
  } catch (error) {
    if (isUnauthorized(error) && provider) {
      await client?.close().catch(() => undefined);
      throw authorizationRequired(latestAuthorizationUrl, config.oauth?.state, connection);
    }
    if (!closed) await transport?.close().catch(() => undefined);
    throw error;
  }
}

function createClient(callbacks: McpAdapterCallbacks) {
  return new Client(
    { name: 'evident-loop', version: '0.1.0' },
    {
      capabilities: {},
      listChanged: {
        tools: {
          autoRefresh: false,
          debounceMs: 0,
          onChanged: (error) => {
            if (!error) callbacks.onToolsChanged?.();
          }
        }
      }
    }
  );
}

function createConnection(
  client: Client,
  transport: StdioClientTransport,
  callbacks: McpAdapterCallbacks
): McpConnection {
  const connection: McpConnection = {
    listTools: async () => {
      let cursor: string | undefined;
      const tools: McpToolPage['tools'] = [];
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...result.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema as Record<string, unknown>,
          ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {})
        })));
        cursor = result.nextCursor;
      } while (cursor);
      return { tools };
    },
    callTool: async (name, args, signal) => {
      const result = await client.callTool({ name, arguments: toArguments(args) }, undefined, signal ? { signal } : undefined);
      return result as unknown as McpToolResult;
    },
    close: async () => {
      await client.close().catch(() => undefined);
    }
  };
  return connection;
}

function createOAuthProvider(
  config: McpServerConfig,
  callbacks: McpAdapterCallbacks,
  onAuthorizationUrl: (url: string) => void,
  options: SdkAdapterOptions
): OAuthProviderHandle {
  const oauth = config.oauth ?? {};
  const rehydrate = (persisted?: McpOAuthConfig) => synchronizeOAuthState(config, callbacks, oauth, persisted);
  rehydrate();
  const redirectUri = oauth.redirectUri?.trim()
    || process.env.MCP_OAUTH_REDIRECT_URI?.trim()
    || `http://127.0.0.1:${options.port ?? Number(process.env.PORT || 3000)}/api/mcp/oauth/callback`;
  if (!isLoopbackRedirect(redirectUri)) throw new Error('MCP OAuth callback must use a loopback URL');
  const update = (patch: Partial<McpOAuthConfig>) => {
    Object.assign(oauth, patch);
    config.oauth = oauth;
    callbacks.onOAuthState?.(oauth);
  };

  const provider: OAuthClientProvider = {
    redirectUrl: redirectUri,
    clientMetadata: {
      client_name: 'EvidentLoop',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(oauth.scope ? { scope: oauth.scope } : {})
    },
    state: () => {
      const value = `${config.id}.${randomToken()}`;
      update({ state: value });
      return value;
    },
    clientInformation: () => {
      synchronizeOAuthState(config, callbacks, oauth);
      if (oauth.clientInformation) {
        return normalizeDcrClientInformation(oauth.clientInformation, oauth.discoveryState) as never;
      }
      if (!oauth.clientId) return undefined;
      return {
        client_id: oauth.clientId,
        ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {})
      } as never;
    },
    saveClientInformation: (information) => update({ clientInformation: information as unknown as Record<string, unknown> }),
    tokens: () => {
      synchronizeOAuthState(config, callbacks, oauth);
      return oauth.tokens as never;
    },
    saveTokens: (tokens) => update({ tokens: tokens as unknown as Record<string, unknown> }),
    redirectToAuthorization: (url) => {
      onAuthorizationUrl(String(url));
    },
    saveCodeVerifier: (verifier) => update({ codeVerifier: verifier }),
    codeVerifier: () => {
      synchronizeOAuthState(config, callbacks, oauth);
      if (!oauth.codeVerifier) throw new Error('OAuth PKCE verifier is unavailable');
      return oauth.codeVerifier;
    },
    saveDiscoveryState: (state) => update({ discoveryState: state as unknown as Record<string, unknown> }),
    discoveryState: () => {
      synchronizeOAuthState(config, callbacks, oauth);
      return oauth.discoveryState as never;
    },
    invalidateCredentials: (scope) => {
      synchronizeOAuthState(config, callbacks, oauth);
      if (scope === 'all' || scope === 'tokens') update({ tokens: undefined });
      if (scope === 'all' || scope === 'client') update({ clientInformation: undefined });
      if (scope === 'all' || scope === 'verifier') update({ codeVerifier: undefined, state: undefined });
      if (scope === 'all' || scope === 'discovery') update({ discoveryState: undefined });
    }
  };
  return { provider, oauth, rehydrate };
}

function synchronizeOAuthState(
  config: McpServerConfig,
  callbacks: McpAdapterCallbacks,
  oauth: McpOAuthConfig,
  persisted = callbacks.getOAuthState?.()
) {
  if (!persisted || persisted === oauth) return;
  for (const key of Object.keys(oauth) as Array<keyof McpOAuthConfig>) {
    if (!(key in persisted)) delete oauth[key];
  }
  Object.assign(oauth, persisted);
  config.oauth = oauth;
}

/**
 * Some registrars return a client secret while declaring `none`. If the
 * authorization server explicitly supports `client_secret_post`, expose a
 * derived view to the SDK so the code exchange uses the secret. The persisted
 * DCR response remains unchanged; this is deliberately not a general auth
 * method fallback.
 */
function normalizeDcrClientInformation(
  clientInformation: Record<string, unknown>,
  discoveryState: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (
    typeof clientInformation.client_secret !== 'string'
    || clientInformation.client_secret.length === 0
    || clientInformation.token_endpoint_auth_method !== 'none'
  ) {
    return clientInformation;
  }

  const authorizationServerMetadata = getAuthorizationServerMetadata(discoveryState);
  const supportedMethods = authorizationServerMetadata?.token_endpoint_auth_methods_supported;
  if (
    !Array.isArray(supportedMethods)
    || supportedMethods.some((method) => typeof method !== 'string')
    || !supportedMethods.includes('client_secret_post')
  ) {
    return clientInformation;
  }

  return {
    ...clientInformation,
    token_endpoint_auth_method: 'client_secret_post'
  };
}

function getAuthorizationServerMetadata(
  discoveryState: Record<string, unknown> | undefined
): { token_endpoint_auth_methods_supported?: unknown } | undefined {
  if (!discoveryState || typeof discoveryState !== 'object' || Array.isArray(discoveryState)) return undefined;
  const metadata = discoveryState.authorizationServerMetadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  return metadata as { token_endpoint_auth_methods_supported?: unknown };
}

function authorizationRequired(url: string | undefined, state: string | undefined, connection: McpConnection): McpAuthorizationRequired {
  const error = new Error('MCP authorization required') as McpAuthorizationRequired;
  error.name = 'McpAuthorizationRequired';
  error.code = 'authorization_required';
  error.authorizationUrl = url;
  error.state = state;
  error.connection = connection;
  return error;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof UnauthorizedError || (error instanceof Error && error.name === 'UnauthorizedError');
}

function rejectAuthorizationHeader(headers: Record<string, string>, authMode: McpServerConfig['authMode']) {
  if (authMode === 'oauth' && Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    throw new Error('Authorization header is reserved for OAuth and cannot be configured as a static header');
  }
}

function toArguments(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  return args as Record<string, unknown>;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function randomToken(): string {
  return randomBytes(16).toString('base64url');
}

function matchesState(expected: string | undefined, received: string): boolean {
  return Boolean(expected && expected === received);
}

function withHeaders(fetchFn: FetchLike, headers: Record<string, string>): FetchLike {
  return (input, init) => {
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return fetchFn(input, { ...init, headers: merged });
  };
}
