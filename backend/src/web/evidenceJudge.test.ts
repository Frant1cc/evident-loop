import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlmProvider } from '../llm/contracts.js';
import { judgeWebEvidence } from './evidenceJudge.js';

const claims = [{
  id: 'reconnect', text: '如何恢复断线后的事件？',
  searchQueries: ['event stream reconnect'], preferredDomains: [], sourceTypes: [], subjectTerms: ['EventSource']
}];

test('accepts a structured judgment only when its quote exists in the source chunk', async () => {
  const judgments = await judgeWebEvidence({
    question: '如何恢复事件流？', url: 'https://example.com', title: 'Docs', claims,
    chunks: [{ index: 3, content: 'EventSource sends Last-Event-ID when reconnecting.' }],
    llm: fakeLlm(JSON.stringify({ judgments: [{
      claimId: 'reconnect', relation: 'supports', confidence: 0.95, chunkIndex: 3,
      evidenceQuote: 'Last-Event-ID when reconnecting', reason: 'Direct support', subjectMatched: true
    }] }))
  });
  assert.equal(judgments[0]?.relation, 'supports');
});

test('downgrades an invented quote so model knowledge cannot become evidence', async () => {
  const judgments = await judgeWebEvidence({
    question: '如何恢复事件流？', url: 'https://example.com', title: 'Docs', claims,
    chunks: [{ index: 0, content: 'EventSource connection details.' }],
    llm: fakeLlm(JSON.stringify({ judgments: [{
      claimId: 'reconnect', relation: 'supports', confidence: 0.99, chunkIndex: 0,
      evidenceQuote: 'A sentence that is not present', reason: 'Invented', subjectMatched: true
    }] }))
  });
  assert.equal(judgments[0]?.relation, 'irrelevant');
  assert.equal(judgments[0]?.confidence, 0);
});

function fakeLlm(content: string): LlmProvider {
  return {
    complete: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
    stream: async () => undefined
  };
}
