import type { ToolApproval, ToolApprovalDecision, ToolApprovalScopeType } from '../types/approvals';

type ApiResponse<T> = { code: 0 | 1; message: string; data: T | null };

export class ApprovalApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApprovalApiError';
    this.status = status;
  }
}

export function listToolApprovals(scopeType: ToolApprovalScopeType, scopeId: string) {
  const params = new URLSearchParams({ scopeType, scopeId });
  return request<{ approvals: ToolApproval[] }>(`/api/tool-approvals?${params.toString()}`);
}

export function decideToolApproval(id: string, decision: ToolApprovalDecision) {
  return request<{ approval: ToolApproval }>(`/api/tool-approvals/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body: { decision }
  });
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(path, {
    method: init.method,
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const payload = await response.json().catch(() => null) as ApiResponse<T> | null;
  if (!response.ok || payload?.code !== 1 || payload.data === null || payload.data === undefined) {
    throw new ApprovalApiError(payload?.message || `请求失败：${response.status}`, response.status);
  }
  return payload.data;
}

