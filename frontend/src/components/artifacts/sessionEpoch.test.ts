import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createArtifactSessionToken,
  shouldApplyArtifactSessionResponse
} from './sessionEpoch';

test('late load response is ignored after the conversation epoch changes', () => {
  const loadStarted = createArtifactSessionToken('conversation-a', 1);
  const current = createArtifactSessionToken('conversation-b', 2);

  assert.equal(shouldApplyArtifactSessionResponse(loadStarted, current, true), false);
});

test('late save response is ignored after the same conversation is reloaded into a new epoch', () => {
  const saveStarted = createArtifactSessionToken('conversation-a', 4);
  const current = createArtifactSessionToken('conversation-a', 5);

  assert.equal(shouldApplyArtifactSessionResponse(saveStarted, current, true), false);
  assert.equal(shouldApplyArtifactSessionResponse(saveStarted, saveStarted, true), true);
  assert.equal(shouldApplyArtifactSessionResponse(saveStarted, saveStarted, false), false);
});
