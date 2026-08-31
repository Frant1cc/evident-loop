import assert from 'node:assert/strict';
import test from 'node:test';

import { serializeToolResultForModel } from './toolResultSerializer.js';

test('preserves web verdict, claim support and source URLs within the model budget', () => {
  const payload = {
    question: 'A broad question',
    evidencePlan: { claims: Array.from({ length: 8 }, (_, index) => ({
      id: `plan-${index}`,
      text: 'planned detail '.repeat(80),
      searchQueries: ['query '.repeat(100)]
    })) },
    verdict: 'exhausted',
    score: 0.72,
    coveredClaimCount: 5,
    totalClaimCount: 8,
    coverageScore: 0.63,
    claims: Array.from({ length: 8 }, (_, index) => ({
      id: `C${index + 1}`,
      text: `Claim ${index + 1} ${'specific detail '.repeat(12)}`,
      supported: index < 5,
      contradicted: false,
      score: index < 5 ? 0.9 : 0,
      sourceUrls: index < 5 ? [`https://example.com/source-${index + 1}`] : []
    })),
    uncoveredClaims: ['Claim 6', 'Claim 7', 'Claim 8'],
    uncoveredBlockingClaims: [],
    evidenceEntities: [{
      entity: 'Claude Nova 7', aliases: ['Nova 7'], claimIds: ['C1'],
      sourceUrls: ['https://example.com/source-1'], evidencePatterns: ['Introducing Claude Nova 7'],
      directness: 'direct', requiredMention: true
    }],
    requiredMentions: [{
      entity: 'Claude Nova 7', aliases: ['Nova 7'], claimIds: ['C1'],
      sourceUrls: ['https://example.com/source-1'], evidencePatterns: ['Introducing Claude Nova 7'],
      directness: 'direct', requiredMention: true
    }],
    sources: [{ title: 'Primary source', file: 'https://example.com/source-1', score: 0.9, content: 'x'.repeat(20_000) }],
    queryAttempts: Array.from({ length: 20 }, () => ({ debug: 'x'.repeat(1_000) })),
    diagnostics: {
      queriesUsed: 5,
      pagesFetched: 10,
      acceptedPages: 3,
      rejectedPages: 7,
      queryBudget: 5,
      pageBudget: 8,
      fetchAttemptBudget: 16,
      budgetExhaustedBy: 'queries',
      recoveryTriggered: true,
      recoveryQueriesUsed: 2,
      planningFailure: { reason: 'invalid-response', message: 'Planner returned invalid JSON.' },
      durationMs: 515_979,
      stopReason: 'Page budget exhausted before evidence became sufficient',
      providerAttempts: Array.from({ length: 20 }, () => ({ debug: 'x'.repeat(1_000) }))
    }
  };

  const serialized = serializeToolResultForModel('retrieve_web_evidence', payload, 4_000);
  const result = JSON.parse(serialized) as Record<string, unknown>;

  assert.ok(serialized.length <= 4_000);
  assert.equal(result.verdict, 'exhausted');
  assert.match(serialized, /https:\/\/example\.com\/source-1/);
  assert.match(serialized, /"supported":true/);
  assert.match(serialized, /Claim 8/);
  assert.match(serialized, /"recoveryTriggered":true/);
  assert.match(serialized, /Planner returned invalid JSON/);
  assert.match(serialized, /"acceptedPages":3/);
  assert.match(serialized, /Claude Nova 7/);
  assert.match(serialized, /"requiredMention":true/);
  assert.doesNotMatch(serialized, /providerAttempts/);
});

test('generic oversized results use a valid head and tail JSON envelope', () => {
  const serialized = serializeToolResultForModel('custom_tool', {
    start: 'important-start',
    body: 'x'.repeat(10_000),
    end: 'important-end'
  }, 500);
  const result = JSON.parse(serialized) as { truncated: boolean; head: string; tail: string };

  assert.ok(serialized.length <= 500);
  assert.equal(result.truncated, true);
  assert.match(result.head, /important-start/);
  assert.match(result.tail, /important-end/);
});

test('keeps multiple grounded evidence quotes for detailed comparison answers', () => {
  const serialized = serializeToolResultForModel('retrieve_web_evidence', {
    verdict: 'sufficient', coveredClaimCount: 2, totalClaimCount: 2, coverageScore: 1,
    claims: [{
      id: 'openai-price', text: 'OpenAI model prices', supported: true, contradicted: false,
      sourceUrls: ['https://openai.com/api/pricing'],
      supportingEvidence: [
        { url: 'https://openai.com/api/pricing', evidenceQuote: 'GPT-A Input $5 Output $30', authority: 'official' },
        { url: 'https://openai.com/api/pricing', evidenceQuote: 'GPT-B Input $2 Output $12', authority: 'official' }
      ]
    }],
    sources: [], diagnostics: {}
  }, 4_000);

  assert.match(serialized, /GPT-A Input \$5 Output \$30/);
  assert.match(serialized, /GPT-B Input \$2 Output \$12/);
});
