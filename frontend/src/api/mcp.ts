import type { McpServer, McpServerDraft } from '../types/mcp';
import type { McpPresetPublic } from '../types/mcp-presets';

export type McpApiResponse<T> = {
  code: 0 | 1;
  message: string;
  data: T | null;
};

/** An HTTP failure that callers can safely branch on without inspecting secrets. */
export class McpApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'McpApiError';
    this.status = status;
  }
}

export function listMcpServers() {
  return request<{ servers: McpServer[] }>('/api/mcp/servers');
}

export function createMcpServer(draft: McpServerDraft) {
  return request<{ server: McpServer }>('/api/mcp/servers', {
    method: 'POST',
    body: { ...draft, enabled: false }
  });
}

export function updateMcpServer(id: string, draft: Partial<McpServerDraft>) {
  return request<{ server: McpServer }>(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: draft
  });
}

export function testMcpServer(id: string) {
  return request<{ server: McpServer }>(`/api/mcp/servers/${encodeURIComponent(id)}/test`, { method: 'POST' });
}

export function setMcpServerEnabled(id: string, enabled: boolean) {
  return request<{ server: McpServer }>(`/api/mcp/servers/${encodeURIComponent(id)}/enabled`, {
    method: 'PATCH',
    body: { enabled }
  });
}

export function refreshMcpServer(id: string) {
  return request<{ server: McpServer }>(`/api/mcp/servers/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
}

export function deleteMcpServer(id: string) {
  return request<{ id: string }>(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function authorizeMcpServer(id: string, code: string, state?: string) {
  return request<{ server: McpServer }>(`/api/mcp/servers/${encodeURIComponent(id)}/authorize`, {
    method: 'POST',
    body: { code, ...(state ? { state } : {}) }
  });
}

export function listMcpPresets() {
  return request<{ presets: McpPresetPublic[] }>('/api/mcp/presets');
}

export function enableMcpPreset(presetId: string, consentVersion: number) {
  return request<{ server: McpServer }>(`/api/mcp/presets/${encodeURIComponent(presetId)}/enable`, {
    method: 'POST',
    body: { consentVersion }
  });
}

export function disableMcpPreset(presetId: string) {
  return request<{ server: McpServer }>(`/api/mcp/presets/${encodeURIComponent(presetId)}/disable`, {
    method: 'POST'
  });
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
  const response = await fetch(path, {
    method: init.method,
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal
  });
  const payload = await response.json().catch(() => null) as McpApiResponse<T> | null;
  if (!response.ok || payload?.code !== 1 || payload.data === null || payload.data === undefined) {
    throw new McpApiError(payload?.message || `请求失败：${response.status}`, response.status);
  }
  return payload.data;
}

