import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as flush } from 'node:timers/promises';
import test, { beforeEach } from 'node:test';

import { initDb, sqlite } from './db.js';
import { LocalArtifactBinaryStore } from './artifacts/generation/binaryStore.js';
import { createArtifactGenerationService } from './artifacts/generation/service.js';
import { createArtifactApplication } from './modules/artifacts/index.js';
import { pruneExpiredResearchData } from './modules/research/index.js';
import { pruneExpiredTaskData } from './modules/tasks/index.js';
import { createResearchConversation, createResearchMessage } from './research/store.js';
import { cleanupExpiredDemoData, DEMO_DATA_CLEANUP_INTERVAL_MS, isDemoDataCleanupEnabled, startDemoDataCleanup } from './dataCleanup.js';

initDb();
const now = Date.parse('2026-11-02T12:00:00.000Z');
const old = new Date(now - 48 * 60 * 60 * 1_000).toISOString();
const recent = new Date(now - 60 * 60 * 1_000).toISOString();
const cutoff = new Date(now - DEMO_DATA_CLEANUP_INTERVAL_MS).toISOString();

beforeEach(() => {
  sqlite.exec('DELETE FROM research_conversations; DELETE FROM agent_tasks; DELETE FROM tool_approvals; DELETE FROM stream_events;');
});

function conversation(timestamp = old) {
  const id = randomUUID();
  sqlite.prepare('INSERT INTO research_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, 'Demo', timestamp, timestamp);
  return id;
}

function run(conversationId: string, status = 'completed') {
  const id = randomUUID();
  const user = randomUUID();
  const assistant = randomUUID();
  const insert = sqlite.prepare(`INSERT INTO research_messages
    (id, conversation_id, role, content, status, created_at) VALUES (?, ?, ?, 'demo', 'complete', ?)`);
  insert.run(user, conversationId, 'user', old);
  insert.run(assistant, conversationId, 'assistant', old);
  sqlite.prepare(`INSERT INTO research_runs
    (id, conversation_id, user_message_id, assistant_message_id, status, input_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`).run(id, conversationId, user, assistant, status, old, old);
  return { id, assistant };
}

function task(status = 'completed', timestamp = old) {
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO agent_tasks
    (id, goal, status, max_steps, max_tokens, allowed_tools_json, created_at, updated_at)
    VALUES (?, 'demo', ?, 3, 1000, '[]', ?, ?)`).run(id, status, timestamp, timestamp);
  return id;
}

function approval(scopeType: string, scopeId: string, timestamp = old) {
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO tool_approvals
    (id, scope_type, scope_id, tool_call_id, tool_name, model_name, label, source,
      arguments_json, definition_hash, status, requested_at)
    VALUES (?, ?, ?, 'call', 'tool', 'tool', 'tool', 'builtin', '{}', 'hash', 'cancelled', ?)`)
    .run(id, scopeType, scopeId, timestamp);
  return id;
}

function event(id: string) {
  sqlite.prepare(`INSERT INTO stream_events (stream_id, sequence, event_type, payload_json, occurred_at)
    VALUES (?, 1, 'done', '{}', ?)`).run(id, old);
}

function exists(table: string, id: string) {
  return Boolean(sqlite.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id));
}

const artifacts = createArtifactApplication({ model: 'test' });

test('removes expired conversation attachments, approvals and events while preserving recent and active work', async () => {
  const expired = conversation(cutoff);
  const finished = run(expired);
  const approved = approval('research_run', finished.id);
  event(finished.id);
  sqlite.prepare(`INSERT INTO research_message_attachments
    (id, conversation_id, message_id, original_name, format, size, extracted_content, created_at)
    VALUES (?, ?, ?, 'demo.txt', 'txt', 4, 'demo', ?)`)
    .run(randomUUID(), expired, finished.assistant, old);
  const fresh = conversation(recent);
  const active = conversation();
  run(active, 'running');
  const queued = conversation();
  run(queued, 'queued');
  const noted = conversation();
  sqlite.prepare(`INSERT INTO research_notes (id, conversation_id, content, created_at, updated_at)
    VALUES (?, ?, 'recent note', ?, ?)`).run(randomUUID(), noted, old, recent);

  const result = await cleanupExpiredDemoData(artifacts, now);
  assert.deepEqual(result, { conversations: 1, tasks: 0, failedConversations: 0 });
  assert.equal(exists('research_conversations', expired), false);
  assert.equal(exists('tool_approvals', approved), false);
  assert.equal(sqlite.prepare('SELECT * FROM research_message_attachments').all().length, 0);
  assert.equal(sqlite.prepare('SELECT * FROM stream_events').all().length, 0);
  for (const id of [fresh, active, queued, noted]) assert.equal(exists('research_conversations', id), true);
});

