import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createEmbedding, createEmbeddings } from './embeddingClient.js';

test('批量 Embedding 单次请求并按 provider index 恢复输入顺序', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.EMBEDDING_API_KEY;
  const calls: Array<{ input: string[]; model: string }> = [];
  process.env.EMBEDDING_API_KEY = 'test-key';
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[]; model: string };
    calls.push(body);
    return new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [2, 2] },
        { index: 0, embedding: [1, 1] }
      ]
    }), { status: 200 });
  }) as typeof fetch;

  try {
    assert.deepEqual(await createEmbeddings(['first', 'second']), [[1, 1], [2, 2]]);
    assert.deepEqual(calls.map((call) => call.input), [['first', 'second']]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = originalKey;
  }
});

test('单条 createEmbedding 复用批量接口并校验响应数量', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.EMBEDDING_API_KEY;
  process.env.EMBEDDING_API_KEY = 'test-key';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ embedding: [3, 4] }] }), { status: 200 })
  ) as typeof fetch;

  try {
    assert.deepEqual(await createEmbedding('one'), [3, 4]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = originalKey;
  }
});

test('批量 Embedding 拒绝重复或缺失的 provider index', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.EMBEDDING_API_KEY;
  process.env.EMBEDDING_API_KEY = 'test-key';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      data: [
        { index: 0, embedding: [1, 1] },
        { index: 0, embedding: [2, 2] }
      ]
    }), { status: 200 })
  ) as typeof fetch;

  try {
    await assert.rejects(
      createEmbeddings(['first', 'second']),
      /invalid or duplicate indexes/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = originalKey;
  }
});

test('Embedding cancellation aborts the active request and prevents retries', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.EMBEDDING_API_KEY;
  process.env.EMBEDDING_API_KEY = 'test-key';
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const request = createEmbedding('demo query', { signal: controller.signal });
    controller.abort(new Error('Demo deadline reached'));
    await assert.rejects(request, /Demo deadline reached/);
    assert.equal(calls, 1);
    await assert.rejects(createEmbedding('another query', { signal: controller.signal }), /Demo deadline reached/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = originalKey;
  }
});
