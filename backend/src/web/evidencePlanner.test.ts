import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlmProvider } from '../llm/contracts.js';
import { planWebEvidence } from './evidencePlanner.js';

test('LLM plan dynamically decomposes a broad question into atomic claims and source routes', async () => {
  const llm = fakeLlm(JSON.stringify({
    subject: 'Server-Sent Events',
    claims: [
      {
        id: 'connection-lifecycle',
        text: 'SSE 如何关闭连接并释放资源？',
        searchQueries: ['WHATWG EventSource close connection lifecycle'],
        preferredDomains: ['html.spec.whatwg.org'],
        sourceTypes: ['standard'],
        subjectTerms: ['SSE', 'EventSource']
      },
      {
        id: 'slow-consumer',
        text: 'SSE 服务端如何处理慢消费者？',
        searchQueries: ['Node.js SSE stream backpressure drain'],
        preferredDomains: ['https://nodejs.org/docs/latest/api/stream.html'],
        sourceTypes: ['runtime_docs'],
        subjectTerms: ['SSE']
      }
    ],
    preferredDomains: ['developer.mozilla.org']
  }));
  const plan = await planWebEvidence('SSE 的连接管理和背压怎么优化？', { llm });
  assert.equal(plan.planningMethod, 'llm');
  assert.deepEqual(plan.claims.map((claim) => claim.id), ['connection-lifecycle', 'slow-consumer']);
  assert.deepEqual(plan.preferredDomains, ['developer.mozilla.org', 'html.spec.whatwg.org', 'nodejs.org']);
});

test('invalid model output falls back to generic question decomposition', async () => {
  const plan = await planWebEvidence('比较方案甲、方案乙的成本', { llm: fakeLlm('not json') });
  assert.equal(plan.planningMethod, 'deterministic-fallback');
  assert.deepEqual(plan.claims.map((claim) => claim.text), ['比较方案甲', '方案乙的成本']);
  assert.equal(plan.planningFailure?.reason, 'invalid-response');
  assert.match(plan.planningFailure?.message ?? '', /JSON|Unexpected|not json/i);
});

test('fallback plans model-release research by company instead of punctuation fragments', async () => {
  const plan = await planWebEvidence(
    '检索当前主流的 AI 公司 OpenAI、Anthropic 那些，最近正式宣布但尚未发布、或最近已经发布的新模型',
    { llm: fakeLlm('not json'), currentDate: '2026-08-18' }
  );

  assert.equal(plan.planningMethod, 'deterministic-fallback');
  assert.equal(plan.claims.length, 7);
  assert.deepEqual(plan.claims.slice(0, 2).map((claim) => claim.subjectTerms[0]), ['OpenAI', 'Anthropic']);
  assert.equal(plan.claims.every((claim) => claim.sourceTypes.includes('official_announcement')), true);
  assert.equal(plan.claims.every((claim) => claim.searchQueries.some((query) => query.includes('2026'))), true);
  assert.equal(plan.claims.some((claim) => claim.text === 'Anthropic 那些'), false);
  assert.equal(plan.scopeExpansions?.length, 5);
});

test('replaces stale planner years for latest requests when the user did not pin a year', async () => {
  const plan = await planWebEvidence('OpenAI 最近发布了哪些新模型？', {
    currentDate: '2026-08-18',
    llm: fakeLlm(JSON.stringify({
      subject: 'OpenAI',
      claims: [{
        id: 'latest', text: 'OpenAI 最近发布了哪些新模型？',
        searchQueries: ['OpenAI latest model release 2024 2025'],
        preferredDomains: ['openai.com'], sourceTypes: ['official_announcement'], subjectTerms: ['OpenAI']
      }],
      preferredDomains: ['openai.com']
    }))
  });

  assert.deepEqual(plan.claims[0]?.searchQueries, ['OpenAI latest model release 2026']);
});

