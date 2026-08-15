import assert from 'node:assert/strict';
import test from 'node:test';

import { rebuildResearchHistory } from './history.js';
import type { ResearchMessage, ResearchStep } from '../../research/types.js';

test('rebuildResearchHistory replays only complete native assistant/tool pairs', () => {
  const messages: ResearchMessage[] = [
    { id: 'user', conversationId: 'c', role: 'user', content: 'question', status: 'complete', createdAt: '2026-01-01' },
    { id: 'assistant', conversationId: 'c', role: 'assistant', content: 'answer', status: 'complete', createdAt: '2026-01-01' }
  ];
  const steps: ResearchStep[] = [
    {
      id: 'decision', conversationId: 'c', messageId: 'assistant', sequence: 1, type: 'llm', status: 'complete', title: 'decision',
      output: {
        role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_knowledge', arguments: '{"q":"x"}' } }]
      },
      startedAt: '2026-01-01'
    },
    {
      id: 'tool', conversationId: 'c', messageId: 'assistant', sequence: 2, type: 'tool', status: 'complete', title: 'search_knowledge',
      parentStepId: 'decision', toolCallId: 'call-1', output: { result: 'evidence' }, startedAt: '2026-01-01'
    },
    // Legacy data deliberately has no parent/call fields and is not injected.
    { id: 'legacy', conversationId: 'c', messageId: 'assistant', sequence: 3, type: 'tool', status: 'complete', title: 'legacy', output: { ignored: true }, startedAt: '2026-01-01' }
  ];

  const history = rebuildResearchHistory(messages, steps);
  assert.deepEqual(history.map((message) => message.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(history[2]?.tool_call_id, 'call-1');
  assert.equal(history[2]?.content, JSON.stringify({ result: 'evidence' }));
});
