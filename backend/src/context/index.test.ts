import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleSummaryView,
  prepareContext,
  TOOL_RESULT_MICRO_LIMIT_CHARS,
  TRUNCATED_TOOL_RESULT_MARKER
} from './index.js';
import type { ChatMessage } from '../llm/contracts.js';

function toolPair(id: string, content: string): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'search_knowledge', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: id, content }
  ];
}

test('micro compression truncates only old tool results and preserves whole recent tool pairs', () => {
  const oldToolContent = 'a'.repeat(TOOL_RESULT_MICRO_LIMIT_CHARS + 25);
  const messages: ChatMessage[] = [
    { role: 'system', content: 'rules' },
    ...toolPair('old-call', oldToolContent),
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    ...toolPair('new-call', 'recent tool result')
  ];

  const prepared = prepareContext({
    canonicalMessages: messages,
    state: {},
    // Force the policy under test without a huge fixture.
    tools: [{ schema: 'x'.repeat(400_000) }]
  });

  assert.equal(prepared.level, 'micro');
  const oldResult = prepared.messages.find((message) => message.tool_call_id === 'old-call');
  const newResult = prepared.messages.find((message) => message.tool_call_id === 'new-call');
  assert.equal(oldResult?.content.length, TOOL_RESULT_MICRO_LIMIT_CHARS + 1 + TRUNCATED_TOOL_RESULT_MARKER.length);
  assert.match(oldResult?.content ?? '', new RegExp(TRUNCATED_TOOL_RESULT_MARKER));
  assert.equal(newResult?.content, 'recent tool result');
  assert.ok(prepared.messages.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'old-call'));
});

test('large-summary view keeps latest five logical units plus three final assistant replies in source order', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: 'u4' },
    { role: 'assistant', content: 'a4' },
    ...toolPair('call-5', 'tool-5'),
    { role: 'assistant', content: 'a5' },
    { role: 'user', content: 'u6' },
    { role: 'assistant', content: 'a6' }
  ];

  const view = assembleSummaryView(messages, '<summary>compressed</summary>');
  const contents = view.map((message) => message.content);
  assert.equal(contents[1], '<context-summary>\n<summary>compressed</summary>\n</context-summary>');
  assert.ok(contents.includes('a4'), 'recent-three reply tail is retained');
  assert.ok(contents.includes('tool-5'), 'tool pair in recent-five tail is retained');
  assert.ok(!contents.includes('u1'), 'older ordinary history is represented by the summary');
  assert.ok(!contents.includes('a1'), 'older final reply outside recent-three is omitted');
  const callIndex = view.findIndex((message) => message.tool_calls?.[0]?.id === 'call-5');
  assert.equal(view[callIndex + 1]?.tool_call_id, 'call-5');
});

test('a persisted large summary never falls back to raw history below the next 90% threshold', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'intermediate request' },
    { role: 'assistant', content: 'intermediate answer' },
    { role: 'user', content: 'new request' },
    { role: 'assistant', content: 'new answer' },
    { role: 'user', content: 'latest request' }
  ];

  const prepared = prepareContext({
    canonicalMessages: messages,
    state: { summary: '<summary>old context</summary>', lastPromptTokens: 1_000, lastCanonicalTokens: 500 },
    summaryContent: '<summary>old context</summary>'
  });

  assert.equal(prepared.level, 'summary');
  assert.ok(prepared.messages.some((message) => message.content.includes('<context-summary>')));
  assert.ok(!prepared.messages.some((message) => message.content === 'old request'));
});

test('a new session memory remains injected after a large-summary checkpoint', () => {
  const prepared = prepareContext({
    canonicalMessages: [{ role: 'user', content: 'new request' }],
    state: { summary: '<summary>old context</summary>' },
    summaryContent: '<summary>old context</summary>',
    sessionMemoryContent: '<current-task>continue</current-task>'
  });

  assert.ok(prepared.messages.some((message) => message.content.includes('<session-memory>')));
});

test('evidence manifest is prepended as the first system message when supplied', () => {
  const prepared = prepareContext({
    canonicalMessages: [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'reply' }
    ],
    state: {},
    evidenceManifestContent: '【已检索证据】\n[S1] title\n【证据清单结束】'
  });

  assert.equal(prepared.evidenceManifestInjected, true);
  assert.equal(prepared.messages[0]?.role, 'system');
  assert.match(prepared.messages[0]?.content ?? '', /【已检索证据】/);
  assert.match(prepared.messages[1]?.content ?? '', /question/);
});

test('evidence manifest is not injected when content is empty, whitespace, or omitted', () => {
  const baseline = prepareContext({
    canonicalMessages: [{ role: 'user', content: 'question' }],
    state: {}
  });
  const emptyString = prepareContext({
    canonicalMessages: [{ role: 'user', content: 'question' }],
    state: {},
    evidenceManifestContent: ''
  });
  const whitespaceOnly = prepareContext({
    canonicalMessages: [{ role: 'user', content: 'question' }],
    state: {},
    evidenceManifestContent: '   \n\t  '
  });

  assert.equal(baseline.evidenceManifestInjected, false);
  assert.equal(emptyString.evidenceManifestInjected, false);
  assert.equal(whitespaceOnly.evidenceManifestInjected, false);
  assert.equal(baseline.messages.length, emptyString.messages.length);
  assert.equal(baseline.messages.length, whitespaceOnly.messages.length);
  for (const prepared of [baseline, emptyString, whitespaceOnly]) {
    assert.equal(prepared.messages.find((message) => message.role === 'system' && /【已检索证据】/.test(message.content ?? '')), undefined);
  }
});

test('evidence manifest injection is independent of summary level', () => {
  const prepared = prepareContext({
    canonicalMessages: [{ role: 'user', content: 'new request' }],
    state: { summary: '<summary>old</summary>' },
    summaryContent: '<summary>old</summary>',
    evidenceManifestContent: '【已检索证据】\n[S1] cited\n【证据清单结束】'
  });

  assert.equal(prepared.level, 'summary');
  assert.equal(prepared.evidenceManifestInjected, true);
  // Manifest must come BEFORE the context-summary block, so the model sees the navigation aid first.
  const manifestIndex = prepared.messages.findIndex((message) => /【已检索证据】/.test(message.content ?? ''));
  const summaryIndex = prepared.messages.findIndex((message) => /<context-summary>/.test(message.content ?? ''));
  assert.ok(manifestIndex >= 0 && summaryIndex > manifestIndex, 'manifest precedes context-summary');
});