test('does not let planning inject unrequested model candidates or rumor intent', async () => {
  const question = 'What models are major companies such as OpenAI and Anthropic preparing to release?';
  const plan = await planWebEvidence(question, { llm: fakeLlm(JSON.stringify({
    subject: 'major AI companies',
    claims: [
      {
        id: 'openai-discovery',
        text: 'What models has OpenAI officially announced for future release?',
        searchQueries: ['site:openai.com OpenAI official model announcement'],
        preferredDomains: ['openai.com'],
        sourceTypes: ['official_announcement'],
        subjectTerms: ['OpenAI'],
        origin: 'user',
        basis: 'OpenAI was named by the user.'
      },
      {
        id: 'invented-model',
        text: 'Will OpenAI release GPT-5.6?',
        searchQueries: ['OpenAI GPT-5.6 rumored release'],
        preferredDomains: ['openai.com'],
        sourceTypes: ['official_announcement'],
        subjectTerms: ['OpenAI'],
        origin: 'user',
        basis: 'Model prior.'
      },
      {
        id: 'google-scope',
        text: 'What models has Google DeepMind officially announced for future release?',
        searchQueries: ['Google DeepMind rumored next model'],
        preferredDomains: ['deepmind.google'],
        sourceTypes: ['official_announcement'],
        subjectTerms: ['Google DeepMind'],
        origin: 'inferred_scope',
        basis: 'The user requested other major companies.'
      }
    ],
    preferredDomains: ['openai.com', 'deepmind.google'],
    scopeExpansions: [{ entity: 'Google DeepMind', reason: 'Major company added to the open-ended category.' }]
  })) });

  assert.deepEqual(plan.claims.map((claim) => claim.id), ['openai-discovery', 'google-scope']);
  assert.doesNotMatch(JSON.stringify(plan), /GPT-5\.6|rumored/);
  assert.equal(plan.claims[1]?.origin, 'inferred_scope');
  assert.deepEqual(plan.scopeExpansions?.map((item) => item.entity), ['Google DeepMind']);
});

test('marks an unrequested API identifier expansion as optional and non-blocking', async () => {
  const plan = await planWebEvidence('搜索 Anthropic 最新的模型有哪些', {
    llm: fakeLlm(JSON.stringify({
      subject: 'Anthropic',
      claims: [
        {
          id: 'latest-models', text: 'Anthropic 当前最新发布的模型有哪些？',
          searchQueries: ['Anthropic latest official model releases'], preferredDomains: ['anthropic.com'],
          sourceTypes: ['official_announcement'], subjectTerms: ['Anthropic'], origin: 'user'
        },
        {
          id: 'api-model-ids', text: 'Anthropic API model IDs 有哪些？',
          searchQueries: ['Anthropic API model IDs'], preferredDomains: ['anthropic.com'],
          sourceTypes: ['official_docs'], subjectTerms: ['Anthropic'], origin: 'user', blocking: true
        }
      ],
      preferredDomains: ['anthropic.com']
    }))
  });

  assert.equal(plan.claims[0]?.priority, 'core');
  assert.equal(plan.claims[0]?.blocking, true);
  assert.equal(plan.claims[1]?.priority, 'optional');
  assert.equal(plan.claims[1]?.blocking, false);
});

test('keeps every explicitly requested company price Claim blocking even if the model marks it optional', async () => {
  const plan = await planWebEvidence('OpenAI公司和Anthropic公司的模型八月份的价钱分别是多少', {
    currentDate: '2026-08-20',
    llm: fakeLlm(JSON.stringify({
      subject: 'OpenAI与Anthropic在2026年8月的模型定价',
      claims: [
        {
          id: 'openai-price',
          text: '截至2026年8月，OpenAI官方API每百万token输入和输出价格是多少？',
          searchQueries: ['OpenAI API pricing 2026'],
          preferredDomains: ['openai.com'], sourceTypes: ['official_docs'],
          subjectTerms: ['OpenAI'], origin: 'user', priority: 'optional', blocking: false
        },
        {
          id: 'anthropic-price',
          text: '截至2026年8月，Anthropic官方API每百万token输入和输出价格是多少？',
          searchQueries: ['Anthropic API pricing 2026'],
          preferredDomains: ['anthropic.com'], sourceTypes: ['official_docs'],
          subjectTerms: ['Anthropic'], origin: 'user', priority: 'optional', blocking: false
        }
      ],
      preferredDomains: ['openai.com', 'anthropic.com']
    }))
  });

  assert.deepEqual(plan.claims.map((claim) => claim.priority), ['core', 'core']);
  assert.equal(plan.claims.every((claim) => claim.blocking), true);
});

function fakeLlm(content: string): LlmProvider {
  return {
    complete: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
    stream: async () => undefined
  };
}
