import assert from 'node:assert/strict';

process.env.SQLITE_DB_PATH = ':memory:';

const { initDb, sqlite } = await import('../db.js');
const {
  createAgentTask,
  deleteAgentTask,
  getAgentTaskDetail,
  markAgentTaskInProcess,
  unmarkAgentTaskInProcess,
  listAgentTaskEvents,
  saveAgentTaskPlan,
  saveAgentEvidenceChain,
  startAgentPlanStep,
  retryAgentPlanStep,
  transitionAgentTask
} = await import('./service.js');
const { InvalidTaskTransitionError } = await import('./stateMachine.js');
const { parsePlannerResponse } = await import('./planner.js');
const { parseReviewerResponse } = await import('./reviewer.js');
const { buildEvidenceFromToolExecutions, parseEvidenceChainClaims } = await import('./evidenceChainBuilder.js');
const { executeAgentTask, executeAuditedTool, finalizeAgentTask } = await import('./executor.js');

initDb();

const verificationWriter = async ({ task }: { task: { goal: string } }) => ({
  title: `${task.goal} 最终报告`,
  content: `# 最终结论\n\n已完成：${task.goal}`
});
const verificationReviewer = async () => ({
  verdict: 'pass' as const,
  summary: '验证证据充分',
  supportedClaims: ['步骤结果已提供验证证据'],
  unsupportedClaims: [],
  limitations: [],
  evidenceGaps: []
});
const verificationEvidenceChainBuilder = async () => ({ sources: [], evidence: [], claims: [], links: [] });

const created = createAgentTask({
  goal: '验证 Durable Task Runtime 状态转换',
  maxSteps: 4,
  maxTokens: 8_000,
  allowedTools: ['search_knowledge', 'calculator', 'search_knowledge']
});

assert.equal(created.task.status, 'created');
assert.equal(created.task.checkpointVersion, 1);
assert.deepEqual(created.task.allowedTools, ['search_knowledge', 'calculator']);
assert.equal(created.latestCheckpoint?.version, 1);
assert.equal(listAgentTaskEvents(created.task.id)?.length, 1);

for (const status of ['planning', 'awaiting_approval', 'running', 'paused', 'running', 'completed'] as const) {
  const detail = transitionAgentTask(created.task.id, status, `verify transition to ${status}`);
  assert.equal(detail?.task.status, status);
}

const completed = getAgentTaskDetail(created.task.id);
assert.equal(completed?.task.status, 'completed');
assert.equal(completed?.task.checkpointVersion, 7);
assert.equal(completed?.latestCheckpoint?.version, 7);
assert.equal(listAgentTaskEvents(created.task.id)?.length, 7);

assert.throws(
  () => transitionAgentTask(created.task.id, 'running'),
  (error: unknown) => error instanceof InvalidTaskTransitionError
);

const afterRejectedTransition = getAgentTaskDetail(created.task.id);
assert.equal(afterRejectedTransition?.task.status, 'completed');
assert.equal(afterRejectedTransition?.task.checkpointVersion, 7);