test('restores files on storage failure or new activity, then removes them with the expired conversation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'demo-retention-'));
  const binaryStore = new LocalArtifactBinaryStore(directory);
  let mode: 'failure' | 'activity' | 'normal' = 'failure';
  let conversationId: string;
  const generationService = createArtifactGenerationService({
    model: 'test',
    binaryStore: {
      put: (key, bytes) => binaryStore.put(key, bytes),
      get: (key) => binaryStore.get(key),
      delete: async (key) => {
        if (key === 'preview.html' && mode === 'failure') throw new Error('Storage unavailable');
        await binaryStore.delete(key);
        if (key === 'preview.html' && mode === 'activity') {
          sqlite.prepare('UPDATE research_conversations SET updated_at = ? WHERE id = ?').run(recent, conversationId);
        }
      }
    }
  });
  const application = createArtifactApplication({ model: 'test', generationService });
  try {
    const c = createResearchConversation();
    conversationId = c.id;
    createResearchMessage({ conversationId: c.id, role: 'user', content: '生成研究报告', status: 'complete' });
    const draft = await generationService.createDraft(c.id);
    const keys = ['report.pdf', 'preview.html', 'source.png'];
    for (const key of keys) await binaryStore.put(key, Buffer.from(key));
    sqlite.prepare(`INSERT INTO research_artifact_outputs
      (id, generation_id, version, format, status, storage_key, preview_key, created_at, updated_at)
      VALUES (?, ?, 1, 'pdf', 'completed', ?, ?, ?, ?)`)
      .run(randomUUID(), draft.id, keys[0], keys[1], old, old);
    sqlite.prepare(`INSERT INTO research_artifact_assets
      (id, generation_id, image_url, mime_type, byte_size, storage_key, created_at)
      VALUES (?, ?, 'https://example.com/image.png', 'image/png', 10, ?, ?)`)
      .run(randomUUID(), draft.id, keys[2], old);
    sqlite.prepare('UPDATE research_conversations SET updated_at = ? WHERE id = ?').run(old, c.id);
    sqlite.prepare('UPDATE research_messages SET created_at = ? WHERE conversation_id = ?').run(old, c.id);
    sqlite.prepare('UPDATE research_artifacts SET updated_at = ? WHERE id = ?').run(old, draft.id);
    assert.deepEqual(await cleanupExpiredDemoData(application, now), { conversations: 0, tasks: 0, failedConversations: 1 });
    assert.equal(exists('research_conversations', c.id), true);
    for (const key of keys) assert.equal((await binaryStore.get(key))?.toString(), key);
    mode = 'activity';
    assert.deepEqual(await cleanupExpiredDemoData(application, now), { conversations: 0, tasks: 0, failedConversations: 0 });
    assert.equal(exists('research_conversations', c.id), true);
    for (const key of keys) assert.equal((await binaryStore.get(key))?.toString(), key);
    mode = 'normal';
    sqlite.prepare('UPDATE research_conversations SET updated_at = ? WHERE id = ?').run(old, c.id);
    const result = await cleanupExpiredDemoData(application, now);
    assert.equal(result.conversations, 1);
    assert.deepEqual(await readdir(directory), []);
    assert.equal(exists('research_artifacts', draft.id), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps recent artifact activity and active render or draft requests', async () => {
  const generationService = createArtifactGenerationService({ model: 'test' });
  const ids: string[] = [];
  for (const status of ['awaiting_confirmation', 'rendering', 'validating', 'repairing', 'planning']) {
    const c = createResearchConversation();
    createResearchMessage({ conversationId: c.id, role: 'user', content: '研究报告', status: 'complete' });
    const draft = await generationService.createDraft(c.id);
    sqlite.prepare('UPDATE research_conversations SET updated_at = ? WHERE id = ?').run(old, c.id);
    sqlite.prepare('UPDATE research_messages SET created_at = ? WHERE conversation_id = ?').run(old, c.id);
    sqlite.prepare('UPDATE research_artifacts SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, status === 'awaiting_confirmation' ? recent : old, draft.id);
    ids.push(c.id);
  }
  const pending = conversation();
  sqlite.prepare(`INSERT INTO research_artifact_draft_requests
    (id, conversation_id, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)`)
    .run(randomUUID(), pending, old, old);
  ids.push(pending);
  assert.deepEqual(await pruneExpiredResearchData({ cutoff, artifacts }), { deleted: 0, failed: 0 });
  for (const id of ids) assert.equal(exists('research_conversations', id), true);
});

test('rechecks activity after asynchronous file work and continues after deletion failures', async () => {
  const changed = conversation();
  const broken = conversation();
  const expired = conversation();
  const result = await pruneExpiredResearchData({
    cutoff,
    artifacts: {
      deleteConversationArtifacts: async (id, commit) => {
        if (id === broken) throw new Error('Storage unavailable');
        if (id === changed) sqlite.prepare('UPDATE research_conversations SET updated_at = ? WHERE id = ?').run(recent, id);
        if (!await commit?.()) throw new Error('Commit did not complete');
        return 0;
      }
    }
  });
  assert.deepEqual(result, { deleted: 1, failed: 1 });
  assert.equal(exists('research_conversations', expired), false);
  assert.equal(exists('research_conversations', changed), true);
  assert.equal(exists('research_conversations', broken), true);
  assert.deepEqual(await pruneExpiredResearchData({ cutoff, artifacts }), { deleted: 1, failed: 0 });
});

test('task retention removes dependent data but preserves running, planning and recently reviewed tasks', () => {
  const expired = task();
  const approvalId = approval('agent_task', expired);
  event(expired);
  sqlite.prepare(`INSERT INTO agent_artifacts
    (id, task_id, type, title, content, status, created_at, updated_at)
    VALUES (?, ?, 'report', 'demo', 'demo', 'completed', ?, ?)`).run(randomUUID(), expired, old, old);
  const fresh = task('completed', recent);
  const running = task('running');
  const planning = task('planning');
  const reviewed = task();
  approval('agent_task', reviewed, recent);
  assert.equal(pruneExpiredTaskData(cutoff), 1);
  assert.equal(exists('agent_tasks', expired), false);
  assert.equal(exists('tool_approvals', approvalId), false);
  assert.equal(sqlite.prepare('SELECT * FROM agent_artifacts').all().length, 0);
  assert.equal(sqlite.prepare('SELECT * FROM stream_events').all().length, 0);
  for (const id of [fresh, running, planning, reviewed]) assert.equal(exists('agent_tasks', id), true);
});

test('cleanup is opt-in and does not remove local history when disabled', async () => {
  const previous = process.env.DEMO_DATA_CLEANUP_ENABLED;
  delete process.env.DEMO_DATA_CLEANUP_ENABLED;
  const id = conversation();
  try {
    assert.equal(isDemoDataCleanupEnabled(), false);
    const stop = startDemoDataCleanup({ artifacts, cleanup: () => cleanupExpiredDemoData(artifacts, now) });
    await flush();
    await stop();
    assert.equal(exists('research_conversations', id), true);
  } finally {
    if (previous === undefined) delete process.env.DEMO_DATA_CLEANUP_ENABLED;
    else process.env.DEMO_DATA_CLEANUP_ENABLED = previous;
  }
});

test('runs at startup and every 24 hours, prevents overlap, drains work and stops future sweeps', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let complete!: () => void;
  const stop = startDemoDataCleanup({
    artifacts,
    enabled: true,
    cleanup: async () => { calls += 1; await new Promise<void>((resolve) => { complete = resolve; }); },
    onSuccess: () => {}
  });
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(DEMO_DATA_CLEANUP_INTERVAL_MS);
  await flush();
  assert.equal(calls, 1);
  complete();
  await flush();
  t.mock.timers.tick(DEMO_DATA_CLEANUP_INTERVAL_MS - 1);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  complete();
  await stopping;
  t.mock.timers.tick(DEMO_DATA_CLEANUP_INTERVAL_MS);
  await flush();
  assert.equal(calls, 2);
});

test('a failed sweep reports failure and retries at the next interval', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let failures = 0;
  const stop = startDemoDataCleanup({
    artifacts,
    enabled: true,
    cleanup: async () => { calls += 1; if (calls === 1) throw new Error('private content'); },
    onSuccess: () => {},
    onError: () => { failures += 1; }
  });
  await flush();
  assert.equal(failures, 1);
  t.mock.timers.tick(DEMO_DATA_CLEANUP_INTERVAL_MS);
  await flush();
  assert.equal(calls, 2);
  await stop();
});
