import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSourceFreshness } from './freshness.js';

const nowMs = Date.parse('2026-08-17T00:00:00Z');
const page = {
  url: 'https://example.com/news', title: 'News', totalChars: 500,
  content: 'Useful article content '.repeat(30), truncated: false, chunks: []
};

test('rejects a provider-dated result outside the requested month', () => {
  const result = resolveSourceFreshness({
    candidate: { title: 'Old post', url: page.url, snippet: '', publishedAt: '2025-07-22T07:05:18Z' },
    page,
    timeRange: 'month',
    nowMs
  });
  assert.equal(result.status, 'outside_window');
});

test('extracts an escaped labeled publication date from fetched content', () => {
  const result = resolveSourceFreshness({
    candidate: { title: 'Post', url: page.url, snippet: '' },
    page: { ...page, content: 'Posted: 2026\\-08\\-10T07:05:18.000Z\n' + page.content },
    timeRange: 'month',
    nowMs
  });
  assert.equal(result.status, 'matched');
  assert.match(result.publishedAt ?? '', /^2026-08-10/);
});

test('marks undated time-sensitive sources as unknown', () => {
  const result = resolveSourceFreshness({
    candidate: { title: 'Undated', url: page.url, snippet: '' },
    page,
    timeRange: 'week',
    nowMs
  });
  assert.equal(result.status, 'unknown');
});
