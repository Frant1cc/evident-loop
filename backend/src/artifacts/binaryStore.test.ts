import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LocalArtifactBinaryStore } from './generation/binaryStore.js';

test('local artifact binary store keeps keys below root and physically deletes data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-binaries-'));
  try {
    const store = new LocalArtifactBinaryStore(root);
    await store.put('generations/g1/output.bin', Buffer.from('payload'));
    assert.deepEqual(await store.get('generations/g1/output.bin'), Buffer.from('payload'));
    await assert.rejects(() => store.put('../outside.bin', Buffer.from('bad')), /Artifact binary storage key/);
    await store.delete('generations/g1/output.bin');
    assert.equal(await store.get('generations/g1/output.bin'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
