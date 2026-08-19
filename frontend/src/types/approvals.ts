export type ToolApprovalScopeType = 'research_run' | 'agent_task';
export type ToolApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'invalidated';
export type ToolApprovalDecision = 'approve' | 'reject';

export type ToolApproval = {
  id: string;
  scope: { type: ToolApprovalScopeType; id: string };
  toolCallId: string;
  toolName: string;
  modelName: string;
  label: string;
  source: string;
  serverId?: string;
  serverName?: string;
  remoteName?: string;
  readOnly: boolean;
  /** API arguments are already redacted by the backend. */
  arguments: unknown;
  definitionHash: string;
  status: ToolApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
};

type ApprovalEvent = {
  type: 'tool_approval_requested' | 'tool_approval_resolved';
  approval: ToolApproval;
};

export function parseToolApprovalEvent(event: { type?: unknown; payload?: unknown }): ApprovalEvent | undefined {
  if (event.type !== 'tool_approval_requested' && event.type !== 'tool_approval_resolved') return undefined;
  const payload = asRecord(event.payload);
  const approval = payload?.approval;
  if (!isToolApproval(approval)) return undefined;
  return { type: event.type, approval };
}

export function upsertToolApproval(approvals: ToolApproval[], approval: ToolApproval) {
  const next = [...approvals];
  const index = next.findIndex((item) => item.id === approval.id);
  if (index === -1) next.push(approval);
  else next[index] = approval;
  return next;
}

export function pendingToolApprovals(approvals: ToolApproval[]) {
  return approvals.filter((approval) => approval.status === 'pending');
}

function isToolApproval(value: unknown): value is ToolApproval {
  const record = asRecord(value);
  return Boolean(
    record
    && typeof record.id === 'string'
    && typeof record.toolName === 'string'
    && typeof record.status === 'string'
    && typeof record.readOnly === 'boolean'
    && record.scope && typeof record.scope === 'object'
  );
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
