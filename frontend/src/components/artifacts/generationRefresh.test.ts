import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactDraftRequest, ResearchArtifactGeneration } from '../../types/artifacts';
import { resolveRequestedGeneration, resolveRunGeneration, shouldApplyGenerationRefresh } from './generationRefresh';

test('an earlier empty refresh cannot overwrite the later run-completion refresh', () => {
  const earlier = { conversationId: 'conversation-1', sessionEpoch: 3, sequence: 8 };
  const later = { conversationId: 'conversation-1', sessionEpoch: 3, sequence: 9 };

  assert.equal(shouldApplyGenerationRefresh(earlier, later), false);
  assert.equal(shouldApplyGenerationRefresh(later, later), true);
});

test('a queued tool request resolves to its final generation instead of relying on list order', () => {
  const requests = [{
    id: 'request-1',
    conversationId: 'conversation-1',
    researchRunId: 'run-1',
    status: 'completed',
    generationId: 'generation-2',
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:01.000Z',
    completedAt: '2026-09-08T00:00:01.000Z'
  }] satisfies ArtifactDraftRequest[];
  const generations = [
    { id: 'generation-1' },
    { id: 'generation-2' }
  ] as ResearchArtifactGeneration[];

  assert.equal(resolveRequestedGeneration('request-1', requests, generations)?.id, 'generation-2');
  assert.equal(resolveRequestedGeneration('generation-1', requests, generations)?.id, 'generation-1');
});

test('run completion opens only the draft created by that research run', () => {
  const requests = [
    {
      id: 'request-old',
      conversationId: 'conversation-1',
      researchRunId: 'run-old',
      status: 'completed',
      generationId: 'generation-old',
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:01.000Z'
    },
    {
      id: 'request-current',
      conversationId: 'conversation-1',
      researchRunId: 'run-current',
      status: 'completed',
      generationId: 'generation-current',
      createdAt: '2026-09-08T00:01:00.000Z',
      updatedAt: '2026-09-08T00:01:01.000Z'
    }
  ] satisfies ArtifactDraftRequest[];
  const generations = [
    { id: 'generation-old' },
    { id: 'generation-current' }
  ] as ResearchArtifactGeneration[];

  assert.equal(resolveRunGeneration('run-current', requests, generations)?.id, 'generation-current');
  assert.equal(resolveRunGeneration('run-without-draft', requests, generations), undefined);
});
