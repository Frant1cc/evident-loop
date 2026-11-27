import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test, { beforeEach } from 'node:test';

import { createApp } from './app.js';
import { createArtifactGenerationService } from './artifacts/generation/index.js';
import { createArtifactApplication } from './modules/artifacts/index.js';
import { createPublicDemoApplication } from './modules/demo/index.js';
import { initDb, sqlite } from './db.js';
import { getDemoConfig, demoDay, DemoAccessError } from './demo/config.js';
import { createDemoRunBudget, createDemoToolRuntime, limitDemoArtifactProvider } from './demo/budget.js';
import { consumeDemoRequest, createOwnedConversation, hashClientIp, resolveDemoVisitor, reserveDemoRun, finishDemoRun, recoverDemoOperations, usage } from './demo/store.js';
import { createResearchConversation, createResearchMessage, getResearchRun } from './research/store.js';
import { createToolRuntime } from './tools/runtime.js';
import { toolCatalog } from './tools/registry.js';
import type { ChatCompletionRequest, LlmProvider } from './llm/contracts.js';
import type { DemoConfig } from './modules/demo/index.js';

initDb();
const config = { ...getDemoConfig(), cookieSecure: false };
const answer = { choices: [{ message: { role: 'assistant' as const, content: '这是公开体验的回答。' } }] };
const llm: LlmProvider = { complete: async () => answer, stream: async (_req, onDelta) => { onDelta({ content: '体验回答' }); } };
const now = Date.parse('2026-11-02T04:00:00.000Z');

beforeEach(() => {
  sqlite.exec(`DELETE FROM research_conversations; DELETE FROM demo_visitors; DELETE FROM demo_usage;
    DELETE FROM demo_operations; DELETE FROM tool_approvals; DELETE FROM stream_events;`);
});

async function withServer(
  run: (url: string, app: ReturnType<typeof createApp>) => Promise<void>,
  overrides: Partial<DemoConfig> = {},
  provider = llm
) {
  const app = createApp({ llm: provider, model: 'test', publicDemo: { config: { ...config, ...overrides }, now: () => now } });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  try { await run(`http://127.0.0.1:${address.port}/api`, app); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function client(url: string) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    request: async (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => {
      const response = await fetch(url + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'EvidentLoop', ...(cookie ? { Cookie: cookie } : {}), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0]!;
      return response;
    }
  };
}

async function createConversation(visitor: ReturnType<typeof client>) {
  const response = await visitor.request('/research/conversations', 'POST');
  assert.equal(response.status, 201);
  return (await response.json()).data.conversation.id as string;
}

async function waitForRun(id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = getResearchRun(id);
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) {
      await delay(5);
      return run;
    }
    await delay(5);
  }
  throw new Error('Research run did not settle');
}

test('two visitors cannot read, mutate, cancel or subscribe to each other’s data, and legacy conversations stay private', async () => {
  const legacy = createResearchConversation();
  await withServer(async (url) => {
    const alice = client(url);
    const bob = client(url);
    const first = await alice.request('/demo');
    assert.equal(first.status, 200);
    assert.match(first.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(first.headers.get('set-cookie')!, /SameSite=Strict/);
    const token = alice.cookie.split('=')[1]!;
    assert.equal(sqlite.prepare('SELECT id FROM demo_visitors WHERE id = ?').get(token), undefined);
    assert.ok(sqlite.prepare('SELECT id FROM demo_visitors WHERE id = ?').get(createHash('sha256').update(token).digest('hex')));
    const a = await createConversation(alice);
    const b = await createConversation(bob);
    const list = await (await bob.request('/research/conversations')).json();
    assert.deepEqual(list.data.conversations.map((item: { id: string }) => item.id), [b]);
    for (const id of [a, legacy.id]) {
      for (const method of ['GET', 'DELETE']) assert.equal((await bob.request(`/research/conversations/${id}`, method)).status, 404);
      assert.equal((await bob.request(`/research/conversations/${id}/messages`, 'POST', { content: 'steal', toolPolicy: { mode: 'none' } })).status, 404);
    }
    const note = (await (await alice.request(`/research/conversations/${a}/notes`, 'POST', { content: 'Private note' })).json()).data.note;
    assert.equal((await bob.request(`/research/notes/${note.id}`, 'PUT', { content: 'overwrite' })).status, 404);
    assert.equal((await bob.request(`/research/notes/${note.id}`, 'DELETE')).status, 404);
    const started = await alice.request(`/research/conversations/${a}/messages`, 'POST', { content: '你好', toolPolicy: { mode: 'none' } });
    assert.equal(started.status, 202);
    const run = (await started.json()).data.run;
    assert.equal((await bob.request(`/research/runs/${run.id}/events`)).status, 404);
    assert.equal((await bob.request(`/research/runs/${run.id}/cancel`, 'POST')).status, 404);
    await waitForRun(run.id);
    const stream = await alice.request(`/research/runs/${run.id}/events`);
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('cache-control')!, /private, no-store/);
    assert.match(await stream.text(), /体验/);
    assert.equal((await (await alice.request('/demo')).json()).data.remaining, 9);
    assert.equal((await (await bob.request('/demo')).json()).data.remaining, 10);
  });
});

