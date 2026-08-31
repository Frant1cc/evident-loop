import assert from 'node:assert/strict';
import test from 'node:test';

import { assessClaimCoverage, extractWebClaims, type ClaimEvidence, type WebClaim } from './claims.js';

test('generic fallback extracts claims without a domain-specific dictionary', () => {
  const claims = extractWebClaims('查询数据库连接池大小、事务隔离级别，并给出来源');
  assert.deepEqual(claims.map((claim) => claim.text), ['数据库连接池大小', '事务隔离级别']);
  assert.equal(claims.every((claim) => claim.searchQueries.length > 0), true);
});

test('structured judgments support one claim while leaving another uncovered', () => {
  const claims = [claim('pool-size', '连接池大小'), claim('isolation', '事务隔离级别')];
  const evidence: ClaimEvidence[] = [{
    url: 'https://docs.example.com/database',
    content: 'The pool has a maximum size of 20.',
    judgments: [{
      claimId: 'pool-size', relation: 'supports', confidence: 0.94, chunkIndex: 0,
      evidenceQuote: 'maximum size of 20', reason: 'Directly states the limit.', subjectMatched: true, method: 'llm'
    }]
  }];
  const coverage = assessClaimCoverage(claims, evidence);
  assert.equal(coverage.supportedClaimRatio, 0.5);
  assert.deepEqual(coverage.uncoveredClaims, ['事务隔离级别']);
});

test('a neighboring subject cannot support a claim', () => {
  const claims = [claim('flow-control', 'SSE 慢消费者处理', ['SSE', 'EventSource'])];
  const evidence: ClaimEvidence[] = [{
    url: 'https://example.com/websocket',
    content: 'WebSocket backpressure guidance.',
    judgments: [{
      claimId: 'flow-control', relation: 'irrelevant', confidence: 0.9, chunkIndex: 0,
      evidenceQuote: '', reason: 'The page concerns WebSocket.', subjectMatched: false, method: 'llm'
    }]
  }];
  const coverage = assessClaimCoverage(claims, evidence);
  assert.equal(coverage.claims[0]?.supported, false);
  assert.equal(coverage.subjectConsistencyRate, 0);
});

test('caller-required evidence keeps deterministic exact-group matching', () => {
  const claims: WebClaim[] = [{
    ...claim('cost', 'advanced costs 2 credits'),
    evidenceGroups: [['advanced'], ['2 credits']]
  }];
  const coverage = assessClaimCoverage(claims, [{
    url: 'https://docs.example.com/pricing',
    content: 'Advanced search costs 2 credits.'
  }]);
  assert.equal(coverage.claims[0]?.supported, true);
});

test('third-party URLs cannot support an official announcement claim', () => {
  const strictClaim: WebClaim = {
    ...claim('official-release', 'What model has OpenAI officially announced?', ['OpenAI']),
    preferredDomains: ['openai.com'],
    sourceTypes: ['official_announcement'],
    requiredAuthority: 'official'
  };
  const coverage = assessClaimCoverage([strictClaim], [{
    url: 'https://aggregator.example/openai-roadmap',
    content: 'OpenAI officially announced a future model.',
    judgments: [{
      claimId: strictClaim.id, relation: 'supports', confidence: 0.99, chunkIndex: 0,
      evidenceQuote: 'OpenAI officially announced a future model.', reason: 'Textual support',
      subjectMatched: true, method: 'llm'
    }]
  }]);
  assert.equal(coverage.claims[0]?.supported, false);
});

test('automatically resolves a conflict in favor of the more authoritative source', () => {
  const target = claim('api-mode', 'The API supports streaming mode', ['API']);
  const coverage = assessClaimCoverage([target], [
    judged(target.id, 'https://docs.example.com/api', 'supports', 'Streaming mode is supported.', 'official', '2026-01-01'),
    judged(target.id, 'https://blog.example.net/api', 'contradicts', 'Streaming mode is not supported.', 'third_party', '2026-06-01')
  ]);
  assert.equal(coverage.conflicts[0]?.status, 'resolved_supports');
  assert.equal(coverage.claims[0]?.supported, true);
  assert.deepEqual(coverage.claims[0]?.sourceUrls, ['https://docs.example.com/api']);
});

test('uses publication time when equally authoritative sources conflict', () => {
  const target = claim('release-status', 'The release is generally available', ['release']);
  const coverage = assessClaimCoverage([target], [
    judged(target.id, 'https://old.example.com/release', 'supports', 'The release is generally available.', 'official', '2026-01-01'),
    judged(target.id, 'https://new.example.com/release', 'contradicts', 'The release has been withdrawn.', 'official', '2026-02-01')
  ]);
  assert.equal(coverage.conflicts[0]?.status, 'resolved_contradicts');
  assert.equal(coverage.claims[0]?.supported, false);
});

test('requires two independent winning sources to resolve a high-risk conflict', () => {
  const target = claim('medical-dose', 'The medical treatment requires a 20 mg dose', ['treatment']);
  const coverage = assessClaimCoverage([target], [
    judged(target.id, 'https://regulator.example/dose', 'supports', 'Use a 20 mg dose.', 'official', '2026-02-01'),
    judged(target.id, 'https://clinic.example/dose', 'contradicts', 'Do not use a 20 mg dose.', 'third_party', '2026-01-01')
  ]);
  assert.equal(coverage.conflicts[0]?.status, 'unresolved');
  assert.equal(coverage.conflicts[0]?.requiresHumanReview, true);
  assert.equal(coverage.claims[0]?.supported, false);
});

test('does not establish a high-risk claim from only one supporting domain', () => {
  const target = claim('investment-return', 'The investment guarantees a financial return', ['investment']);
  const oneSource = assessClaimCoverage([target], [
    judged(target.id, 'https://regulator.example/return', 'supports', 'The return is guaranteed.', 'official', '2026-02-01')
  ]);
  assert.equal(oneSource.claims[0]?.supported, false);

  const corroborated = assessClaimCoverage([target], [
    judged(target.id, 'https://regulator.example/return', 'supports', 'The return is guaranteed.', 'official', '2026-02-01'),
    judged(target.id, 'https://exchange.example/return', 'supports', 'The return is guaranteed.', 'official', '2026-02-01')
  ]);
  assert.equal(corroborated.claims[0]?.supported, true);
});

function claim(id: string, text: string, subjectTerms: string[] = []): WebClaim {
  return {
    id,
    text,
    searchQueries: [text],
    preferredDomains: [],
    sourceTypes: [],
    subjectTerms
  };
}

function judged(
  claimId: string,
  url: string,
  relation: 'supports' | 'contradicts',
  evidenceQuote: string,
  authority: ClaimEvidence['authority'],
  publishedAt: string
): ClaimEvidence {
  return {
    url,
    content: evidenceQuote,
    authority,
    publishedAt,
    judgments: [{
      claimId,
      relation,
      confidence: 0.9,
      chunkIndex: 0,
      evidenceQuote,
      reason: 'Direct evidence.',
      subjectMatched: true,
      method: 'llm'
    }]
  };
}
