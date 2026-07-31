import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { ArtifactStore } from './store.js';
import { createArtifactsRouter } from '../routes/artifacts.js';

test('serves the same artifact inline for preview and as an attachment for download', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-artifact-routes-'));
  const store = new ArtifactStore({ directory, ttlMs: 60_000 });
  const artifact = await store.create(Buffer.from('docx-test-content'), '预览测试.docx');
  const app = express();
  app.use('/api', createArtifactsRouter(store));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const previewResponse = await fetch(
      `${baseUrl}/api/artifacts/${artifact.artifactId}/preview`
    );
    assert.equal(previewResponse.status, 200);
    assert.match(previewResponse.headers.get('content-disposition') ?? '', /^inline;/);
    assert.equal(await previewResponse.text(), 'docx-test-content');

    const downloadResponse = await fetch(
      `${baseUrl}/api/artifacts/${artifact.artifactId}/download`
    );
    assert.equal(downloadResponse.status, 200);
    assert.match(downloadResponse.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(await downloadResponse.text(), 'docx-test-content');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await rm(directory, { recursive: true, force: true });
  }
});
