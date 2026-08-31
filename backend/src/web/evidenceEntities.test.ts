import assert from 'node:assert/strict';
import test from 'node:test';

import { extractPageEntityEvidence, mergeEvidenceEntities } from './evidenceEntities.js';

const claims = [{
  id: 'latest-models',
  text: 'Anthropic 最新发布的模型有哪些？',
  searchQueries: ['Anthropic latest model official release'],
  preferredDomains: ['anthropic.com'],
  sourceTypes: ['official_announcement'],
  subjectTerms: ['Anthropic'],
  priority: 'core' as const,
  blocking: true
}];

test('extracts a versioned model entity from a generic official release pattern', () => {
  const evidence = extractPageEntityEvidence({
    url: 'https://www.anthropic.com/news/claude-nova-7',
    title: 'Introducing Claude Nova 7 \\ Anthropic',
    content: 'Introducing Claude Nova 7\nClaude Nova 7 is our newest reasoning model.',
    claims,
    publishedAt: '2026-07-24'
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.entity, 'Claude Nova 7');
  assert.equal(evidence[0]?.exactEntityMatch, true);
  assert.equal(evidence[0]?.requiredMention, true);
  assert.deepEqual(evidence[0]?.aliases, ['Claude Nova 7', 'Nova 7']);
});

test('does not turn an unrelated official policy title into a required model mention', () => {
  const evidence = extractPageEntityEvidence({
    url: 'https://www.anthropic.com/news/position-open-weights-models',
    title: 'Our position on open-weights models \\ Anthropic',
    content: 'This policy article discusses open-weights models.',
    claims
  });

  assert.deepEqual(evidence, []);
});

test('extracts a compact Chinese release sentence from a planned official domain', () => {
  const vendorClaims = [{
    ...claims[0],
    text: '星河智能最新发布的模型有哪些？',
    searchQueries: ['星河智能 最新模型 官方发布'],
    preferredDomains: ['research.example-ai.cn'],
    subjectTerms: ['星河智能']
  }];
  const evidence = extractPageEntityEvidence({
    url: 'https://research.example-ai.cn/posts/42',
    title: '前沿编程能力与安全能力 - 星河智能',
    content: '今天我们发布NEBULA-7，与NEBULA-6相比，模型的推理与编程能力均有提升。',
    claims: vendorClaims
  });

  assert.deepEqual(evidence.map((item) => item.entity), ['NEBULA-7']);
  assert.equal(evidence[0]?.requiredMention, true);
  assert.equal(evidence[0]?.sourceUrls[0], 'https://research.example-ai.cn/posts/42');
});

test('does not trust the same release sentence on a domain outside the evidence plan', () => {
  const evidence = extractPageEntityEvidence({
    url: 'https://aggregator.example/posts/42',
    title: '模型资讯',
    content: '今天我们发布NEBULA-7，与上一代相比模型能力有所提升。',
    claims: [{ ...claims[0], preferredDomains: ['research.example-ai.cn'] }]
  });

  assert.deepEqual(evidence, []);
});

test('extracts every model from a latest-model comparison table', () => {
  const evidence = extractPageEntityEvidence({
    url: 'https://docs.anthropic.com/zh-CN/docs/about-claude/models',
    title: '模型概述 - Claude Platform Docs',
    content: [
      '### 最新模型对比',
      '',
      '| 特性 | Claude Nova 7 | Claude Orbit 6 | Claude Swift 4.5 |',
      '| --- | --- | --- | --- |',
      '| 描述 | 新一代推理模型 | 复杂智能体模型 | 快速模型 |',
      '| Claude API ID | claude-nova-7 | claude-orbit-6 | claude-swift-4-5 |'
    ].join('\n'),
    claims
  });

  assert.deepEqual(evidence.map((item) => item.entity), [
    'Claude Nova 7', 'Claude Orbit 6', 'Claude Swift 4.5'
  ]);
  assert.equal(evidence.every((item) => item.requiredMention && item.directness === 'direct'), true);
});

test('keeps the newest dated release for each model family in release notes', () => {
  const evidence = extractPageEntityEvidence({
    url: 'https://support.anthropic.com/release-notes',
    title: 'Release notes',
    content: [
      '## July 24, 2026',
      '### Claude Nova 7 发布',
      '## June 30, 2026',
      '### Claude Orbit 6 发布',
      '## May 28, 2026',
      '### Claude Nova 4.8 发布'
    ].join('\n'),
    claims
  });

  assert.deepEqual(evidence.map((item) => item.entity), [
    'Claude Nova 7', 'Claude Orbit 6'
  ]);
  assert.equal(evidence.some((item) => item.entity === 'Claude Nova 4.8'), false);
  assert.equal(evidence.every((item) => item.requiredMention && item.directness === 'direct'), true);
});

test('rejects a Chinese descriptive clause following a negated release statement', () => {
  const evidence = extractPageEntityEvidence({
    url: 'https://docs.anthropic.com/zh-CN/docs/about-claude/models',
    title: '模型概述 - Claude Platform Docs',
    content: 'Claude Mythos 5 并非正式发布：它自同一天起以有限可用性的方式提供给已获批准的客户。',
    claims
  });

  assert.deepEqual(evidence, []);
});

test('merges independent official evidence for the same normalized entity', () => {
  const merged = mergeEvidenceEntities([
    {
      entity: 'Claude Nova 7', aliases: ['Nova 7'], claimIds: ['list'],
      sourceUrls: ['https://www.anthropic.com/'], evidencePatterns: ['Introducing Nova 7'],
      directness: 'direct', requiredMention: true
    },
    {
      entity: 'Claude Nova 7', aliases: ['Claude Nova 7'], claimIds: ['release'],
      sourceUrls: ['https://www.anthropic.com/news/claude-nova-7'], evidencePatterns: ['Claude Nova 7 launch'],
      directness: 'direct', requiredMention: true
    }
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.sourceUrls, [
    'https://www.anthropic.com/',
    'https://www.anthropic.com/news/claude-nova-7'
  ]);
});
