import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb } from '../db.js';
import { deleteKnowledgeDocument, writeKnowledgeDocument } from '../rag/knowledgeFiles.js';
import { readDocument } from './docsTool.js';

initDb();

test('read_document preserves default reading and supports exact line ranges', () => {
  const file = `tests/read-document-${Date.now()}.md`;
  writeKnowledgeDocument(file, '# Title\nalpha\nbeta\ngamma');
  try {
    const full = readDocument({ file }) as Record<string, unknown>;
    assert.equal(full.content, '# Title\nalpha\nbeta\ngamma');
    assert.equal(full.startLine, 1);
    assert.equal(full.endLine, 4);
    assert.equal(full.totalLines, 4);
    assert.equal(full.truncated, false);

    const ranged = readDocument({ file, startLine: 2, endLine: 3 }) as Record<string, unknown>;
    assert.equal(ranged.content, 'alpha\nbeta');
    assert.equal(ranged.startLine, 2);
    assert.equal(ranged.endLine, 3);
  } finally {
    deleteKnowledgeDocument(file);
  }
});

test('read_document validates ranges, paths, unknown files and truncation continuation', () => {
  const file = `tests/read-document-bounds-${Date.now()}.md`;
  writeKnowledgeDocument(file, 'one\ntwo\nthree');
  try {
    assert.throws(() => readDocument({ file, startLine: 0 }), /positive integer/);
    assert.throws(() => readDocument({ file, startLine: 3, endLine: 2 }), /greater than or equal/);
    assert.throws(() => readDocument({ file, startLine: 9 }), /exceeds document length/);
    assert.throws(() => readDocument({ file: '../secret.md' }), /relative knowledge path/);
    assert.throws(() => readDocument({ file: 'missing-document.md' }), /Document not found/);

    const truncated = readDocument({ file, maxChars: 3 }) as Record<string, unknown>;
    assert.equal(truncated.content, 'one');
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.endLine, 1);
    assert.equal(truncated.nextStartLine, 2);
  } finally {
    deleteKnowledgeDocument(file);
  }
});
