import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import express from 'express';

import { initDb } from '../db.js';
import { createResearchApplication } from '../modules/research/index.js';
import { createResearchRouter } from '../routes/research.js';
import { createResearchConversation, createResearchMessage, createResearchRun, deleteResearchConversation } from '../research/store.js';
import { toolCatalog } from '../tools/registry.js';
import { appendStreamEvent } from './eventStore.js';
import { publishStreamEvent } from './eventHub.js';

initDb();

type Frame = { event: string; id?: string; data: string };

async function startServer(): Promise<{ server: Server; port: number }> {
  const app = express();
  app.use('/api', createResearchRouter(createResearchApplication({ model: 'test-model', tools: toolCatalog })));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return { server, port: address.port };
}

function createRunFixture() {
  const conversation = createResearchConversation();
  const userMessage = createResearchMessage({ conversationId: conversation.id, role: 'user', content: 'q', status: 'complete' });
  const assistantMessage = createResearchMessage({ conversationId: conversation.id, role: 'assistant', content: '', status: 'streaming' });
  const run = createResearchRun({
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    runInput: { content: 'q', contextMessages: [], promptPreview: { historyMessageCount: 0, currentMessage: 'q' } }
  });
  return { conversation, run };
}

async function readFrames(port: number, runId: string, lastEventId: number | undefined, count: number): Promise<Frame[]> {
  const controller = new AbortController();
  const headers: Record<string, string> = {};
  if (lastEventId !== undefined) headers['Last-Event-ID'] = String(lastEventId);
  const response = await fetch(`http://127.0.0.1:${port}/api/research/runs/${runId}/events`, {
    signal: controller.signal,
    headers
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = '';
  try {
    while (frames.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const frame = parseFrame(raw);
        if (frame) frames.push(frame);
      }
    }
  } finally {
    controller.abort();
  }
  return frames;
}

function parseFrame(raw: string): Frame | undefined {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const sep = line.indexOf(':');
    const field = line.slice(0, sep);
    let value = line.slice(sep + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'id') id = value;
    if (field === 'data') data.push(value);
  }
  if (!data.length) return undefined;
  return { event, data: data.join('\n'), ...(id === undefined ? {} : { id }) };
}

function emit(runId: string, type: string, payload: unknown) {
  publishStreamEvent(appendStreamEvent(runId, type, payload));
}

test('resumes from Last-Event-ID and replays only missed events exactly once', async () => {
  const { conversation, run } = createRunFixture();
  const { server, port } = await startServer();

  try {
    // Produce events 1..3 before the first connection.
    emit(run.id, 'research_step', { type: 'research_step', n: 1 });
    emit(run.id, 'assistant_delta', { type: 'assistant_delta', n: 2 });
    emit(run.id, 'research_source_found', { type: 'research_source_found', n: 3 });

    // First connection at cursor 0 gets a snapshot (lastSequence=3), then live.
    const firstFrames = await readFrames(port, run.id, undefined, 1);
    assert.equal(firstFrames[0]?.event, 'snapshot');
    const snapshot = JSON.parse(firstFrames[0]!.data) as { lastSequence: number };
    assert.equal(snapshot.lastSequence, 3);

    // Simulate disconnect, then produce 4..6 in the background.
    emit(run.id, 'research_step', { type: 'research_step', n: 4 });
    emit(run.id, 'assistant_delta', { type: 'assistant_delta', n: 5 });
    emit(run.id, 'done', { type: 'done', n: 6 });

    // Reconnect with Last-Event-ID: 3 -> replay 4,5,6 only, each once.
    const resumed = await readFrames(port, run.id, 3, 3);
    assert.deepEqual(resumed.map((frame) => frame.id), ['4', '5', '6']);
    assert.deepEqual(
      resumed.map((frame) => (JSON.parse(frame.data) as { payload: { n: number } }).payload.n),
      [4, 5, 6]
    );
    // No duplicate of earlier sequences.
    assert.ok(resumed.every((frame) => Number(frame.id) > 3));
  } finally {
    server.close();
    deleteResearchConversation(conversation.id);
  }
});

test('falls back to snapshot when the cursor is beyond retained events', async () => {
  const { conversation, run } = createRunFixture();
  const { server, port } = await startServer();

  try {
    emit(run.id, 'research_step', { type: 'research_step', n: 1 });
    // Client claims to have seen sequence 99, which never existed.
    const frames = await readFrames(port, run.id, 99, 1);
    assert.equal(frames[0]?.event, 'snapshot');
  } finally {
    server.close();
    deleteResearchConversation(conversation.id);
  }
});
