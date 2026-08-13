import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';

import { migrateKnowledgeSchema } from './migrate.js';

test('old knowledge_documents tables gain new columns and remain readable', () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE knowledge_documents (
      path TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO knowledge_documents (path, content, created_at, updated_at)
    VALUES ('legacy.md', '# 旧文档\n\n正文', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    CREATE TABLE research_sources (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      citation_key TEXT NOT NULL,
      file TEXT NOT NULL,
      title TEXT NOT NULL,
      heading TEXT,
      content TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      score REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  migrateKnowledgeSchema(sqlite);

  const document = sqlite.prepare('SELECT * FROM knowledge_documents WHERE path = ?').all('legacy.md')[0] as {
    source_type: string;
    format: string;
    parser_name: string;
    content: string;
  };
  assert.equal(document.source_type, 'manual');
  assert.equal(document.format, 'md');
  assert.equal(document.parser_name, 'legacy-markdown');
  assert.equal(document.content, '# 旧文档\n\n正文');

  sqlite.exec(`INSERT INTO knowledge_document_blocks
    (id, document_path, block_order, block_type, text) VALUES ('b1', 'legacy.md', 0, 'paragraph', '正文')`);
  sqlite.exec(`DELETE FROM knowledge_documents WHERE path = 'legacy.md'`);
  const leftover = sqlite.prepare('SELECT count(*) AS total FROM knowledge_document_blocks').all()[0] as { total: number };
  assert.equal(leftover.total, 0);
});
