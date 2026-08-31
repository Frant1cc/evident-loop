import assert from 'node:assert/strict';
import test from 'node:test';

import type { ToolTrace } from './types.js';
import { auditWebAnswer, buildAuditedWebFallback } from './webCitationAudit.js';

test('requires every factual statement to cite a supporting Claim URL', () => {
  const traces = [webTrace([supportedClaim()])];
  const failed = auditWebAnswer('The API supports streaming mode.', traces);
  assert.equal(failed.passed, false);
  assert.equal(failed.issues[0]?.type, 'missing_citation');

  const passed = auditWebAnswer(
    'The API supports streaming mode. [official source](https://docs.example.com/api)',
    traces
  );
  assert.equal(passed.passed, true);
});

test('rejects citations that are not bound to the mapped Claim', () => {
  const result = auditWebAnswer(
    'The API supports streaming mode. [source](https://unrelated.example/api)',
    [webTrace([supportedClaim()])]
  );
  assert.equal(result.passed, false);
  assert.equal(result.issues[0]?.type, 'invalid_citation');
});

test('requires unresolved conflicts to be disclosed with both sides cited', () => {
  const claim = {
    ...supportedClaim(),
    supported: false,
    contradicted: true,
    sourceUrls: [],
    contradictingEvidence: [{
      url: 'https://status.example.com/api',
      evidenceQuote: 'Streaming mode is unavailable.',
      authority: 'official'
    }],
    conflict: { status: 'unresolved', requiresHumanReview: true }
  };
  const traces = [webTrace([claim])];
  assert.equal(auditWebAnswer('The API supports streaming mode.', traces).passed, false);
  assert.equal(auditWebAnswer(
    'The API streaming-mode evidence conflicts, so no definitive conclusion is available: [support](https://docs.example.com/api) and [contradiction](https://status.example.com/api).',
    traces
  ).passed, true);
});

test('also keeps an automatically resolved conflict visible in the answer', () => {
  const claim = {
    ...supportedClaim(),
    contradicted: true,
    contradictingEvidence: [{
      url: 'https://blog.example.net/api',
      evidenceQuote: 'Streaming mode is unavailable.',
      authority: 'third_party'
    }],
    conflict: { status: 'resolved_supports', requiresHumanReview: false }
  };
  const traces = [webTrace([claim])];
  assert.equal(auditWebAnswer(
    'The API supports streaming mode. [source](https://docs.example.com/api)',
    traces
  ).passed, false);
  assert.equal(auditWebAnswer(
    'Evidence about whether the API supports streaming mode conflicts; the official source currently wins: [support](https://docs.example.com/api) and [contradiction](https://blog.example.net/api).',
    traces
  ).passed, true);
});

test('safe fallback retains only cited evidence and unresolved conflict disclosure', () => {
  const result = buildAuditedWebFallback([webTrace([supportedClaim()])], 'Check the API');
  assert.match(result, /https:\/\/docs\.example\.com\/api/);
  assert.match(result, /citation-verified results/);
});

test('requires every blocking company Claim in a comparison to appear in the answer', () => {
  const openai = { ...supportedClaim(), subjectTerms: ['OpenAI'] };
  const anthropic = {
    ...supportedClaim(),
    id: 'anthropic-pricing',
    text: 'Anthropic API model pricing',
    subjectTerms: ['Anthropic'],
    sourceUrls: ['https://anthropic.com/pricing'],
    supportingEvidence: [{
      url: 'https://anthropic.com/pricing', evidenceQuote: 'Claude Input $3 Output $15', authority: 'official'
    }]
  };
  const result = auditWebAnswer(
    'OpenAI API pricing is available. [source](https://docs.example.com/api)',
    [webTrace([openai, anthropic])]
  );
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => issue.type === 'missing_claim' && issue.claimIds.includes('anthropic-pricing')));
});

test('Chinese safe fallback localizes common pricing labels and retains multiple price rows', () => {
  const claim = {
    ...supportedClaim(),
    text: 'OpenAI模型价格是多少',
    subjectTerms: ['OpenAI'],
    supportingEvidence: [
      { url: 'https://docs.example.com/a', evidenceQuote: 'GPT-A Pricing Per 1M tokens Input $5 Cached Input $0.5 Output $30', authority: 'official' },
      { url: 'https://docs.example.com/b', evidenceQuote: 'GPT-B Pricing Per 1M tokens Input $2 Cached Input $0.2 Output $12', authority: 'official' }
    ],
    sourceUrls: ['https://docs.example.com/a', 'https://docs.example.com/b']
  };
  const result = buildAuditedWebFallback([webTrace([claim])], '请查询OpenAI模型价格');
  assert.match(result, /GPT-A 定价 每百万 Token 输入 \$5 缓存输入 \$0\.5 输出 \$30/);
  assert.match(result, /GPT-B 定价 每百万 Token 输入 \$2 缓存输入 \$0\.2 输出 \$12/);
});

test('rejects a citation-valid but skeletal answer when rich evidence is available', () => {
  const claim = {
    ...supportedClaim(),
    text: 'OpenAI 模型价格分别是多少',
    subjectTerms: ['OpenAI'],
    sourceUrls: ['https://docs.example.com/pricing'],
    supportingEvidence: [
      { url: 'https://docs.example.com/pricing', evidenceQuote: 'GPT-A Input $5 Output $30', authority: 'official' },
      { url: 'https://docs.example.com/pricing', evidenceQuote: 'GPT-B Input $2 Output $12', authority: 'official' },
      { url: 'https://docs.example.com/pricing', evidenceQuote: 'GPT-C Input $1 Output $6', authority: 'official' }
    ]
  };
  const result = auditWebAnswer(
    'OpenAI 的 GPT-A 输入价格为 $5、输出价格为 $30。[来源](https://docs.example.com/pricing)',
    [webTrace([claim])]
  );
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => issue.type === 'insufficient_detail'));
});

function supportedClaim() {
  return {
    id: 'api-streaming',
    text: 'The API supports streaming mode',
    supported: true,
    contradicted: false,
    sourceUrls: ['https://docs.example.com/api'],
    supportingEvidence: [{
      url: 'https://docs.example.com/api',
      evidenceQuote: 'The API supports streaming mode.',
      authority: 'official'
    }],
    contradictingEvidence: []
  };
}

function webTrace(claims: unknown[]): ToolTrace {
  return {
    id: 'web-call',
    name: 'retrieve_web_evidence',
    arguments: { question: 'Check the API' },
    result: { verdict: 'sufficient', claims }
  };
}
