import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessPageQuality,
  assessSearchQuality,
  canonicalizeWebUrl,
  scoreSearchResults,
  selectDiverseSearchResults
} from './quality.js';

test('canonicalizes tracking URLs and deduplicates search results', () => {
  const scored = scoreSearchResults('DeepSeek context window', [
    {
      title: 'DeepSeek context window documentation',
      url: 'https://Docs.Example.com/models/?utm_source=newsletter&a=1#context',
      snippet: 'Official model context window details.',
      score: 0.9
    },
    {
      title: 'Duplicate result',
      url: 'https://docs.example.com/models?a=1',
      snippet: 'Less useful duplicate.',
      score: 0.4
    }
  ]);

  assert.equal(canonicalizeWebUrl('https://Docs.Example.com/models/?utm_source=x&a=1#top'), 'https://docs.example.com/models?a=1');
  assert.equal(scored.length, 1);
  assert.equal(scored[0]?.domain, 'docs.example.com');
  assert.equal(assessSearchQuality(scored).verdict, 'sufficient');
});

test('selects independent domains before taking a second page from the same domain', () => {
  const scored = scoreSearchResults('agent search quality', [
    { title: 'Agent search quality A', url: 'https://a.example/1', snippet: 'agent search quality', score: 0.95 },
    { title: 'Agent search quality B', url: 'https://a.example/2', snippet: 'agent search quality', score: 0.90 },
    { title: 'Agent search quality C', url: 'https://b.example/1', snippet: 'agent search quality', score: 0.85 }
  ]);

  const selected = selectDiverseSearchResults(scored, new Set(), 2);
  assert.deepEqual(selected.map((item) => item.domain), ['a.example', 'b.example']);
});

test('ranks an exact official model release ahead of generic official background pages', () => {
  const scored = scoreSearchResults('Anthropic model release', [
    {
      title: 'Our position on open-weights models',
      url: 'https://www.anthropic.com/news/position-open-weights-models',
      snippet: 'Anthropic discusses models, safety and release policy.',
      score: 1
    },
    {
      title: 'Introducing Claude Nova 7 \\ Anthropic',
      url: 'https://www.anthropic.com/news/claude-nova-7',
      snippet: 'Claude Nova 7 is our latest model release.',
      score: 0.6
    }
  ], ['anthropic.com']);

  assert.equal(scored[0]?.title, 'Introducing Claude Nova 7 \\ Anthropic');
  assert.equal(scored[0]?.releaseTier, 0);
  assert.equal(scored[0]?.directReleaseMatch, true);
});

test('ranks a current model index ahead of an undated exact release page for latest queries', () => {
  const scored = scoreSearchResults('Anthropic latest models', [
    {
      title: 'Introducing Claude Nova 4.6',
      url: 'https://www.anthropic.com/news/claude-nova-4-6',
      snippet: 'A model release announcement.',
      score: 0.99
    },
    {
      title: 'Release notes | Anthropic Help Center',
      url: 'https://support.anthropic.com/en/articles/12138966-release-notes',
      snippet: 'Current model launches and product updates.',
      score: 0.72
    }
  ], ['anthropic.com']);

  assert.equal(scored[0]?.title, 'Release notes | Anthropic Help Center');
  assert.equal(scored[0]?.releaseTier, 0);
  assert.equal(scored[1]?.releaseTier, 1);
});

test('rejects a readable page when none of its chunks match the question', () => {
  const [result] = scoreSearchResults('DeepSeek context window', [
    { title: 'DeepSeek release', url: 'https://example.com/release', snippet: 'DeepSeek release notes', score: 0.7 }
  ]);
  assert.ok(result);

  const quality = assessPageQuality('DeepSeek context window', result, {
    url: result.url,
    title: result.title,
    totalChars: 2_000,
    content: 'A long article about cooking and garden plants.'.repeat(20),
    truncated: true,
    chunks: [
      { index: 0, chars: 500, content: 'A long article about cooking and garden plants.'.repeat(10) }
    ]
  });

  assert.equal(quality.verdict, 'irrelevant');
  assert.equal(quality.chunks.length, 0);
});