test('demo endpoints deny legacy LLM and downloads, global artifact access, tasks, approvals, management, uploads and cross-site writes', async () => {
  await withServer(async (url) => {
    const visitor = client(url);
    for (const [method, path] of [
      ['GET', '/mcp/servers'], ['POST', '/mcp/servers'], ['GET', '/tasks'],
      ['GET', '/tool-approvals'], ['GET', '/knowledge/documents'], ['POST', '/knowledge/documents/upload'],
      ['GET', '/artifacts/generations'], ['GET', `/artifacts/${randomUUID()}/download`],
      ['POST', `/artifacts/generations/${randomUUID()}/image-consents`], ['POST', '/agent/chat'],
      ['POST', '/llm/chat/stream'], ['POST', '/deepseek/chat/stream'], ['GET', '/db-test'],
      ['POST', '/web/evaluations']
    ]) assert.equal((await visitor.request(path!, method!, method === 'GET' ? undefined : {})).status, 403, path);
    assert.equal(sqlite.prepare('SELECT * FROM demo_visitors').all().length, 0);
    assert.equal((await fetch(url + '/research/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await visitor.request('/research/conversations', 'POST', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await visitor.request('/demo', 'GET', undefined, { Origin: 'https://attacker.example' })).status, 403);
    const c = await createConversation(visitor);
    const multipart = await fetch(url + `/research/conversations/${c}/messages`, {
      method: 'POST', headers: { Cookie: visitor.cookie, 'X-Requested-With': 'EvidentLoop' }, body: new FormData()
    });
    assert.equal(multipart.status, 403);
    const tools = (await (await visitor.request('/research/tools')).json()).data.tools;
    assert.deepEqual(tools.map((tool: { name: string }) => tool.name).sort(), ['read_document', 'search_knowledge', 'start_document_generation']);
    assert.equal((await visitor.request(`/artifact-files/${randomUUID()}/preview`)).status, 404);
    assert.equal((await visitor.request(`/research/conversations/${randomUUID()}/artifacts`)).status, 404);
  });
});

test('demo artifact API serves only the owning visitor and charges drafting and rendering', async () => {
  const provider: LlmProvider = {
    ...llm,
    complete: async (request) => request.messages[0]?.content.includes('ArtifactAgent content planner')
      ? { choices: [{ message: { role: 'assistant', content: '' } }] }
      : answer
  };
  await withServer(async (url) => {
    const alice = client(url);
    const bob = client(url);
    const conversation = await createConversation(alice);
    createResearchMessage({ conversationId: conversation, role: 'assistant', content: '试用报告的研究结论', status: 'complete' });
    const drafts = `/research/conversations/${conversation}/artifacts/drafts`;
    assert.equal((await bob.request(drafts, 'POST', { formats: ['docx'] })).status, 404);
    const created = await alice.request(drafts, 'POST', { formats: ['docx'] });
    assert.equal(created.status, 201);
    const draft = (await created.json()).data.generation;
    const path = `/artifacts/generations/${draft.id}`;
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      assert.equal((await bob.request(path, method)).status, 404);
    }
    assert.equal((await bob.request(path + '/render', 'POST')).status, 404);
    const updated = await alice.request(path, 'PATCH', { spec: { ...draft.spec, title: '已编辑报告' } });
    assert.equal(updated.status, 200);
    const rendering = await alice.request(path + '/render', 'POST');
    assert.equal(rendering.status, 202);
    const generation = (await rendering.json()).data.generation;
    const outputPath = `/artifact-files/${generation.outputs[0].id}`;
    let download = await alice.request(outputPath + '/download');
    for (let attempt = 0; attempt < 40 && download.status === 404; attempt += 1) {
      await delay(15);
      download = await alice.request(outputPath + '/download');
    }
    assert.equal(download.status, 200);
    assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 2).toString(), 'PK');
    assert.equal((await alice.request(outputPath + '/preview')).status, 200);
    assert.equal((await bob.request(outputPath + '/download')).status, 404);
    assert.equal((await bob.request(`/artifacts/outputs/${generation.outputs[0].id}/retry`, 'POST')).status, 404);
    assert.equal((await (await alice.request('/demo')).json()).data.remaining, 0);
    const limit = await alice.request(drafts, 'POST', { formats: ['pdf'] });
    assert.equal(limit.status, 429);
    assert.ok(Number(limit.headers.get('retry-after')) > 0);
    assert.equal((await alice.request(`/research/conversations/${conversation}`, 'DELETE')).status, 200);
    assert.equal((await alice.request(outputPath + '/download')).status, 404);
  }, { visitorDailyLimit: 2 }, provider);
});

