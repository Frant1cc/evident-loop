import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSourceLinkNumberMap, normalizeSourceHref } from './sourceReferences';

const sources = [
  {
    citationKey: 'S3',
    file: 'https://example.com/report/',
    title: 'Example report',
    content: 'Evidence excerpt'
  }
];

test('source links reuse the matching citation number', () => {
  const numbers = buildSourceLinkNumberMap(
    '结论 [来源](https://example.com/report#section)',
    sources
  );

  assert.equal(numbers.get('https://example.com/report'), 3);
});

test('unmatched source links receive stable sequential numbers', () => {
  const content = [
    '[来源](https://example.net/a)',
    '[普通链接](https://example.net/ignored)',
    '[source](https://example.net/b)',
    '[来源](https://example.net/a)'
  ].join(' ');
  const numbers = buildSourceLinkNumberMap(content, sources);

  assert.equal(numbers.get('https://example.net/a'), 4);
  assert.equal(numbers.get('https://example.net/b'), 5);
  assert.equal(numbers.has('https://example.net/ignored'), false);
});

test('source URL normalization ignores fragments and trailing slashes', () => {
  assert.equal(
    normalizeSourceHref('https://example.com/report/#details'),
    'https://example.com/report'
  );
});
