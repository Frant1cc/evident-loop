import assert from 'node:assert/strict';
import test from 'node:test';

import type { RagSource } from '../../rag/types.js';
import type { WebRetrievalResult } from '../types.js';
import { evaluateCase, runWebEvaluation } from './run.js';
import type { WebEvalCase } from './fixtures.js';

const testCase: WebEvalCase = {
  id: 'depth', title: 'Search depth', question: 'values and cost', category: 'multi_claim', answerable: true,
  expectedDomains: ['docs.example.com'],
  tags: [], difficulty: 'medium', suites: ['regression'], expectedEvidence: [
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

test('aggregates retrieval diagnostics and separates failure causes', async () => {
  const budgetCase = { ...testCase, id: 'budget' };
  const report = await runWebEvaluation({
    cases: [testCase, budgetCase], suiteVersion: 2,
    retrieve: async (item) => item.id === 'depth'
      ? retrieval('sufficient', [source('https://docs.example.com/api', 'basic advanced and 2 credits')], {
          queryAttempts: [attempt('q', 'weak'), attempt('q rewritten', 'sufficient')],
          pageAttempts: [page('https://docs.example.com/api', 'sufficient', 2)]
        })
      : retrieval('exhausted', [source('https://docs.example.com/api', 'basic advanced')], {
          budgetExhaustedBy: 'queries', queryAttempts: [attempt('q', 'weak'), attempt('q rewritten', 'weak')],
          pageAttempts: [page('https://docs.example.com/api', 'weak', 1)]
        })
  });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.metrics.rewriteTriggeredRate, 1);
  assert.equal(report.metrics.rewriteRecoveryRate, 0.5);
  assert.equal(report.metrics.budgetExhaustedCount, 1);
  assert.deepEqual(report.metrics.failureReasons, [{ code: 'budget_exhausted', caseIds: ['budget'], count: 1 }]);
  assert.equal(report.metrics.pageExtractionSuccessRate, 1);
});

test('reports subject mismatch as a dedicated evaluation failure', () => {
  const result = evaluateCase(testCase, retrieval('weak', [], {
    subjectConsistencyRate: 0,
    subjectMismatchUrls: ['https://example.com/websocket-only']
  }));

  assert.equal(result.failureReason, 'subject_mismatch');
  assert.equal(result.subjectConsistencyRate, 0);
  assert.deepEqual(result.subjectMismatchUrls, ['https://example.com/websocket-only']);
});

function source(url: string, content: string): RagSource {
  return { id: url, file: url, title: 'Official docs', content, startLine: 1, endLine: 1, score: 0.9 };
}

function retrieval(verdict: WebRetrievalResult['verdict'], sources: RagSource[], patch: Partial<WebRetrievalResult> & Partial<WebRetrievalResult['diagnostics']> = {}): WebRetrievalResult {
  return {
    question: 'q',
    evidencePlan: {
      subject: 'q',
      claims: [{ id: 'C1', text: 'q', searchQueries: ['q'], preferredDomains: [], sourceTypes: [], subjectTerms: [] }],
      preferredDomains: [],
      planningMethod: 'deterministic-fallback'
    },
    intent: {
      routerVersion: 'test', urls: [], requiredCapabilities: ['web_search'],
      knownUrl: noSignal(), pdf: noSignal(), officialDocs: noSignal(), freshness: noSignal(),
      chineseLanguage: noSignal(), chinaDomestic: noSignal(), dynamicPage: noSignal(), verification: noSignal(),
      vertical: { ...noSignal(), domains: [] }
    },
    queryRoute: {
      policyVersion: 'test', strategy: 'general_web', searchRequired: true, directFetchUrls: [],
      initialQueries: ['q'], providerRoutes: [], reasons: ['test']
    },
    verdict, score: 0.8, retrievalQueries: ['q'], queryAttempts: patch.queryAttempts ?? [], pageAttempts: patch.pageAttempts ?? [], sources,
    claims: [], coverageScore: 0.5, coveredClaimCount: 1, totalClaimCount: 2, uncoveredClaims: [],
    uncoveredBlockingClaims: [], evidenceEntities: [], requiredMentions: [],
    diagnostics: { queriesUsed: 1, pagesFetched: sources.length, queryBudget: 3, pageBudget: 5,
      independentDomains: sources.length ? 1 : 0, durationMs: 25, stopReason: 'test',
      providerAttempts: [], providersUsed: [], fallbackUsed: false,
      budgetExhaustedBy: patch.budgetExhaustedBy,
      subjectConsistencyRate: patch.subjectConsistencyRate,
      subjectMismatchUrls: patch.subjectMismatchUrls }
  };
}

function attempt(query: string, verdict: 'sufficient' | 'weak' | 'empty') {
  return { query, verdict, searchDepth: 'basic' as const, resultCount: 1, selectedUrls: ['https://docs.example.com/api'] };
}

function page(url: string, verdict: 'sufficient' | 'weak' | 'irrelevant' | 'unreadable', selectedChunkCount: number) {
  return { url, title: 'Official docs', domain: 'docs.example.com', verdict, score: 0.8, selectedChunkCount };
}

function noSignal() {
  return { matched: false, confidence: 0, reasons: [] };
}
