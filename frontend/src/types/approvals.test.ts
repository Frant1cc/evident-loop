import assert from 'node:assert/strict';
import test from 'node:test';

import { parseToolApprovalEvent, pendingToolApprovals, upsertToolApproval, type ToolApproval } from './approvals';

const approval = (overrides: Partial<ToolApproval> = {}): ToolApproval => ({
  id: 'approval-1',
  scope: { type: 'agent_task', id: 'task-1' },
  toolCallId: 'call-1',
  toolName: 'write_document',
  modelName: 'mcp/write_document',
  label: '写入文档',
  source: 'mcp',
  readOnly: false,
  arguments: { path: '[REDACTED]' },
  definitionHash: 'hash',
  status: 'pending',
  requestedAt: '2026-08-17T00:00:00.000Z',
  ...overrides
});

test('approval event parser accepts requested/resolved events and ignores unrelated payloads', () => {
  const requested = parseToolApprovalEvent({ type: 'tool_approval_requested', payload: { approval: approval() } });
  assert.equal(requested?.approval.id, 'approval-1');
  assert.equal(parseToolApprovalEvent({ type: 'tool_call_started', payload: { approval: approval() } }), undefined);
  assert.equal(parseToolApprovalEvent({ type: 'tool_approval_resolved', payload: { approval: { id: 'bad' } } }), undefined);
});

test('approval upsert replaces by id and keeps a compact pending projection', () => {
  const first = approval();
  const replaced = approval({ status: 'approved', decidedAt: '2026-08-17T00:01:00.000Z' });
  const next = upsertToolApproval([first], replaced);
  assert.equal(next.length, 1);
  assert.equal(next[0]?.status, 'approved');
  assert.equal(pendingToolApprovals([next[0]!, approval({ id: 'approval-2' })]).length, 1);
});

