import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb } from '../db.js';
import { addResearchSource, createResearchConversation, createResearchMessage, deleteResearchConversation, listResearchSources } from '../research/store.js';
import type { RagSource } from '../rag/types.js';
import { readEvidence } from './evidenceTool.js';

initDb();

function makeSource(overrides: Partial<RagSource> = {}): RagSource {
  return {
    id: 'src-' + Math.random().toString(36).slice(2, 10),
    file: 'https://example.com/article',
    title: 'Example article',
    heading: 'example.com',
    content: 'full body of the evidence goes here. '.repeat(50),
    startLine: 1,
    endLine: 100,
    score: 0.85,
    contentType: 'text',
    ...overrides
  };
}

function seedEvidence(conversationId: string, source: Partial<RagSource> & Pick<RagSource, 'id' | 'file' | 'title' | 'content'>, citationKey: string) {
  const message = createResearchMessage({ conversationId, role: 'assistant', content: 'assistant', status: 'complete' });
  return addResearchSource(message.id, {
    startLine: 1,
    endLine: source.content.split('\n').length,
    score: 0.85,
    contentType: 'text',
    ...source
  }, citationKey);
}

test('returns full content for the matching citationKey', async () => {
  const conversation = createResearchConversation();
  try {
    const source = makeSource({ id: 'src-A', content: 'A body ' .repeat(100) });
    const stored = seedEvidence(conversation.id, source, 'S1');

    const result = await readEvidence({ citationKey: 'S1' }, { conversationId: conversation.id });
    assert.equal(result.citationKey, 'S1');
    assert.equal(result.sourceId, stored.id);
    assert.equal(result.truncated, false);
    assert.equal(result.totalChars, source.content.length);
    assert.equal(result.content, source.content);
    assert.equal(result.title, 'Example article');
    assert.equal(result.file, 'https://example.com/article');
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('returns full content for the matching sourceId', async () => {
  const conversation = createResearchConversation();
  try {
    const source = makeSource({ id: 'src-B', content: 'B body' });
    const stored = seedEvidence(conversation.id, source, 'S2');

    const result = await readEvidence({ sourceId: stored.id }, { conversationId: conversation.id });
    assert.equal(result.citationKey, 'S2');
    assert.equal(result.sourceId, stored.id);
    assert.equal(result.content, 'B body');
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('sourceId and citationKey resolve to the same row', async () => {
  const conversation = createResearchConversation();
  try {
    const stored = seedEvidence(conversation.id, makeSource({ id: 'src-C', content: 'C body', file: 'c.md', title: 'C' }), 'S7');
    const byKey = await readEvidence({ citationKey: 'S7' }, { conversationId: conversation.id });
    const byId = await readEvidence({ sourceId: stored.id }, { conversationId: conversation.id });
    assert.equal(byKey.sourceId, byId.sourceId);
    assert.equal(byKey.content, byId.content);
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('truncates content past maxChars and sets truncated=true', async () => {
  const conversation = createResearchConversation();
  try {
    const longContent = 'x'.repeat(20_000);
    const source = makeSource({ id: 'src-Long', content: longContent });
    seedEvidence(conversation.id, source, 'S3');

    const result = await readEvidence({ citationKey: 'S3', maxChars: 1000 }, { conversationId: conversation.id });
    assert.equal(result.truncated, true);
    assert.equal(result.content.length, 1000);
    assert.equal(result.totalChars, longContent.length);

    const larger = await readEvidence({ citationKey: 'S3', maxChars: 25_000 }, { conversationId: conversation.id });
    assert.equal(larger.truncated, false);
    assert.equal(larger.content.length, longContent.length);
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('throws with clear error when no source matches', async () => {
  const conversation = createResearchConversation();
  try {
    seedEvidence(conversation.id, makeSource({ id: 'src-X', content: 'X' }), 'S9');

    await assert.rejects(
      readEvidence({ citationKey: 'S404' }, { conversationId: conversation.id }),
      /未在本会话的已检索证据中找到 citationKey="S404"/
    );
    await assert.rejects(
      readEvidence({ sourceId: 'nonexistent' }, { conversationId: conversation.id }),
      /未在本会话的已检索证据中找到 sourceId="nonexistent"/
    );
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('rejects calls without a conversationId context', async () => {
  await assert.rejects(
    readEvidence({ citationKey: 'S1' }),
    /read_evidence 缺少会话上下文/
  );
});

test('rejects calls missing both citationKey and sourceId', async () => {
  await assert.rejects(
    readEvidence({}, { conversationId: 'any' }),
    /read_evidence requires either citationKey or sourceId/
  );
});

test('rejects calls supplying both citationKey and sourceId', async () => {
  await assert.rejects(
    readEvidence({ citationKey: 'S1', sourceId: 'src-1' }, { conversationId: 'any' }),
    /read_evidence accepts citationKey or sourceId, not both/
  );
});

test('honors context.signal when already aborted', async () => {
  const controller = new AbortController();
  controller.abort(new Error('user cancelled'));

  await assert.rejects(
    readEvidence({ citationKey: 'S1' }, { conversationId: 'any', signal: controller.signal }),
    /user cancelled/
  );
});
