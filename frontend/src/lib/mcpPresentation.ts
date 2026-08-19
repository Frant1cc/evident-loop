import type { McpServer, McpServerStatus } from '../types/mcp';

export type McpOAuthPollState = 'pending' | 'connected' | 'verified' | 'failed';
export type McpSaveNotice = 'created' | 'changed' | 'renamed' | 'saved';

/**
 * OAuth authorization is validated while a draft remains disabled. A timestamp
 * is the public proof that the disabled draft passed the connection test.
 */
export function getMcpOAuthPollState(server: Pick<McpServer, 'status' | 'lastRefreshedAt'>): McpOAuthPollState {
  if (server.status === 'connected') return 'connected';
  if (server.status === 'disabled' && Boolean(server.lastRefreshedAt)) return 'verified';
  if (server.status === 'error' || server.status === 'credential_unavailable') return 'failed';
  return 'pending';
}

export function getMcpOAuthPollMessage(state: McpOAuthPollState) {
  return ({
    pending: '已重新检查服务器状态，仍在等待 OAuth 授权。',
    connected: 'OAuth 授权完成，连接已建立。',
    verified: 'OAuth 授权完成，已验证，可以启用。',
    failed: 'OAuth 授权失败，凭证不可用或连接出错，请查看服务器错误。'
  } satisfies Record<McpOAuthPollState, string>)[state];
}

/**
 * Public MCP responses intentionally omit secrets. A cleared validation
 * timestamp catches same-name credential replacement; the public connection
 * fingerprint catches visible transport/auth/url changes.
 */
export function mcpRequiresRetest(before?: McpServer, after?: McpServer) {
  if (!before || !after) return false;
  if (Boolean(before.lastRefreshedAt) && !after.lastRefreshedAt) return true;
  return mcpConnectionFingerprint(before) !== mcpConnectionFingerprint(after);
}

export function getMcpSaveNotice(before?: McpServer, after?: McpServer): McpSaveNotice {
  if (!before || !after) return 'created';
  if (mcpRequiresRetest(before, after)) return 'changed';
  if (before.name !== after.name) return 'renamed';
  return 'saved';
}

function mcpConnectionFingerprint(server: McpServer) {
  return JSON.stringify({
    transport: server.transport,
    url: server.url,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    authMode: server.authMode,
    headerNames: server.headerNames,
    hasCredentials: server.hasCredentials
  });
}

export function isMcpFailureStatus(status: McpServerStatus) {
  return status === 'error' || status === 'credential_unavailable';
}

