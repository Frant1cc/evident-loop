import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeToolPolicy } from './policy.js';

test('normalizes legacy search_docs policies before deduplication', () => {
  assert.deepEqual(
    normalizeToolPolicy({ mode: 'selected', names: ['search_docs', 'search_knowledge', 'read_document'] }),
    { mode: 'selected', names: ['search_knowledge', 'read_document'] }
  );
  assert.deepEqual(normalizeToolPolicy(['search_docs']), {
    mode: 'selected',
    names: ['search_knowledge']
  });
});

test('keeps the historical empty-array policy semantics', () => {
  assert.deepEqual(normalizeToolPolicy([]), { mode: 'all' });
});
