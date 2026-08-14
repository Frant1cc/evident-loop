import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createOriginalFileStore } from './originalFileStore.js';

test('original file store writes atomically and reads back the same bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-files-'));
  const store = createOriginalFileStore(directory);
  const bytes = Buffer.from('%PDF-1.4 fixture');
  try {
    const key = await store.save({ bytes, extension: '.pdf' });
    assert.match(key, /^[0-9a-f-]{36}\.pdf$/i);
    const stored = await store.read(key);
    assert.deepEqual(stored, bytes);
    await store.delete(key);
    await assert.rejects(() => store.read(key));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
