import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateChatConversationsToResearch, mapId } from './migrateChat.js';

function seedDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE chat_conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('streaming','complete','error')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE research_conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, topic TEXT, summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE research_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('streaming','complete','error')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES research_conversations(id) ON DELETE CASCADE
    );
  `);
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?, ?, ?)')
    .run('c1', '旧对话', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  db.prepare('INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?, ?)')
    .run('m1', 'c1', 'user', '问题', 'complete', '2026-01-01T00:00:01.000Z');
  db.prepare('INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?, ?)')
    .run('m2', 'c1', 'assistant', '回答', 'complete', '2026-01-01T00:00:02.000Z');
  return db;
}

test('migrates chat conversations and messages into research tables', () => {
  const db = seedDb();
  migrateChatConversationsToResearch(db as never);

  const conversation = db.prepare('SELECT * FROM research_conversations WHERE id = ?')
    .get(mapId('conversation', 'c1')) as { title: string; created_at: string; updated_at: string };
  assert.equal(conversation.title, '旧对话');
  assert.equal(conversation.created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(conversation.updated_at, '2026-01-02T00:00:00.000Z');

  const messages = db.prepare('SELECT * FROM research_messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(mapId('conversation', 'c1')) as Array<{ role: string; content: string }>;
  assert.deepEqual(messages.map((m) => [m.role, m.content]), [['user', '问题'], ['assistant', '回答']]);
});

test('running the migration twice does not duplicate rows', () => {
  const db = seedDb();
  migrateChatConversationsToResearch(db as never);
  migrateChatConversationsToResearch(db as never);

  const conversationCount = db.prepare('SELECT COUNT(*) AS n FROM research_conversations').get() as { n: number };
  const messageCount = db.prepare('SELECT COUNT(*) AS n FROM research_messages').get() as { n: number };
  assert.equal(conversationCount.n, 1);
  assert.equal(messageCount.n, 2);
});

test('records a migration key so a re-run is a no-op even after new chat data appears', () => {
  const db = seedDb();
  migrateChatConversationsToResearch(db as never);
  // A new chat conversation added after the migration ran should NOT be imported on re-run,
  // because the migration key marks it complete (§8: idempotent, one-time).
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?, ?, ?)')
    .run('c2', '之后的对话', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
  migrateChatConversationsToResearch(db as never);

  const exists = db.prepare('SELECT id FROM research_conversations WHERE id = ?')
    .get(mapId('conversation', 'c2'));
  assert.equal(exists, undefined);
});

test('no chat tables is a valid state and still records the key', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE research_conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, topic TEXT, summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE research_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  migrateChatConversationsToResearch(db as never);
  const key = db.prepare('SELECT key FROM schema_migrations').get() as { key: string };
  assert.ok(key);
});
