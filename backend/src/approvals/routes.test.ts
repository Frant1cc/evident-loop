import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { initDb } from '../db.js';
import { ToolExecutionError, type ToolModule } from '../tools/contracts.js';
import { createToolCatalog } from '../tools/registry.js';
import { createToolRuntime } from '../tools/runtime.js';
import { createToolApprovalRouter } from './routes.js';
import { createApprovalManager } from './manager.js';

initDb();

test('approval decision routes reject duplicate decisions and return safe DTOs', async () => {
  const { module, runtime, calls } = createRemoteRuntime();
  const manager = createApprovalManager();
  const scope = { type: 'agent_task' as const, id: `route-reject-${module.definition.function.name}` };
  const request = manager.authorize({
    runtime,
    snapshot: runtime.getSnapshot({ mode: 'all' }),
    toolCall: {
      id: 'route-reject-call',
      name: module.definition.function.name,
      arguments: { authorization: 'hidden' }
    },
    scope
  });
  const requestRejected = assert.rejects(request, (error: unknown) =>
    error instanceof ToolExecutionError && error.code === 'tool_rejected'
  );
  await waitFor(() => manager.list(scope).some((approval) => approval.status === 'pending'));
  const approval = manager.list(scope).find((item) => item.status === 'pending')!;
  const server = await startApprovalServer(manager);
  try {
    const rejected = await decide(server.url, approval.id, 'reject');
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data!.approval.arguments.authorization, '[redacted]');
    assert.equal(rejected.body.data!.approval.status, 'rejected');
    assert.equal(rejected.body.data!.approval.toolName, module.definition.function.name);
    assert.equal(rejected.body.data!.approval.source, 'mcp');
    await requestRejected;
    const duplicate = await decide(server.url, approval.id, 'approve');
    assert.equal(duplicate.status, 409);
    assert.equal(calls(), 0);
  } finally {
    await server.close();
  }
});

test('approve route invalidates a drifted request and never reports approved', async () => {
  const { module, runtime, calls } = createRemoteRuntime();
  const manager = createApprovalManager();
  const scope = { type: 'research_run' as const, id: `route-drift-${module.definition.function.name}` };
  const request = manager.authorize({
    runtime,
    snapshot: runtime.getSnapshot({ mode: 'all' }),
    toolCall: { id: 'route-drift-call', name: module.definition.function.name, arguments: {} },
    scope
  });
  const requestRejected = assert.rejects(request, (error: unknown) =>
    error instanceof ToolExecutionError && error.code === 'schema_changed'
  );
  await waitFor(() => manager.list(scope).some((approval) => approval.status === 'pending'));
  const approval = manager.list(scope).find((item) => item.status === 'pending')!;
  runtime.upsert?.({
    ...module,
    definition: {
      ...module.definition,
      function: { ...module.definition.function, description: 'changed before decision' }
    }
  });
  const server = await startApprovalServer(manager);
  try {
    const response = await decide(server.url, approval.id, 'approve');
    assert.equal(response.status, 409);
    assert.equal(response.body.data, null);
    await requestRejected;
    assert.equal(manager.get(approval.id)?.status, 'invalidated');
    assert.equal(calls(), 0);
  } finally {
    await server.close();
  }
});

function createRemoteRuntime() {
  let calls = 0;
  const module: ToolModule = {
    label: 'Remote route action',
    source: 'mcp',
    annotations: {},
    definition: {
      type: 'function',
      function: {
        name: `mcp_route_${Math.random().toString(16).slice(2)}`,
        description: 'route test tool',
        parameters: { type: 'object', properties: {} }
      }
    },
    availability: { status: 'available' },
    execute: async () => {
      calls += 1;
      return { calls };
    }
  };
  return { module, runtime: createToolRuntime(createToolCatalog([module])), calls: () => calls };
}

async function startApprovalServer(manager: ReturnType<typeof createApprovalManager>) {
  const app = express();
  app.use(express.json());
  app.use('/api', createToolApprovalRouter(manager));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('approval test server did not bind');
  return {
    url: `http://127.0.0.1:${address.port}/api`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function decide(baseUrl: string, id: string, decision: 'approve' | 'reject') {
  const response = await fetch(`${baseUrl}/tool-approvals/${id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision })
  });
  return {
    status: response.status,
    body: await response.json() as {
      data: { approval: { status: string; arguments: Record<string, unknown>; toolName: string; source: string } } | null
    }
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for approval');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