const parsedPlan = parsePlannerResponse(`\`\`\`json
{"steps":[{"objective":"检索运行时设计","expectedEvidence":["状态转换定义","Checkpoint 结构"]},{"objective":"验证恢复流程","expectedEvidence":["恢复测试结果"]}]}
\`\`\``, 4);
assert.equal(parsedPlan.length, 2);
assert.throws(() => parsePlannerResponse('{"steps":[]}', 4), /at least one step/);
assert.throws(() => parsePlannerResponse('{not-json}', 4), /invalid JSON/);
assert.equal(parseReviewerResponse(`\`\`\`json
{"verdict":"pass","summary":"证据充分","supportedClaims":["结论 A"],"unsupportedClaims":[],"limitations":[],"evidenceGaps":[]}
\`\`\``).verdict, 'pass');
assert.throws(() => parseReviewerResponse('{"verdict":"needs_more_evidence","summary":"缺少证据","evidenceGaps":[]}'), /must provide evidence gaps/);
const normalizedEvidence = buildEvidenceFromToolExecutions([{
  id: 'tool-execution-1',
  taskId: 'task-1',
  stepId: 'step-1',
  executionKey: 'task-1:step-1:1:search_knowledge:test',
  toolName: 'search_knowledge',
  status: 'completed',
  arguments: { query: 'Checkpoint' },
  result: {
    results: [{
      id: 'chunk-1',
      file: 'runtime.md',
      title: 'Runtime',
      heading: 'Checkpoint',
      content: 'Checkpoint 保存可恢复状态。',
      startLine: 10,
      endLine: 12,
      score: 0.95
    }]
  },
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString()
}]);
assert.equal(normalizedEvidence.sources[0].sourceKey, 'knowledge:runtime.md');
assert.equal(normalizedEvidence.evidence[0].evidenceKey, 'knowledge:chunk-1');
const parsedClaims = parseEvidenceChainClaims(JSON.stringify({ claims: [{
  text: 'Checkpoint 保存可恢复状态。',
  status: 'supported',
  confidence: 0.93,
  evidenceLinks: [{ evidenceKey: 'knowledge:chunk-1', relation: 'supports', rationale: '原文直接支持。' }]
}] }), new Set(['knowledge:chunk-1']));
assert.equal(parsedClaims.claims.length, 1);
assert.equal(parsedClaims.links[0].relation, 'supports');
assert.throws(() => parseEvidenceChainClaims(JSON.stringify({ claims: [{
  text: '无证据结论', status: 'supported', confidence: 0.8, evidenceLinks: []
}] }), new Set()), /must have at least one supporting evidence/);

const planTask = createAgentTask({ goal: '验证结构化 Planner', maxSteps: 3 });
transitionAgentTask(planTask.task.id, 'planning');
const planned = saveAgentTaskPlan(planTask.task.id, parsedPlan);
assert.equal(planned?.task.status, 'awaiting_approval');
assert.equal(planned?.steps.length, 2);
assert.deepEqual(planned?.steps[1].dependencies, [planned?.steps[0].id]);
assert.equal(planned?.latestCheckpoint?.state.steps.length, 2);
assert.equal(listAgentTaskEvents(planTask.task.id)?.length, 4);

transitionAgentTask(planTask.task.id, 'running', 'verification approval');
const executed = await executeAgentTask({
  id: planTask.task.id,
  apiKey: 'verification-only',
  model: 'verification-only',
  runStep: async ({ step }) => ({ verifiedStep: step.sequence }),
  buildEvidenceChain: verificationEvidenceChainBuilder,
  reviewStep: verificationReviewer,
  writeArtifact: verificationWriter
});
assert.equal(executed?.task.status, 'completed');
assert.equal(executed?.artifacts.length, 1);
assert.match(executed!.artifacts[0].content, /最终结论/);
assert.deepEqual(executed?.steps.map((step) => step.status), ['completed', 'completed']);
assert.deepEqual(executed?.steps.map((step) => step.output), [{ verifiedStep: 1 }, { verifiedStep: 2 }]);

