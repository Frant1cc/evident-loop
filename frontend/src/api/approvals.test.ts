import assert from 'node:assert/strict';
import test from 'node:test';

import { ApprovalApiError, decideToolApproval, listToolApprovals } from './approvals';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('approval API sends a scoped list query and parses DTOs', async () => {
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ code: 1, message: 'ok', data: { approvals: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  await listToolApprovals('research_run', 'run-1');
  assert.match(requestedUrl, /scopeType=research_run/);
  assert.match(requestedUrl, /scopeId=run-1/);
});

test('approval decision preserves server conflict status for refresh handling', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, message: 'Tool approval is no longer pending', data: null }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' }
  });
  await assert.rejects(() => decideToolApproval('approval-1', 'approve'), (error: unknown) =>
    error instanceof ApprovalApiError && error.status === 409
  );
});

