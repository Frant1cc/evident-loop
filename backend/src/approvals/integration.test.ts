import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb } from '../db.js';
import { createApprovalManager } from './manager.js';
import type { ToolModule } from '../tools/contracts.js';
import { createToolCatalog } from '../tools/registry.js';
import { createToolRuntime } from '../tools/runtime.js';
import {
  createAndStartResearchRun,
  getResearchRunSnapshot
} from '../research/service.js';
import {
  createResearchConversation,
  deleteResearchConversation,
  getResearchRun
} from '../research/store.js';
import { listStreamEventsAfter } from '../streaming/eventStore.js';
import { createTaskApplication } from '../modules/tasks/application.js';
import {
  deleteAgentTask,
  saveAgentTaskPlan,
  startAgentPlanStep,
  transitionAgentTask
} from '../runtime/service.js';
import { executeAuditedTool } from '../runtime/executor.js';

initDb();

test('Research snapshot and replay retain pending and resolved approval events', async () => {
  const { module, runtime } = createRemoteRuntime();
  const approvals = createApprovalManager();
  const conversation = createResearchConversation();
  const started = createAndStartResearchRun({
    conversationId: conversation.id,
    content: '等待远程工具审批',
    toolPolicy: { mode: 'all' },
    toolRuntime: runtime,
    approvalManager: approvals,
    schedule: (callback) => { setImmediate(callback); },
    runAgent: async (options) => {
      const snapshot = runtime.getSnapshot({ mode: 'all' }, options.toolScope);
      await approvals.authorize({
        runtime,
        snapshot,
        toolCall: { id: 'research-integration-call', name: module.definition.function.name, arguments: {} },
        scope: options.approvalScope!,
        context: { signal: options.signal, toolScope: options.toolScope },
        onRequested: (approval) => options.onEvent?.({ type: 'tool_approval_requested', approval }),
        onResolved: (approval) => options.onEvent?.({ type: 'tool_approval_resolved', approval })
      });
      return { reply: '已批准', toolCalls: [], trace: [], sources: [] };
    }
  });

  try {
    const scope = { type: 'research_run' as const, id: started.run.id };
    await waitFor(() => approvals.list(scope).some((approval) => approval.status === 'pending'));
    const snapshot = getResearchRunSnapshot(started.run.id, approvals);
    assert.equal(snapshot?.detail.approvals?.find((approval) => approval.status === 'pending')?.toolCallId, 'research-integration-call');
    const pendingEvents = listStreamEventsAfter(started.run.id, 0);
    assert.ok(pendingEvents.some((event) => event.type === 'tool_approval_requested'));

    const approval = approvals.list(scope).find((item) => item.status === 'pending')!;
    assert.equal(approvals.decide(approval.id, 'approve').status, 'approved');
    await waitFor(() => getResearchRun(started.run.id)?.status === 'completed');
    const replay = listStreamEventsAfter(started.run.id, 0).map((event) => event.type);
    assert.ok(replay.includes('tool_approval_requested'));
    assert.ok(replay.includes('tool_approval_resolved'));
    assert.equal(getResearchRunSnapshot(started.run.id, approvals)?.detail.approvals?.find((item) => item.id === approval.id)?.status, 'approved');
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('Task application detail and event polling expose approval lifecycle', async () => {
  const { module, runtime, calls } = createRemoteRuntime();
  const approvals = createApprovalManager();
  const tasks = createTaskApplication({ model: 'test-model', toolRuntime: runtime, approvalManager: approvals });
  const created = tasks.create({ goal: '审批一个远程动作', toolPolicy: { mode: 'all' } });
  try {
    transitionAgentTask(created.task.id, 'planning');
    const planned = saveAgentTaskPlan(created.task.id, [{ objective: '调用远程动作', expectedEvidence: ['结果'] }])!;
    tasks.approve(created.task.id);
    const active = startAgentPlanStep(created.task.id, planned.steps[0]!.id);
    const snapshot = runtime.getSnapshot({ mode: 'all' }, { kind: 'agent_task', taskId: active.task.id });
    const call = { id: 'task-integration-call', name: module.definition.function.name, arguments: {} };
    const execution = executeAuditedTool({
      task: active.task,
      step: active.steps[0]!,
      toolCall: call,
      snapshot,
      toolRuntime: runtime,
      approvalManager: approvals,
      approvalScope: { type: 'agent_task', id: active.task.id }
    }, (name, args, context) => runtime.execute(snapshot, { id: call.id, name, arguments: args }, context));

    const scope = { type: 'agent_task' as const, id: active.task.id };
    await waitFor(() => approvals.list(scope).some((approval) => approval.status === 'pending'));
    assert.equal(tasks.get(active.task.id)?.approvals?.find((approval) => approval.status === 'pending')?.toolCallId, call.id);
    assert.ok(tasks.events(active.task.id)?.some((event) => event.type === 'tool_approval_requested'));

    const approval = approvals.list(scope).find((item) => item.status === 'pending')!;
    approvals.decide(approval.id, 'approve');
    assert.deepEqual(await execution, { calls: 1 });
    assert.equal(tasks.get(active.task.id)?.approvals?.find((item) => item.id === approval.id)?.status, 'approved');
    assert.ok(tasks.events(active.task.id)?.some((event) => event.type === 'tool_approval_resolved'));
    assert.equal(calls(), 1);
  } finally {
    deleteAgentTask(created.task.id);
  }
});

function createRemoteRuntime() {
  let calls = 0;
  const module: ToolModule = {
    label: 'Integration remote action',
    source: 'mcp',
    annotations: {},
    definition: {
      type: 'function',
      function: {
        name: `mcp_integration_${Math.random().toString(16).slice(2)}`,
        description: 'integration test tool',
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

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for approval integration');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