const chainDraft = {
  sources: [{
    sourceKey: 'durable-runtime-doc',
    type: 'knowledge_document' as const,
    title: 'Durable Runtime 设计文档',
    uri: 'knowledge://durable-runtime',
    metadata: { version: 1 }
  }],
  evidence: [{
    evidenceKey: 'checkpoint-definition',
    sourceKey: 'durable-runtime-doc',
    content: 'Checkpoint 保存 Task、Plan、Review 与证据链状态。',
    locator: { section: 'Checkpoint' },
    relevanceScore: 0.96
  }],
  claims: [{
    claimKey: 'runtime-resumable',
    text: '该 Runtime 支持基于 Checkpoint 的任务恢复。',
    status: 'supported' as const,
    confidence: 0.94
  }],
  links: [{
    claimKey: 'runtime-resumable',
    evidenceKey: 'checkpoint-definition',
    relation: 'supports' as const,
    rationale: 'Checkpoint 定义直接支持恢复能力结论。'
  }]
};
const chainSaved = saveAgentEvidenceChain(planTask.task.id, executed!.steps[0].id, chainDraft);
assert.equal(chainSaved.sources.length, 1);
assert.equal(chainSaved.evidence.length, 1);
assert.equal(chainSaved.claims.length, 1);
assert.equal(chainSaved.claimEvidence.length, 1);
assert.equal(chainSaved.latestCheckpoint?.state.claims[0].claimKey, 'runtime-resumable');
const originalSourceId = chainSaved.sources[0].id;
const chainReplayed = saveAgentEvidenceChain(planTask.task.id, executed!.steps[0].id, {
  ...chainDraft,
  sources: [{ ...chainDraft.sources[0], title: 'Durable Runtime 设计文档（更新）' }],
  claims: [{ ...chainDraft.claims[0], confidence: 0.98 }]
});
assert.equal(chainReplayed.sources.length, 1);
assert.equal(chainReplayed.sources[0].id, originalSourceId);
assert.equal(chainReplayed.sources[0].title, 'Durable Runtime 设计文档（更新）');
assert.equal(chainReplayed.claims[0].confidence, 0.98);
assert.throws(() => saveAgentEvidenceChain(planTask.task.id, executed!.steps[0].id, {
  sources: [],
  evidence: [{ evidenceKey: 'missing-source', sourceKey: 'unknown', content: '无来源证据' }],
  claims: [],
  links: []
}), /was not found/);

const automaticChainTask = createAgentTask({ goal: '验证 Executor 自动保存证据链', maxSteps: 1 });
transitionAgentTask(automaticChainTask.task.id, 'planning');
const automaticChainPlan = saveAgentTaskPlan(automaticChainTask.task.id, [{
  objective: '生成可验证结论',
  expectedEvidence: ['一条原始证据']
}]);
transitionAgentTask(automaticChainTask.task.id, 'running');
const automaticChainResult = await executeAgentTask({
  id: automaticChainTask.task.id,
  apiKey: 'verification-only',
  model: 'verification-only',
  runStep: async () => ({ reply: '结论已生成' }),
  buildEvidenceChain: async () => ({
    sources: [{ sourceKey: 'auto-source', type: 'document', title: '自动来源' }],
    evidence: [{ evidenceKey: 'auto-evidence', sourceKey: 'auto-source', content: '自动证据内容' }],
    claims: [{ claimKey: 'auto-claim', text: '自动结论', status: 'supported', confidence: 0.9 }],
    links: [{ claimKey: 'auto-claim', evidenceKey: 'auto-evidence', relation: 'supports' }]
  }),
  reviewStep: async (context) => {
    assert.equal(context.sources.length, 1);
    assert.equal(context.evidence.length, 1);
    assert.equal(context.claims.length, 1);
    assert.equal(context.claimEvidence.length, 1);
    return verificationReviewer();
  },
  writeArtifact: verificationWriter
});
assert.ok(automaticChainPlan);
assert.equal(automaticChainResult?.task.status, 'completed');
assert.equal(automaticChainResult?.claims[0].status, 'supported');
const automaticEvents = listAgentTaskEvents(automaticChainTask.task.id) ?? [];
const chainSavedEventIndex = automaticEvents.findIndex((event) => event.type === 'evidence_chain_saved');
const stepCompletedEventIndex = automaticEvents.findIndex((event) => event.type === 'step_completed');
assert.ok(chainSavedEventIndex >= 0);
assert.ok(stepCompletedEventIndex > chainSavedEventIndex);

const failedTask = createAgentTask({ goal: '验证失败和单步重试', maxSteps: 2 });
transitionAgentTask(failedTask.task.id, 'planning');
const failedPlan = saveAgentTaskPlan(failedTask.task.id, [{ objective: '可能失败的步骤', expectedEvidence: ['失败记录'] }]);
assert.ok(failedPlan);
transitionAgentTask(failedTask.task.id, 'running');
const failedRun = await executeAgentTask({
  id: failedTask.task.id,
  apiKey: 'verification-only',
  model: 'verification-only',
  runStep: async () => { throw new Error('injected step failure'); },
  buildEvidenceChain: verificationEvidenceChainBuilder,
  reviewStep: verificationReviewer,
  writeArtifact: verificationWriter
});
assert.equal(failedRun?.task.status, 'failed');
assert.equal(failedRun?.steps[0].status, 'failed');
assert.equal(failedRun?.steps[0].attempts, 1);