test('demo artifact lifecycle keeps the shared slot until rendering settles and produces a Word file', async () => {
  const bytes = new Map<string, Buffer>();
  const generationService = createArtifactGenerationService({
    model: 'test',
    binaryStore: {
      put: async (key, value) => { bytes.set(key, value); },
      get: async (key) => bytes.get(key) ?? null,
      delete: async (key) => { bytes.delete(key); }
    }
  });
  const artifacts = createArtifactApplication({ model: 'test', generationService });
  const demo = createPublicDemoApplication({ config, tools: createToolRuntime(toolCatalog), now: () => now });
  const alice = demo.openSession(undefined, '127.0.0.1');
  const bob = demo.openSession(undefined, '127.0.0.1');
  const conversation = createOwnedConversation(alice.id, createResearchConversation);
  createResearchMessage({ conversationId: conversation.id, role: 'assistant', content: '文稿内容', status: 'complete' });
  const owner = demo.scopeArtifacts(artifacts, alice.id, alice.ip);
  const other = demo.scopeArtifacts(artifacts, bob.id, bob.ip);
  const draft = await owner.createDraft(conversation.id, { formats: ['docx'] });
  assert.equal(other.ownsConversation(conversation.id), false);
  assert.equal(other.ownsGeneration(draft.id), false);
  const generation = owner.startRender(draft.id);
  const output = generation.outputs[0]!;
  assert.equal(owner.ownsOutput(output.id), true);
  assert.equal(other.ownsOutput(output.id), false);
  assert.throws(() => reserveDemoRun(alice.id, alice.ip, config, now), DemoAccessError);
  await artifacts.waitForRender(generation.id);
  assert.equal(artifacts.getGeneration(generation.id)?.status, 'completed');
  assert.equal((await artifacts.readOutput(output.id))?.buffer.subarray(0, 2).toString(), 'PK');
  assert.equal(demo.status(alice.id).remaining, config.visitorDailyLimit - 2);
  const reservation = reserveDemoRun(alice.id, alice.ip, config, now);
  finishDemoRun(reservation, now);
});

test('demo artifact provider caps requests per operation', async () => {
  const requests: ChatCompletionRequest[] = [];
  const provider = limitDemoArtifactProvider({
    ...llm,
    complete: async (request) => { requests.push(request); return answer; }
  })!;
  const signal = new AbortController().signal;
  const request = { model: 'test', messages: [], signal, maxTokens: 100_000, maxRetries: 9 };
  for (let i = 0; i < 12; i += 1) await provider.complete(request);
  await assert.rejects(provider.complete(request), /模型调用上限/);
  await provider.complete({ ...request, signal: new AbortController().signal });
  assert.equal(requests.length, 13);
  assert.equal(requests[0]?.maxTokens, 16_000);
  assert.equal(requests[0]?.maxRetries, 0);
});

