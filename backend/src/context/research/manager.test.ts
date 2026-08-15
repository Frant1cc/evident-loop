import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb } from '../../db.js';
import type { LlmProvider } from '../../llm/contracts.js';
import { buildEvidenceManifest, createResearchContextManager, formatEvidenceManifest } from './manager.js';
import {
  addResearchSource,
  createResearchConversation,
  createResearchMessage,
  deleteResearchConversation,
  getResearchConversation,
  updateResearchContextState
} from '../../research/store.js';
import type { RagSource } from '../../rag/types.js';

initDb();

const validSessionMemory = `
<current-task>continue research</current-task>
<completed-work>retrieved evidence</completed-work>
<next-step>answer the user</next-step>
<confirmed-facts>fact A</confirmed-facts>
<core-constraints>cite sources</core-constraints>`;

const validSummary = `
<user-main-request>answer the research question</user-main-request>
<tool-calls-and-results>search returned evidence</tool-calls-and-results>
<answers-provided>none</answers-provided>
<pending-tasks>compose answer</pending-tasks>
<current-progress>research active</current-progress>
<suggested-next-step>answer with evidence</suggested-next-step>
<confirmed-facts>fact A</confirmed-facts>
<core-constraints>cite sources</core-constraints>
<cited-evidence-keys>S1, S3</cited-evidence-keys>`;

function provider(returnText: string): LlmProvider {
  return {
    complete: async () => ({ choices: [{ message: { role: 'assistant', content: returnText } }] }),
    stream: async () => undefined
  };
}

