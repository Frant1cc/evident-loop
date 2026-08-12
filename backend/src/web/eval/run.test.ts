import assert from 'node:assert/strict';
import test from 'node:test';

import type { RagSource } from '../../rag/types.js';
import type { WebRetrievalResult } from '../types.js';
import { evaluateCase, runWebEvaluation } from './run.js';
import type { WebEvalCase } from './fixtures.js';

const testCase: WebEvalCase = {
  id: 'depth', title: 'Search depth', question: 'values and cost', category: 'multi_claim', answerable: true,
  expectedDomains: ['docs.example.com'],
  expectedEvidence: [
    { id: 'values', label: 'values', groups: [['basic'], ['advanced']] },
    { id: 'cost', label: 'cost', groups: [['advanced'], ['2 credits']] }
  ]
};

test('evaluateCase requires question-level evidence coverage, not only a relevant page', () => {
  const result = evaluateCase(testCase, retrieval('sufficient', [source('https://docs.example.com/api', 'basic and advanced modes')]));
  assert.equal(result.hitAtK, 1);
  assert.equal(result.evidenceRecall, 0.5);
  assert.equal(result.falseSufficient, true);
  assert.equal(result.passed, false);
});

test('evaluateCase passes complete official evidence and rejects false sufficient unanswerable cases', () => {
  const complete = evaluateCase(testCase, retrieval('sufficient', [source('https://docs.example.com/api', 'basic and advanced; advanced costs 2 credits')]));
  assert.equal(complete.evidenceRecall, 1);
  assert.equal(complete.evidencePrecision, 1);
  assert.equal(complete.passed, true);

  const unanswerable = evaluateCase({ ...testCase, answerable: false, expectedEvidence: [] }, retrieval('sufficient', []));
  assert.equal(unanswerable.falseSufficient, true);
  assert.equal(unanswerable.passed, false);
});

test('runWebEvaluation aggregates accuracy, false-sufficient, and cost metrics', async () => {
  const weakCase = { ...testCase, id: 'weak' };
  const report = await runWebEvaluation({
    cases: [testCase, weakCase], suiteVersion: 1,
    retrieve: async (item) => item.id === 'depth'
      ? retrieval('sufficient', [source('https://docs.example.com/api', 'basic advanced and 2 credits')])
      : retrieval('sufficient', [source('https://docs.example.com/api', 'basic advanced')])
  });
  assert.equal(report.metrics.caseCount, 2);
  assert.equal(report.metrics.passRate, 0.5);
  assert.equal(report.metrics.evidenceRecall, 0.75);
  assert.equal(report.metrics.falseSufficientCount, 1);
  assert.equal(report.metrics.avgQueryCount, 1);
});

function source(url: string, content: string): RagSource {
  return { id: url, file: url, title: 'Official docs', content, lineCount: 1, startLine: 1, endLine: 1, score: 0.9 };
}

function retrieval(verdict: WebRetrievalResult['verdict'], sources: RagSource[]): WebRetrievalResult {
  return {
    question: 'q', verdict, score: 0.8, retrievalQueries: ['q'], queryAttempts: [], pageAttempts: [], sources,
    claims: [], coverageScore: 0.5, coveredClaimCount: 1, totalClaimCount: 2, uncoveredClaims: [],
    diagnostics: { queriesUsed: 1, pagesFetched: sources.length, queryBudget: 3, pageBudget: 5,
      independentDomains: sources.length ? 1 : 0, durationMs: 25, stopReason: 'test' }
  };
}