const retried = retryAgentPlanStep(failedTask.task.id, failedRun!.steps[0].id);
assert.equal(retried.task.status, 'running');
assert.equal(retried.steps[0].status, 'pending');
const retryResult = await executeAgentTask({
  id: failedTask.task.id,
  apiKey: 'verification-only',
  model: 'verification-only',
  runStep: async () => ({ recovered: true }),
  buildEvidenceChain: verificationEvidenceChainBuilder,
  reviewStep: verificationReviewer,
  writeArtifact: verificationWriter
});
assert.equal(retryResult?.task.status, 'completed');
assert.equal(retryResult?.steps[0].attempts, 2);

const interruptedTask = createAgentTask({ goal: '验证运行中 Step 恢复', maxSteps: 1 });
transitionAgentTask(interruptedTask.task.id, 'planning');
const interruptedPlan = saveAgentTaskPlan(interruptedTask.task.id, [{ objective: '恢复运行中步骤', expectedEvidence: ['恢复结果'] }]);
transitionAgentTask(interruptedTask.task.id, 'running');
const runningDetail = startAgentPlanStep(interruptedTask.task.id, interruptedPlan!.steps[0].id);
assert.equal(runningDetail.steps[0].attempts, 1);
const resumedResult = await executeAgentTask({
  id: interruptedTask.task.id,
  apiKey: 'verification-only',
  model: 'verification-only',
  runStep: async () => ({ resumed: true }),
  buildEvidenceChain: verificationEvidenceChainBuilder,
  reviewStep: verificationReviewer,
  writeArtifact: verificationWriter
});
assert.equal(resumedResult?.task.status, 'completed');
assert.equal(resumedResult?.steps[0].attempts, 1);

let underlyingToolCalls = 0;
const auditedToolInput = {
  task: resumedResult!.task,
  step: resumedResult!.steps[0],
  toolCall: { id: 'verification-call', name: 'verification_tool', arguments: { query: 'same input' } }
};
const fakeTool = async () => {
  underlyingToolCalls += 1;
  return { verified: true };
};
assert.deepEqual(await executeAuditedTool(auditedToolInput, fakeTool), { verified: true });
assert.deepEqual(await executeAuditedTool(auditedToolInput, fakeTool), { verified: true });
assert.equal(underlyingToolCalls, 1);
assert.equal(getAgentTaskDetail(interruptedTask.task.id)?.toolExecutions.length, 1);

const writerFailureTask = createAgentTask({ goal: '验证 Writer 失败后重新生成', maxSteps: 1 });
transitionAgentTask(writerFailureTask.task.id, 'planning');
const writerFailurePlan = saveAgentTaskPlan(writerFailureTask.task.id, [{ objective: '完成原始研究', expectedEvidence: ['步骤结果'] }]);
transitionAgentTask(writerFailureTask.task.id, 'running');
const writerFailed = await executeAgentTask({
  id: writerFailureTask.task.id,
  apiKey: 'verification-only',
  model: 'verification-only',
  runStep: async () => ({ evidence: 'collected' }),
  buildEvidenceChain: verificationEvidenceChainBuilder,
  reviewStep: verificationReviewer,
  writeArtifact: async () => { throw new Error('injected writer failure'); }
});
assert.equal(writerFailed?.task.status, 'failed');
assert.equal(writerFailed?.steps[0].status, 'completed');
assert.equal(writerFailed?.artifacts.length, 0);
assert.ok(writerFailurePlan);

const finalized = await finalizeAgentTask({
  id: writerFailureTask.task.id,
  apiKey: 'verification-only',
  model: 'verification-only',
  writeArtifact: verificationWriter
});
assert.equal(finalized?.task.status, 'completed');
assert.equal(finalized?.artifacts.length, 1);