test('session memory is asynchronous, persisted, and injected as a system message', async () => {
  const conversation = createResearchConversation();
  try {
    const manager = createResearchContextManager({ conversationId: conversation.id, llm: provider(validSessionMemory), model: 'test' });
    const messages = [{ role: 'user' as const, content: 'x'.repeat(21_000) }];
    const first = await manager.prepare({ messages, model: 'test' });
    assert.equal(first.length, 1, 'the initial request does not wait for the worker');
    await waitFor(() => Boolean(getResearchConversation(conversation.id)?.contextState?.sessionMemory));

    const second = await manager.prepare({ messages, model: 'test' });
    assert.equal(second[0]?.role, 'system');
    assert.match(second[0]?.content ?? '', /<system-message><session-memory>/);
    assert.equal(getResearchConversation(conversation.id)?.contextState?.sessionMemoryPending, false);
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('large compression persists structured summary with the complete user-message list', async () => {
  const conversation = createResearchConversation();
  try {
    const manager = createResearchContextManager({ conversationId: conversation.id, llm: provider(validSummary), model: 'test' });
    const originalUserMessage = `important instruction ${'y'.repeat(440_000)}`;
    const result = await manager.prepare({
      messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: originalUserMessage }],
      model: 'test'
    });
    assert.ok(result.some((message) => message.content.includes('<context-summary>')));
    const state = getResearchConversation(conversation.id)?.contextState;
    assert.match(state?.summary ?? '', /<all-user-messages>/);
    assert.match(state?.summary ?? '', /important instruction/);
    assert.equal(state?.sessionMemory, undefined);
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('a stale persisted memory-pending flag is retried after a process restart', async () => {
  const conversation = createResearchConversation();
  try {
    updateResearchContextState(conversation.id, { sessionMemoryPending: true });
    const manager = createResearchContextManager({ conversationId: conversation.id, llm: provider(validSessionMemory), model: 'test' });
    await manager.prepare({ messages: [{ role: 'user', content: 'x'.repeat(21_000) }], model: 'test' });
    await waitFor(() => Boolean(getResearchConversation(conversation.id)?.contextState?.sessionMemory));
    assert.equal(getResearchConversation(conversation.id)?.contextState?.sessionMemoryPending, false);
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for session memory');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function seedSource(messageId: string, source: Partial<RagSource> & Pick<RagSource, 'id' | 'file' | 'title' | 'content'>, citationKey: string) {
  addResearchSource(messageId, {
    startLine: 1,
    endLine: source.content.split('\n').length,
    score: 0.85,
    contentType: 'text',
    ...source
  }, citationKey);
}

function manifestMessage(messages: { role: string; content?: string }[]) {
  return messages.find((message) => /【已检索证据/.test(message.content ?? ''));
}

test('evidence manifest is not injected before summary compression has ever occurred', async () => {
  const conversation = createResearchConversation();
  try {
    // Even with sources already present, no compression means no injection.
    const message = createResearchMessage({ conversationId: conversation.id, role: 'assistant', content: 'x', status: 'complete' });
    seedSource(message.id, { id: 'src-1', file: 'a.md', title: 'A', content: 'A body' }, 'S1');

    const manager = createResearchContextManager({ conversationId: conversation.id, llm: provider(validSummary), model: 'test' });

    const first = await manager.prepare({ messages: [{ role: 'user', content: 'short question' }], model: 'test' });
    assert.equal(manifestMessage(first), undefined, 'first call has no manifest');

    const second = await manager.prepare({ messages: [{ role: 'user', content: 'short follow-up' }], model: 'test' });
    assert.equal(manifestMessage(second), undefined, 'second call also has no manifest');

    const state = getResearchConversation(conversation.id)?.contextState;
    assert.equal(state?.manifestInjectedSummaryCheckpoint, undefined);
    assert.equal(state?.summaryCheckpointTokens, undefined);
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('evidence manifest is injected exactly once per summary-compression event', async () => {
  const conversation = createResearchConversation();
  try {
    const message = createResearchMessage({ conversationId: conversation.id, role: 'assistant', content: 'x', status: 'complete' });
    seedSource(message.id, { id: 'src-A', file: 'https://example.com/a', title: 'Article A', heading: 'example.com', content: 'A body content for the manifest' }, 'S1');
    seedSource(message.id, { id: 'src-B', file: 'b.md', title: 'Doc B', heading: 'Doc B', content: 'B body content for the manifest' }, 'S2');

    const manager = createResearchContextManager({ conversationId: conversation.id, llm: provider(validSummary), model: 'test' });

    // 1) Force compression: huge user message blows past SUMMARY_COMPRESSION_TOKENS.
    //    At entry to this call, summaryCheckpointTokens is undefined → shouldInject is false → no manifest.
    const hugeMessage = 'x'.repeat(440_000);
    const compressionCall = await manager.prepare({
      messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: hugeMessage }],
      model: 'test'
    });
    assert.equal(manifestMessage(compressionCall), undefined, 'the call that triggers compression does not yet inject');
    const stateAfterCompression = getResearchConversation(conversation.id)?.contextState;
    assert.notEqual(stateAfterCompression?.summaryCheckpointTokens, undefined, 'summaryCheckpointTokens is set after compression');
    assert.equal(stateAfterCompression?.manifestInjectedSummaryCheckpoint, undefined, 'no injection happened in the call that just compressed');

    // 2) First prepare() AFTER compression: manifest should now appear.
    const firstAfterCompression = await manager.prepare({
      messages: [{ role: 'user', content: 'follow-up question' }],
      model: 'test'
    });
    const injected = manifestMessage(firstAfterCompression);
    assert.ok(injected, 'manifest must be injected on the first prepare() after compression');
    assert.match(injected?.content ?? '', /\[S1\]/);
    assert.match(injected?.content ?? '', /\[S2\]/);
    assert.match(injected?.content ?? '', /A body content/);
    assert.match(injected?.content ?? '', /B body content/);

    const stateAfterInjection = getResearchConversation(conversation.id)?.contextState;
    assert.equal(stateAfterInjection?.manifestInjectedSummaryCheckpoint, stateAfterCompression?.summaryCheckpointTokens,
      'manifestInjectedSummaryCheckpoint must equal the checkpoint that was injected for');

    // 3) Second prepare() AFTER injection: must NOT re-inject.
    const secondAfterInjection = await manager.prepare({
      messages: [{ role: 'user', content: 'another question' }],
      model: 'test'
    });
    assert.equal(manifestMessage(secondAfterInjection), undefined, 'subsequent prepare() calls do not re-inject');
    assert.equal(getResearchConversation(conversation.id)?.contextState?.manifestInjectedSummaryCheckpoint,
      stateAfterCompression?.summaryCheckpointTokens);
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('a new summary-compression event triggers a fresh manifest injection', async () => {
  const conversation = createResearchConversation();
  try {
    const message = createResearchMessage({ conversationId: conversation.id, role: 'assistant', content: 'x', status: 'complete' });
    seedSource(message.id, { id: 'src-First', file: 'first.md', title: 'First', content: 'First body' }, 'S1');

    const manager = createResearchContextManager({ conversationId: conversation.id, llm: provider(validSummary), model: 'test' });

    // First compression
    await manager.prepare({
      messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'x'.repeat(440_000) }],
      model: 'test'
    });

    // First post-compression prepare() injects
    const firstAfter = await manager.prepare({ messages: [{ role: 'user', content: 'q1' }], model: 'test' });
    assert.ok(manifestMessage(firstAfter));

    // Subsequent prepares do not re-inject
    const secondAfter = await manager.prepare({ messages: [{ role: 'user', content: 'q2' }], model: 'test' });
    assert.equal(manifestMessage(secondAfter), undefined);

    // Add another source to the DB so the next manifest will be richer
    seedSource(message.id, { id: 'src-Second', file: 'second.md', title: 'Second', content: 'Second body' }, 'S2');

    // Second compression event with a strictly larger message so summaryCheckpointTokens advances.
    await manager.prepare({
      messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'y'.repeat(500_000) }],
      model: 'test'
    });

    const stateBetween = getResearchConversation(conversation.id)?.contextState;
    assert.notEqual(stateBetween?.summaryCheckpointTokens, stateBetween?.manifestInjectedSummaryCheckpoint,
      'after a strictly larger second compression, the checkpoint must have moved past the last injection marker');

    // The next prepare() must inject again, picking up S2.
    const afterSecondCompression = await manager.prepare({ messages: [{ role: 'user', content: 'q3' }], model: 'test' });
    const reinjected = manifestMessage(afterSecondCompression);
    assert.ok(reinjected, 'a new compression event triggers a fresh injection');
    assert.match(reinjected?.content ?? '', /\[S2\]/, 'the new manifest reflects sources added since the last injection');
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('a compressed conversation with no sources still marks the checkpoint as injected', async () => {
  const conversation = createResearchConversation();
  try {
    const manager = createResearchContextManager({ conversationId: conversation.id, llm: provider(validSummary), model: 'test' });

    // Trigger compression with NO sources present
    await manager.prepare({
      messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'x'.repeat(440_000) }],
      model: 'test'
    });

    const firstAfter = await manager.prepare({ messages: [{ role: 'user', content: 'q' }], model: 'test' });
    // No manifest because the source list is empty (formatEvidenceManifest returns '').
    assert.equal(manifestMessage(firstAfter), undefined);

    // But the checkpoint must be recorded so we do not re-evaluate every call.
    const state = getResearchConversation(conversation.id)?.contextState;
    assert.equal(state?.manifestInjectedSummaryCheckpoint, state?.summaryCheckpointTokens);

    // Subsequent prepares must not even attempt injection.
    const secondAfter = await manager.prepare({ messages: [{ role: 'user', content: 'q2' }], model: 'test' });
    assert.equal(manifestMessage(secondAfter), undefined);
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('formatEvidenceManifest returns "" for empty input and renders entries otherwise', () => {
  assert.equal(formatEvidenceManifest([]), '');

  const refs = [
    {
      sourceId: 'src-1',
      citationKey: 'S1',
      title: 'Example',
      domain: 'example.com',
      file: 'https://example.com/article',
      briefExcerpt: 'first 200 chars of body',
      score: 0.85,
      assistantMessageId: 'msg-1',
      kind: 'web' as const
    },
    {
      sourceId: 'src-2',
      citationKey: 'S2',
      title: 'Local Doc',
      file: 'docs/local.md',
      briefExcerpt: 'local doc excerpt',
      assistantMessageId: 'msg-1',
      kind: 'knowledge' as const
    }
  ];

  const rendered = formatEvidenceManifest(refs);
  assert.match(rendered, /【已检索证据/);
  assert.match(rendered, /\[S1\] Example/);
  assert.match(rendered, /\[S2\] Local Doc/);
  assert.match(rendered, /域名：example\.com/);
  assert.match(rendered, /文件：docs\/local\.md/);
  assert.match(rendered, /sourceId：src-1/);
  assert.match(rendered, /read_evidence/);
  assert.match(rendered, /【证据清单结束】/);
});

test('buildEvidenceManifest reads from research_sources in the order they were created', () => {
  const conversation = createResearchConversation();
  try {
    const m1 = createResearchMessage({ conversationId: conversation.id, role: 'assistant', content: 'm1', status: 'complete' });
    const m2 = createResearchMessage({ conversationId: conversation.id, role: 'assistant', content: 'm2', status: 'complete' });
    seedSource(m1.id, { id: 'src-1', file: 'a.md', title: 'A', content: 'A body' }, 'S1');
    seedSource(m2.id, { id: 'src-2', file: 'b.md', title: 'B', content: 'B body' }, 'S2');

    const refs = buildEvidenceManifest(conversation.id);
    assert.equal(refs.length, 2);
    assert.equal(refs[0]?.citationKey, 'S1');
    assert.equal(refs[1]?.citationKey, 'S2');
    assert.equal(refs[0]?.briefExcerpt, 'A body');
    assert.equal(refs[1]?.briefExcerpt, 'B body');
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('manifest excerpt is truncated past the configured character limit', () => {
  const long = 'x'.repeat(500);
  const refs = [
    {
      sourceId: 'src-x',
      citationKey: 'S1',
      title: 'long',
      briefExcerpt: long.slice(0, 200) + '…',
      assistantMessageId: 'msg-1',
      kind: 'web' as const
    }
  ];
  const rendered = formatEvidenceManifest(refs);
  assert.match(rendered, /摘要：x{200}…/);
});
