import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReviewerInput, type AgentStepReviewer } from './reviewer.js';

const now = '2026-08-09T00:00:00.000Z';

function reviewerContext(): Parameters<AgentStepReviewer>[0] {
  return {
    task: {
      id: 'task-1',
      goal: 'Verify the claim',
      status: 'running',
      currentStepId: 'step-1',
      maxSteps: 3,
      maxTokens: 12_000,
      allowedTools: ['retrieve_web_evidence'],
      checkpointVersion: 1,
      createdAt: now,
      updatedAt: now
    },
    step: {
      id: 'step-1',
      taskId: 'task-1',
      sequence: 1,
      objective: 'Find direct evidence',
      expectedEvidence: ['An official source'],
      dependencies: [],
      status: 'completed',
      attempts: 1,
      input: { query: 'official source' },
      output: {
        reply: 'The source supports the claim.',
        sources: [{ content: 'duplicated source content' }],
        toolCalls: [{ result: { content: 'duplicated tool content' } }]
      },
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now
    },
    toolExecutions: [{
      id: 'execution-1',
      taskId: 'task-1',
      stepId: 'step-1',
      executionKey: 'step-1:web',
      toolName: 'retrieve_web_evidence',
      status: 'completed',
      arguments: { question: 'official source' },
      result: { sources: [{ content: 'duplicated tool content' }] },
      startedAt: now,
      completedAt: now
    }],
    sources: [{
      id: 'source-1',
      taskId: 'task-1',
      stepId: 'step-1',
      toolExecutionId: 'execution-1',
      sourceKey: 'web:https://example.com/report',
      type: 'web',
      title: 'Official report',
      uri: 'https://example.com/report',
      createdAt: now,
      updatedAt: now
    }],
    evidence: [{
      id: 'evidence-1',
      taskId: 'task-1',
      stepId: 'step-1',
      sourceId: 'source-1',
      evidenceKey: 'web:report-1',
      content: 'The canonical evidence content.',
      relevanceScore: 0.9,
      createdAt: now,
      updatedAt: now
    }],
    claims: [{
      id: 'claim-1',
      taskId: 'task-1',
      stepId: 'step-1',
      claimKey: 'claim:1',
      text: 'The source supports the claim.',
      status: 'supported',
      confidence: 0.9,
      createdAt: now,
      updatedAt: now
    }],
    claimEvidence: [{
      taskId: 'task-1',
      claimId: 'claim-1',
      evidenceId: 'evidence-1',
      relation: 'supports',
      createdAt: now,
      updatedAt: now
    }]
  };
}

test('removes duplicated tool results from reviewer input', () => {
  const input = buildReviewerInput(reviewerContext());

  assert.deepEqual(input.step.output, { reply: 'The source supports the claim.' });
  assert.deepEqual(input.toolExecutions, [{
    toolName: 'retrieve_web_evidence',
    arguments: { question: 'official source' },
    status: 'completed'
  }]);
  assert.equal(input.evidenceChain.evidence[0]?.content, 'The canonical evidence content.');
  assert.doesNotMatch(JSON.stringify(input), /duplicated (source|tool) content/);
});