const evidenceGapTask = createAgentTask({
  goal: '验证 Evidence Gap 最多触发一次补充检索',
  maxSteps: 3,
  allowedTools: ['search_knowledge']
});
transitionAgentTask(evidenceGapTask.task.id, 'planning');
saveAgentTaskPlan(evidenceGapTask.task.id, [
  { objective: '检索结论 A', expectedEvidence: ['结论 A 的来源'] },
  { objective: '检索结论 B', expectedEvidence: ['结论 B 的来源'] }
]);
transitionAgentTask(evidenceGapTask.task.id, 'running');
const evidenceGapResult = await executeAgentTask({
  id: evidenceGapTask.task.id,
  apiKey: 'verification-only',
  model: 'verification-only',
  runStep: async ({ step }) => ({ searched: step.objective }),
  buildEvidenceChain: verificationEvidenceChainBuilder,
  reviewStep: async ({ step }) => step.input
    ? verificationReviewer()
    : {
        verdict: 'needs_more_evidence' as const,
        summary: `步骤 ${step.sequence} 缺少可追溯来源`,
        supportedClaims: [],
        unsupportedClaims: [`结论 ${step.sequence}`],
        limitations: ['当前结果只有摘要'],
        evidenceGaps: [{
          description: `缺少步骤 ${step.sequence} 的原始来源`,
          requiredEvidence: `步骤 ${step.sequence} 的权威来源`,
          suggestedQuery: `步骤 ${step.sequence} 权威来源`
        }]
      },
  writeArtifact: verificationWriter
});
assert.equal(evidenceGapResult?.task.status, 'completed');
assert.equal(evidenceGapResult?.steps.length, 3);
assert.equal(evidenceGapResult?.steps.filter((step) => Boolean(step.input)).length, 1);
assert.equal(evidenceGapResult?.reviews.length, 3);
assert.deepEqual(evidenceGapResult?.evidenceGaps.map((gap) => gap.status), ['resolved', 'unresolved']);
assert.equal(listAgentTaskEvents(evidenceGapTask.task.id)?.filter((event) => event.type === 'supplemental_step_added').length, 1);

const undeletableTask = createAgentTask({ goal: '验证执行中任务不可删除' });
transitionAgentTask(undeletableTask.task.id, 'planning');
transitionAgentTask(undeletableTask.task.id, 'awaiting_approval');
transitionAgentTask(undeletableTask.task.id, 'running');
markAgentTaskInProcess(undeletableTask.task.id);
assert.throws(() => deleteAgentTask(undeletableTask.task.id), /不能删除/);
unmarkAgentTaskInProcess(undeletableTask.task.id);
assert.ok(getAgentTaskDetail(undeletableTask.task.id));

const deletedTask = deleteAgentTask(interruptedTask.task.id);
assert.equal(deletedTask?.id, interruptedTask.task.id);
assert.equal(getAgentTaskDetail(interruptedTask.task.id), undefined);
assert.equal(listAgentTaskEvents(interruptedTask.task.id), undefined);
for (const table of ['agent_plan_steps', 'agent_reviews', 'agent_evidence_gaps', 'agent_events', 'agent_checkpoints', 'tool_executions', 'agent_artifacts']) {
  const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE task_id = ?`).get(interruptedTask.task.id) as { count: number };
  assert.equal(row.count, 0, `${table} should be deleted with its task`);
}

deleteAgentTask(evidenceGapTask.task.id);
for (const table of ['agent_reviews', 'agent_evidence_gaps']) {
  const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE task_id = ?`).get(evidenceGapTask.task.id) as { count: number };
  assert.equal(row.count, 0, `${table} should cascade when deleting a reviewed task`);
}


deleteAgentTask(planTask.task.id);
for (const table of ['agent_sources', 'agent_evidence', 'agent_claims', 'agent_claim_evidence']) {
  const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE task_id = ?`).get(planTask.task.id) as { count: number };
  assert.equal(row.count, 0, `${table} should cascade when deleting an evidence-chain task`);
}

console.log('Durable Task Runtime verification passed');
