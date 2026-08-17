import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb } from '../db.js';
import { runAgentLoop } from '../agent/agentLoop.js';
import type { LlmProvider } from '../llm/contracts.js';
import type { ToolModule } from '../tools/contracts.js';
import { createToolCatalog } from '../tools/registry.js';
import { createToolRuntime } from '../tools/runtime.js';
import { ToolExecutionError } from '../tools/contracts.js';
import { createAgentTask, saveAgentTaskPlan, startAgentPlanStep, transitionAgentTask, deleteAgentTask } from '../runtime/service.js';
import { executeAuditedTool } from '../runtime/executor.js';
import { createApprovalManager } from './manager.js';
import { createApprovalStore } from './store.js';
import { ApprovalDecisionConflictError } from './contracts.js';

initDb();

function createMcpRuntime(options: { readOnlyHint?: boolean; available?: () => boolean } = {}) {
  let calls = 0;
  const module: ToolModule = {
    label: 'Remote action',
    source: 'mcp',
    annotations: options.readOnlyHint === undefined ? {} : { readOnlyHint: options.readOnlyHint },
    definition: {
      type: 'function',
      function: {
        name: `mcp_test_${Math.random().toString(16).slice(2)}`,
        description: 'test tool',
        parameters: { type: 'object', properties: {} }
      }
    },
    availability: () => options.available?.() === false
      ? { status: 'unavailable', reason: 'offline', retryable: true }
      : { status: 'available' },
    execute: async () => {
      calls += 1;
      return { calls };
    }
  };
  return { module, runtime: createToolRuntime(createToolCatalog([module])), calls: () => calls };
}

test('MCP read-only tools execute without an approval row', async () => {
  const { module, runtime, calls } = createMcpRuntime({ readOnlyHint: true });
  const manager = createApprovalManager();
  const snapshot = runtime.getSnapshot({ mode: 'all' });
  const scope = { type: 'research_run' as const, id: `readonly-${module.definition.function.name}` };
  await manager.authorize({
    runtime,
    snapshot,
    toolCall: { id: 'readonly-call', name: module.definition.function.name, arguments: {} },
    scope
  });
  await runtime.execute(snapshot, { id: 'readonly-call', name: module.definition.function.name, arguments: {} });
  assert.equal(calls(), 1);
  assert.equal(manager.list(scope).length, 0);
});

test('side-effecting MCP calls wait, approve once, and reject without execution', async () => {
  const { module, runtime, calls } = createMcpRuntime();
  const manager = createApprovalManager();
  const snapshot = runtime.getSnapshot({ mode: 'all' });
  const scope = { type: 'agent_task' as const, id: `pending-${module.definition.function.name}` };
  const request = manager.authorize({
    runtime,
    snapshot,
    toolCall: { id: 'pending-call', name: module.definition.function.name, arguments: { token: 'do-not-return' } },
    scope
  });
  await waitFor(() => manager.list(scope).some((item) => item.status === 'pending'));
  const pending = manager.list(scope).find((item) => item.status === 'pending');
  assert.deepEqual(pending?.arguments, { token: '[redacted]' });
  assert.equal(manager.decide(pending!.id, 'approve').status, 'approved');
  await request;
  await runtime.execute(snapshot, { id: 'pending-call', name: module.definition.function.name, arguments: {} });
  assert.equal(calls(), 1);

  const rejectedEvents: string[] = [];
  const rejected = manager.authorize({
    runtime,
    snapshot,
    toolCall: { id: 'rejected-call', name: module.definition.function.name, arguments: {} },
    scope,
    onResolved: (approval) => { rejectedEvents.push(approval.status); }
  });
  await waitFor(() => manager.list(scope).some((item) => item.toolCallId === 'rejected-call'));
  const rejectedApproval = manager.list(scope).find((item) => item.toolCallId === 'rejected-call')!;
  manager.decide(rejectedApproval.id, 'reject');
  await assert.rejects(rejected, (error: unknown) =>
    error instanceof ToolExecutionError && error.code === 'tool_rejected'
  );
  assert.deepEqual(rejectedEvents, ['rejected']);
  assert.equal(calls(), 1);
});

