import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGenerationDraftRevision,
  hasUnpersistedDraftChanges,
  markGenerationDraftPersisted,
  nextDraftRevision,
  observeGenerationDraftRevision
} from './draftRevision';

test('draft revision remains dirty until the matching save revision is persisted', () => {
  let draftRevision = 0;
  let persistedRevision = 0;
  draftRevision = nextDraftRevision(draftRevision);
  assert.equal(hasUnpersistedDraftChanges({ draftRevision, persistedRevision }), true);
  persistedRevision = draftRevision;
  assert.equal(hasUnpersistedDraftChanges({ draftRevision, persistedRevision }), false);
  draftRevision = nextDraftRevision(draftRevision);
  assert.equal(hasUnpersistedDraftChanges({ draftRevision, persistedRevision }), true);
});

test('generation revision records stay isolated when an older save resolves after switching versions', () => {
  const first = observeGenerationDraftRevision(
    createGenerationDraftRevision('generation-a', '{"title":"a"}'),
    '{"title":"a*"}'
  );
  const second = observeGenerationDraftRevision(
    createGenerationDraftRevision('generation-b', '{"title":"b"}'),
    '{"title":"b*"}'
  );
  const persistedFirst = markGenerationDraftPersisted(first, first.draftRevision, '{"title":"a*"}');
  assert.equal(hasUnpersistedDraftChanges(persistedFirst), false);
  assert.equal(hasUnpersistedDraftChanges(second), true);
  assert.equal(second.generationId, 'generation-b');
});
