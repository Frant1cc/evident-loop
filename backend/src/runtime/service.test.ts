import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb } from '../db.js';
import {
  createAgentTask,
  deleteAgentTask,
  listAgentTaskEvents,
  saveAgentTaskPlan,
  transitionAgentTask,
  updateAgentTaskPlan
} from './service.js';

initDb();

test('edits a generated plan while awaiting approval and rebuilds linear dependencies', () => {
  const created = createAgentTask({
    goal: '验证运行前计划编辑',
    maxSteps: 4,
    allowedTools: ['search_knowledge']
  });

  try {
    transitionAgentTask(created.task.id, 'planning');
    const planned = saveAgentTaskPlan(created.task.id, [
      { objective: '读取初始资料', expectedEvidence: ['初始证据'] }
    ]);
    assert.equal(planned?.task.status, 'awaiting_approval');

    const updated = updateAgentTaskPlan(created.task.id, [
      { objective: '检索本地资料', expectedEvidence: ['知识库命中结果', '知识库命中结果'] },
      { objective: '核对关键结论', expectedEvidence: ['可验证的结论依据'] }
    ]);

    assert.equal(updated?.steps.length, 2);
    assert.deepEqual(updated?.steps[0]?.expectedEvidence, ['知识库命中结果']);
    assert.deepEqual(updated?.steps[0]?.dependencies, []);
    assert.deepEqual(updated?.steps[1]?.dependencies, [updated.steps[0]!.id]);
    assert.equal(updated?.task.checkpointVersion, 4);
    assert.equal(updated?.latestCheckpoint?.version, 4);
    assert.equal(listAgentTaskEvents(created.task.id)?.at(-1)?.type, 'plan_updated');
  } finally {
    deleteAgentTask(created.task.id);
  }
});

test('rejects plan edits after approval', () => {
  const created = createAgentTask({ goal: '验证批准后的编辑限制', maxSteps: 2 });

  try {
    transitionAgentTask(created.task.id, 'planning');
    saveAgentTaskPlan(created.task.id, [
      { objective: '执行原计划', expectedEvidence: ['原计划证据'] }
    ]);
    transitionAgentTask(created.task.id, 'running');

    assert.throws(
      () => updateAgentTaskPlan(created.task.id, [
        { objective: '不应保存', expectedEvidence: ['不应保存的证据'] }
      ]),
      /awaiting approval/
    );
  } finally {
    transitionAgentTask(created.task.id, 'cancelled');
    deleteAgentTask(created.task.id);
  }
});