test('daily quota survives conversation deletion, new application instances and browser identity resets', async () => {
  let savedCookie = '';
  await withServer(async (url) => {
    const visitor = client(url);
    const c = await createConversation(visitor);
    savedCookie = visitor.cookie;
    for (let i = 0; i < 2; i += 1) {
      const response = await visitor.request(`/research/conversations/${c}/messages`, 'POST', { content: '你好', toolPolicy: { mode: 'none' } });
      assert.equal(response.status, 202);
      await waitForRun((await response.json()).data.run.id);
    }
    assert.equal((await visitor.request(`/research/conversations/${c}`, 'DELETE')).status, 200);
    const another = await createConversation(visitor);
    const blocked = await visitor.request(`/research/conversations/${another}/messages`, 'POST', { content: 'again' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    const fresh = client(url);
    const next = await createConversation(fresh);
    assert.equal((await fresh.request(`/research/conversations/${next}/messages`, 'POST', { content: 'reset cookie' })).status, 429);
  }, { visitorDailyLimit: 2, ipDailyLimit: 2 });
  await withServer(async (url) => {
    const response = await fetch(url + '/demo', { headers: { Cookie: savedCookie } });
    assert.equal((await response.json()).data.remaining, 0);
  }, { visitorDailyLimit: 2, ipDailyLimit: 2 });
});

test('concurrency stays reserved for the background job, including after cancellation until execution settles', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const blockedLlm: LlmProvider = { complete: async () => { await pending; return answer; }, stream: async () => { await pending; } };
  await withServer(async (url) => {
    const alice = client(url);
    const bob = client(url);
    const a = await createConversation(alice);
    const a2 = await createConversation(alice);
    const b = await createConversation(bob);
    const start = await alice.request(`/research/conversations/${a}/messages`, 'POST', { content: 'wait', toolPolicy: { mode: 'none' } });
    const runId = (await start.json()).data.run.id;
    const send = (c: string, who = alice) => who.request(`/research/conversations/${c}/messages`, 'POST', { content: 'wait', toolPolicy: { mode: 'none' } });
    assert.equal((await send(a2)).status, 429);
    assert.equal((await send(b, bob)).status, 429);
    await alice.request(`/research/runs/${runId}/cancel`, 'POST');
    assert.equal((await send(b, bob)).status, 429);
    release();
    for (let i = 0; i < 100 && sqlite.prepare("SELECT 1 FROM demo_operations WHERE status = 'active'").get(); i += 1) await delay(5);
    const next = await send(b, bob);
    assert.equal(next.status, 202);
    await waitForRun((await next.json()).data.run.id);
  }, { globalConcurrency: 1 }, blockedLlm);
});

test('oversized messages and forged ownership are rejected before quota admission', async () => {
  await withServer(async (url) => {
    const visitor = client(url);
    const id = await createConversation(visitor);
    assert.equal((await visitor.request(`/research/conversations/${id}/messages`, 'POST', { content: 'x'.repeat(2_001), visitorId: 'admin', toolPolicy: { mode: 'all' } })).status, 400);
    assert.equal((await (await visitor.request('/demo')).json()).data.remaining, 10);
    assert.equal((await visitor.request(`/research/conversations/${id}/messages`, 'POST', { content: 'x'.repeat(20_000) })).status, 413);
  });
});

test('daily admission is atomic, global limits span IPs, UTC+8 resets, restart recovery does not restore usage', () => {
  const ip = hashClientIp('192.0.2.1');
  const v = resolveDemoVisitor(undefined, ip, now).id;
  const limited = { ...config, visitorDailyLimit: 1, globalDailyLimit: 1 };
  const reservation = reserveDemoRun(v, ip, limited, now);
  assert.throws(() => reserveDemoRun(v, ip, limited, now), DemoAccessError);
  recoverDemoOperations(now);
  assert.equal(usage(demoDay(now).day, 'research_visitor', v), 1);
  const otherIp = hashClientIp('192.0.2.2');
  const other = resolveDemoVisitor(undefined, otherIp, now).id;
  assert.throws(() => reserveDemoRun(other, otherIp, limited, now), /全站/);
  finishDemoRun(reservation, now);
  const midnight = Date.parse('2026-11-02T16:00:00.000Z');
  assert.equal(demoDay(midnight - 1).day, '2026-11-02');
  assert.equal(demoDay(midnight).day, '2026-11-03');
  assert.ok(reserveDemoRun(v, ip, limited, midnight));
});

test('untrusted forwarding headers cannot bypass the IP quota', async () => {
  await withServer(async (url) => {
    for (const forwarded of ['192.0.2.1', '192.0.2.2']) {
      const visitor = client(url);
      const c = await createConversation(visitor);
      const response = await visitor.request(`/research/conversations/${c}/messages`, 'POST', { content: 'hello', toolPolicy: { mode: 'none' } }, { 'X-Forwarded-For': forwarded });
      if (forwarded === '192.0.2.1') {
        assert.equal(response.status, 202);
        await waitForRun((await response.json()).data.run.id);
      } else assert.equal(response.status, 429);
    }
  }, { ipDailyLimit: 1 });
});

test('invalid cookies never choose an identity, new-session and API request caps fail closed', () => {
  const ip = hashClientIp('192.0.2.1');
  const forged = 'a'.repeat(64);
  const issued = resolveDemoVisitor(forged, ip, now);
  assert.notEqual(issued.token, forged);
  assert.notEqual(issued.id, createHash('sha256').update(forged).digest('hex'));
  assert.equal(resolveDemoVisitor(issued.token, ip, now).id, issued.id);
  for (let i = 1; i < 20; i += 1) resolveDemoVisitor(undefined, ip, now);
  assert.throws(() => resolveDemoVisitor(undefined, ip, now), /新访客/);
  for (let i = 0; i < 120; i += 1) consumeDemoRequest(ip, now);
  assert.throws(() => consumeDemoRequest(ip, now), /频繁/);
  assert.doesNotThrow(() => consumeDemoRequest(ip, now + 60_000));
});

test('tool budgets prevent unbounded tool invocations and expose no management or web tools', async () => {
  let calls = 0;
  const definition = toolCatalog.get('read_document')!;
  const runtime = createDemoToolRuntime(createToolRuntime(new Map([
    ['read_document', { ...definition, execute: async () => { calls += 1; return {}; } }],
    ['start_document_generation', toolCatalog.get('start_document_generation') ?? { ...definition, source: 'mcp', definition: { ...definition.definition, function: { ...definition.definition.function, name: 'start_document_generation' } } }]
  ])));
  const budget = createDemoRunBudget(llm, runtime, { ...config, maxToolCalls: 1 }, () => {});
  assert.deepEqual(budget.toolRuntime.getDefinitions().map((tool) => tool.function.name), ['read_document']);
  await budget.toolRuntime.execute('read_document', { file: 'demo.md' });
  await assert.rejects(budget.toolRuntime.execute('read_document', { file: 'demo.md' }), /工具调用上限/);
  assert.equal(calls, 1);
  budget.onSettled();
});

test('per-run provider budget caps calls, tokens, retries and context, and aborts at deadline', async () => {
  const requests: ChatCompletionRequest[] = [];
  const provider: LlmProvider = { complete: async (request) => { requests.push(request); return answer; }, stream: llm.stream };
  const runtime = createDemoToolRuntime(createToolRuntime(toolCatalog));
  let settled = 0;
  const budget = createDemoRunBudget(provider, runtime, { ...config, maxLlmCalls: 1 }, () => { settled += 1; });
  const request = { model: 'test', messages: [{ role: 'user' as const, content: 'hello' }], maxTokens: 100_000, maxRetries: 99 };
  await budget.llm.complete(request);
  assert.equal(requests[0]!.maxTokens, config.maxOutputTokens);
  assert.equal(requests[0]!.maxRetries, 0);
  assert.equal(requests[0]!.reasoning, false);
  await assert.rejects(budget.llm.complete(request), /调用上限/);
  budget.onSettled(); budget.onSettled();
  assert.equal(settled, 1);
  const context = createDemoRunBudget(provider, runtime, config, () => {});
  await assert.rejects(context.llm.complete({ ...request, messages: [{ role: 'user', content: 'x'.repeat(40_001) }] }), /会话内容/);
  context.onSettled();
  const timeout = createDemoRunBudget(provider, runtime, { ...config, maxRunMs: 10 }, () => {});
  await delay(20);
  assert.equal(timeout.signal.aborted, true);
  await assert.rejects(timeout.llm.complete(request), /时间上限/);
  timeout.onSettled();
});

test('a timed-out or failed background run releases its slot but still consumes daily quota', async () => {
  const provider: LlmProvider = {
    complete: (request) => new Promise((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
    }),
    stream: async () => {}
  };
  await withServer(async (url) => {
    const visitor = client(url);
    const c = await createConversation(visitor);
    const response = await visitor.request(`/research/conversations/${c}/messages`, 'POST', { content: 'timeout', toolPolicy: { mode: 'none' } });
    const runId = (await response.json()).data.run.id;
    assert.equal((await waitForRun(runId)).status, 'failed');
    assert.equal(sqlite.prepare("SELECT * FROM demo_operations WHERE status = 'active'").all().length, 0);
    assert.equal((await (await visitor.request('/demo')).json()).data.remaining, 9);
  }, { maxRunMs: 30 }, provider);
});