test('aborting an approval cancels its persisted row', async () => {
  const { module, runtime } = createMcpRuntime();
  const manager = createApprovalManager();
  const controller = new AbortController();
  const resolved: string[] = [];
  const scope = { type: 'research_run' as const, id: `abort-${module.definition.function.name}` };
  const request = manager.authorize({
    runtime,
    snapshot: runtime.getSnapshot({ mode: 'all' }),
    toolCall: { id: 'abort-call', name: module.definition.function.name, arguments: {} },
    scope,
    context: { signal: controller.signal },
    onResolved: (approval) => { resolved.push(approval.status); }
  });
  await waitFor(() => manager.list(scope).length === 1);
  controller.abort();
  await assert.rejects(request, (error: unknown) =>
    error instanceof ToolExecutionError && error.code === 'cancelled'
  );
  assert.equal(manager.list(scope)[0]?.status, 'cancelled');
  assert.deepEqual(resolved, ['cancelled']);
});

test('agent loop emits approval events and resumes after the decision', async () => {
  const { module, runtime, calls } = createMcpRuntime();
  const manager = createApprovalManager();
  const scope = { type: 'research_run' as const, id: `loop-${module.definition.function.name}` };
  let completions = 0;
  const llm: LlmProvider = {
    complete: async () => {
      completions += 1;
      return completions === 1
        ? {
            choices: [{ message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'loop-call',
                type: 'function',
                function: { name: module.definition.function.name, arguments: '{}' }
              }]
            } }]
          }
        : { choices: [{ message: { role: 'assistant', content: 'done' } }] };
    },
    stream: async () => undefined
  };
  const events: string[] = [];
  const resultPromise = runAgentLoop({
    llm,
    model: 'test-model',
    message: 'approve a remote action',
    systemPrompt: 'test',
    toolRuntime: runtime,
    approvalManager: manager,
    approvalScope: scope,
    toolScope: { kind: 'research', runId: scope.id },
    onEvent: (event) => {
      if (event.type === 'tool_approval_requested' || event.type === 'tool_approval_resolved') {
        events.push(`${event.type}:${event.approval.status}`);
      }
    }
  });
  await waitFor(() => manager.list(scope).some((item) => item.status === 'pending'));
  const approval = manager.list(scope).find((item) => item.status === 'pending')!;
  manager.decide(approval.id, 'approve');
  const result = await resultPromise;
  assert.equal(result.reply, 'done');
  assert.equal(calls(), 1);
  assert.deepEqual(events, ['tool_approval_requested:pending', 'tool_approval_resolved:approved']);
});

test('schema drift while waiting invalidates approval and never calls the module', async () => {
  const { module, runtime, calls } = createMcpRuntime();
  const manager = createApprovalManager();
  const scope = { type: 'research_run' as const, id: `drift-${module.definition.function.name}` };
  const resolvedEvents: string[] = [];
  const snapshot = runtime.getSnapshot({ mode: 'all' });
  const request = manager.authorize({
    runtime,
    snapshot,
    toolCall: { id: 'drift-call', name: module.definition.function.name, arguments: {} },
    scope,
    onResolved: (approval) => { resolvedEvents.push(approval.status); }
  });
  const requestRejected = assert.rejects(request, (error: unknown) =>
    error instanceof ToolExecutionError && error.code === 'schema_changed'
  );
  await waitFor(() => manager.list(scope).length === 1);
  runtime.upsert?.({
    ...module,
    definition: {
      ...module.definition,
      function: { ...module.definition.function, description: 'changed after request' }
    }
  });
  const approval = manager.list(scope)[0]!;
  assert.throws(() => manager.decide(approval.id, 'approve'), ApprovalDecisionConflictError);
  await requestRejected;
  assert.equal(manager.list(scope)[0]?.status, 'invalidated');
  assert.deepEqual(resolvedEvents, ['invalidated']);
  assert.equal(calls(), 0);
});

