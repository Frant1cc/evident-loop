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

