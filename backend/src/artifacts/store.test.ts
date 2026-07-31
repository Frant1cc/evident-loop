import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ArtifactStore, sanitizeDocxFileName } from './store.js';

test('stores and retrieves a document artifact by opaque id', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-artifacts-'));
  const store = new ArtifactStore({ directory, ttlMs: 60_000 });

  try {
    const created = await store.create(Buffer.from('docx-test'), '../技术:方案');
    const retrieved = await store.get(created.artifactId);

    assert.ok(retrieved);
    assert.equal(retrieved.fileName, '_技术_方案.docx');
    assert.equal(retrieved.size, 9);
    assert.equal(await readFile(retrieved.filePath, 'utf8'), 'docx-test');
    assert.equal(await store.get('../../etc/passwd'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('expired artifacts are deleted on access', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-artifacts-expired-'));
  const store = new ArtifactStore({ directory, ttlMs: -1 });

  try {
    const created = await store.create(Buffer.from('expired'), 'expired.docx');
    assert.equal(await store.get(created.artifactId), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sanitizes file names and keeps exactly one docx extension', () => {
  assert.equal(sanitizeDocxFileName('  报告?.DOCX.docx  '), '报告_.docx');
  assert.equal(sanitizeDocxFileName('...'), 'document.docx');
});
