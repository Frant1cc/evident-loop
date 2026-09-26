import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { ChatCompletionRequest, LlmProvider } from '../llm/contracts.js';

const dataDir = mkdtempSync(join(tmpdir(), 'research-attachment-'));
process.env.SQLITE_DB_PATH = join(dataDir, 'test.sqlite');

const { initDb, sqlite } = await import('../db.js');
const { createApp } = await import('../app.js');

const requests: ChatCompletionRequest[] = [];
const llm: LlmProvider = {
  complete: async (request) => {
    requests.push(request);
    return { choices: [{ message: { role: 'assistant', content: '已阅读。' } }] };
  },
  stream: async (request, onDelta) => {
    requests.push(request);
    onDelta({ content: '已阅读。' });
  }
};

initDb();
const server = createServer(createApp({ llm, model: 'test' }));
let baseUrl = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  sqlite.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('conversation attachment reaches the agent and remains attached after reload', async () => {
  const created = await fetch(`${baseUrl}/api/research/conversations`, { method: 'POST' });
  const createdBody = await created.json() as { data: { conversation: { id: string } } };
  const conversationId = createdBody.data.conversation.id;

  const body = new FormData();
  body.append('content', '这份文档讲什么？');
  body.append('toolPolicy', JSON.stringify({ mode: 'none' }));
  body.append('file', new Blob(['# 测试报告\n\n关键结论：增长 12%。'], { type: 'text/markdown' }), '测试报告.md');
  const sent = await fetch(`${baseUrl}/api/research/conversations/${conversationId}/messages`, {
    method: 'POST', body
  });
  assert.equal(sent.status, 202);
  const sentBody = await sent.json() as { data: { userMessage: { attachment?: { name: string } } } };
  assert.equal(sentBody.data.userMessage.attachment?.name, '测试报告.md');

  await waitFor(() => requests.length === 1);
  assert.equal(requests[0]!.messages.at(-1)?.content, '这份文档讲什么？');
  assert.ok(requests[0]!.messages.some((message) => message.role === 'user' && message.content.includes('关键结论：增长 12%')));

  const detail = await fetch(`${baseUrl}/api/research/conversations/${conversationId}`);
  const detailBody = await detail.json() as { data: { messages: Array<{ attachment?: { name: string }; content: string }> } };
  assert.equal(detailBody.data.messages[0]?.attachment?.name, '测试报告.md');
  assert.equal(detailBody.data.messages[0]?.content, '这份文档讲什么？');

  // Attachments stored before filename decoding was fixed should display correctly too.
  sqlite.prepare('UPDATE research_message_attachments SET original_name = ? WHERE conversation_id = ?')
    .run(Buffer.from('测试报告.md', 'utf8').toString('latin1'), conversationId);
  const restored = await fetch(`${baseUrl}/api/research/conversations/${conversationId}`);
  const restoredBody = await restored.json() as { data: { messages: Array<{ attachment?: { name: string } }> } };
  assert.equal(restoredBody.data.messages[0]?.attachment?.name, '测试报告.md');

  await waitFor(async () => {
    const result = await fetch(`${baseUrl}/api/research/conversations/${conversationId}`);
    const payload = await result.json() as { data: { activeRun?: unknown } };
    return !payload.data.activeRun;
  });
  const followUp = await fetch(`${baseUrl}/api/research/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '再解释一次', toolPolicy: { mode: 'none' } })
  });
  assert.equal(followUp.status, 202);
  await waitFor(() => requests.length === 2);
  assert.ok(requests[1]!.messages.some((message) => message.role === 'user' && message.content.includes('关键结论：增长 12%')));
  assert.ok(requests[1]!.messages.some((message) => message.role === 'user' && message.content.includes('测试报告.md')));
});

test('unsupported conversation attachment is rejected before creating a message', async () => {
  const created = await fetch(`${baseUrl}/api/research/conversations`, { method: 'POST' });
  const createdBody = await created.json() as { data: { conversation: { id: string } } };
  const conversationId = createdBody.data.conversation.id;
  const body = new FormData();
  body.append('file', new Blob(['binary'], { type: 'application/octet-stream' }), 'script.exe');
  body.append('toolPolicy', JSON.stringify({ mode: 'none' }));
  const sent = await fetch(`${baseUrl}/api/research/conversations/${conversationId}/messages`, {
    method: 'POST', body
  });
  assert.equal(sent.status, 415);
  const detail = await fetch(`${baseUrl}/api/research/conversations/${conversationId}`);
  const payload = await detail.json() as { data: { messages: unknown[] } };
  assert.deepEqual(payload.data.messages, []);
});

test('a document can be sent without typing a prompt, and deletion removes its extracted text', async () => {
  const created = await fetch(`${baseUrl}/api/research/conversations`, { method: 'POST' });
  const createdBody = await created.json() as { data: { conversation: { id: string } } };
  const conversationId = createdBody.data.conversation.id;
  const body = new FormData();
  body.append('toolPolicy', JSON.stringify({ mode: 'none' }));
  body.append('file', new Blob(['# 摘要目标\n\n只需概述。'], { type: 'text/markdown' }), 'summary.md');
  const sent = await fetch(`${baseUrl}/api/research/conversations/${conversationId}/messages`, {
    method: 'POST', body
  });
  assert.equal(sent.status, 202);
  const payload = await sent.json() as { data: { userMessage: { content: string } } };
  assert.equal(payload.data.userMessage.content, '请概述这份文档。');
  await waitFor(() => (sqlite.prepare(`SELECT COUNT(*) AS count FROM research_message_attachments
    WHERE conversation_id = ?`).get(conversationId) as { count: number }).count === 1);
  await waitFor(async () => {
    const result = await fetch(`${baseUrl}/api/research/conversations/${conversationId}`);
    const detail = await result.json() as { data: { activeRun?: unknown } };
    return !detail.data.activeRun;
  });
  const removed = await fetch(`${baseUrl}/api/research/conversations/${conversationId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const count = sqlite.prepare(`SELECT COUNT(*) AS count FROM research_message_attachments
    WHERE conversation_id = ?`).get(conversationId) as { count: number };
  assert.equal(count.count, 0);
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for research run');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