test('availability drift makes manager approve conflict and invalidates without a remote call', async () => {
  let available = true;
  const { module, runtime, calls } = createMcpRuntime({ available: () => available });
  const manager = createApprovalManager();
  const scope = { type: 'research_run' as const, id: `offline-${module.definition.function.name}` };
  const request = manager.authorize({
    runtime,
    snapshot: runtime.getSnapshot({ mode: 'all' }),
    toolCall: { id: 'offline-call', name: module.definition.function.name, arguments: {} },
    scope
  });
  const requestRejected = assert.rejects(request, (error: unknown) =>
    error instanceof ToolExecutionError && error.code === 'unavailable'
  );
  await waitFor(() => manager.list(scope).some((item) => item.status === 'pending'));
  available = false;
  const approval = manager.list(scope).find((item) => item.status === 'pending')!;
  assert.throws(() => manager.decide(approval.id, 'approve'), ApprovalDecisionConflictError);
  await requestRejected;
  assert.equal(manager.get(approval.id)?.status, 'invalidated');
  assert.equal(calls(), 0);
});

test('durable completed execution replays without a second approval or remote call', async () => {
  const { module, runtime, calls } = createMcpRuntime();
  const manager = createApprovalManager();
  const created = createAgentTask({ goal: 'durable approval replay', toolPolicy: { mode: 'all' } });
  try {
    transitionAgentTask(created.task.id, 'planning');
    const planned = saveAgentTaskPlan(created.task.id, [{ objective: 'run remote action', expectedEvidence: ['result'] }]);
    const running = transitionAgentTask(created.task.id, 'running', 'approve plan');
    const active = startAgentPlanStep(created.task.id, planned!.steps[0]!.id);
    const task = active.task;
    const step = active.steps[0]!;
    const snapshot = runtime.getSnapshot({ mode: 'all' });
    const execute = async () => module.execute({}, undefined);
    const first = executeAuditedTool({
      task,
      step,
      toolCall: { id: 'durable-call-1', name: module.definition.function.name, arguments: {} },
      snapshot,
      toolRuntime: runtime,
      approvalManager: manager,
      approvalScope: { type: 'agent_task', id: task.id }
    }, execute);
    await waitFor(() => manager.list({ type: 'agent_task', id: task.id }).some((item) => item.status === 'pending'));
    const approval = manager.list({ type: 'agent_task', id: task.id }).find((item) => item.status === 'pending')!;
    manager.decide(approval.id, 'approve');
    assert.deepEqual(await first, { calls: 1 });
    assert.deepEqual(await executeAuditedTool({
      task,
      step,
      toolCall: { id: 'durable-call-2', name: module.definition.function.name, arguments: {} },
      snapshot,
      toolRuntime: runtime,
      approvalManager: manager,
      approvalScope: { type: 'agent_task', id: task.id }
    }, execute), { calls: 1 });
    assert.equal(calls(), 1);
    assert.equal(manager.list({ type: 'agent_task', id: task.id }).filter((item) => item.status === 'pending').length, 0);
    void running;
  } finally {
    deleteAgentTask(created.task.id);
  }
});

test('decision transition is atomic and startup expires old pending rows', async () => {
  const { module, runtime } = createMcpRuntime();
  const store = createApprovalStore();
  const manager = createApprovalManager({ store });
  const scope = { type: 'research_run' as const, id: `atomic-${module.definition.function.name}` };
  const request = manager.authorize({
    runtime,
    snapshot: runtime.getSnapshot({ mode: 'all' }),
    toolCall: { id: 'atomic-call', name: module.definition.function.name, arguments: {} },
    scope
  });
  await waitFor(() => manager.list(scope).length === 1);
  const id = manager.list(scope)[0]!.id;
  assert.equal(manager.decide(id, 'approve').status, 'approved');
  assert.throws(() => manager.decide(id, 'reject'), ApprovalDecisionConflictError);
  await request;

  const old = store.create({
    scope: { type: 'agent_task', id: `old-${module.definition.function.name}` },
    toolCallId: 'old-call',
    toolName: module.definition.function.name,
    modelName: module.definition.function.name,
    label: module.label,
    source: 'mcp',
    readOnly: false,
    arguments: {},
    definitionHash: 'old-hash',
    requestedAt: new Date(0).toISOString()
  });
  createApprovalManager({ store });
  assert.equal(store.get(old.id)?.status, 'expired');
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for approval');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
