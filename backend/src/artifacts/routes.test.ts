import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { ArtifactStore } from './store.js';
import { createArtifactsRouter } from '../routes/artifacts.js';
import { initDb } from '../db.js';
import { createResearchConversation, createResearchMessage } from '../research/store.js';
import { createArtifactAgent } from './generation/agent.js';
import { createArtifactGenerationService } from './generation/service.js';
import { createArtifactApplication } from '../modules/artifacts/index.js';

initDb();

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

test('generation API binds image consent and physically deletes opaque generation ids', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: 'API 产物', status: 'complete' });
  const service = createArtifactGenerationService({ model: 'test', agent: createArtifactAgent({ model: 'test' }) });
  const generation = createArtifactApplication({ model: 'test', generationService: service });
  const draft = await generation.createDraft(conversation.id);
  const directory = await mkdtemp(path.join(tmpdir(), 'api-artifact-store-'));
  const app = express();
  app.use(express.json());
  app.use('/api', createArtifactsRouter(new ArtifactStore({ directory, ttlMs: 60_000 }), generation));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const consentResponse = await fetch(`${baseUrl}/api/artifacts/generations/${draft.id}/image-consents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageUrl: 'https://images.example.test/chart.png' })
    });
    assert.equal(consentResponse.status, 201);
    const deleteResponse = await fetch(`${baseUrl}/api/artifacts/generations/${draft.id}`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 200);
    const missingResponse = await fetch(`${baseUrl}/api/artifacts/generations/${draft.id}`);
    assert.equal(missingResponse.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
});

test('generation API fetches a source image only with its consent id', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: 'API 图片', status: 'complete' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const binary = new Map<string, Buffer>();
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    binaryStore: {
      put: async (key, value) => { binary.set(key, value); },
      get: async (key) => binary.get(key) ?? null,
      delete: async (key) => { binary.delete(key); }
    },
    imageFetchImpl: async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
  });
  const generation = createArtifactApplication({ model: 'test', generationService: service });
  const draft = await generation.createDraft(conversation.id);
  const directory = await mkdtemp(path.join(tmpdir(), 'api-artifact-image-'));
  const app = express();
  app.use(express.json());
  app.use('/api', createArtifactsRouter(new ArtifactStore({ directory, ttlMs: 60_000 }), generation));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const consentResponse = await fetch(`${baseUrl}/api/artifacts/generations/${draft.id}/image-consents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageUrl: 'https://images.example.test/chart.png' })
    });
    const consentPayload = await consentResponse.json() as { data: { consent: { id: string } } };
    const imageResponse = await fetch(`${baseUrl}/api/artifacts/generations/${draft.id}/images/source`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageUrl: 'https://images.example.test/chart.png', consentId: consentPayload.data.consent.id })
    });
    assert.equal(imageResponse.status, 201);
    assert.equal((await imageResponse.json() as { data: { asset: { licenseConfirmed: boolean } } }).data.asset.licenseConfirmed, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
});

test('generation API rejects new image consent after a version is confirmed', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: 'API 不可变媒体', status: 'complete' });
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    renderers: {
      pptx: { render: async () => ({ buffer: Buffer.from('PK\x03\x04'), fileName: 'test.pptx', contentType: 'application/octet-stream' }) },
      pdf: { render: async () => ({ buffer: Buffer.from('%PDF-1.7'), fileName: 'test.pdf', contentType: 'application/pdf' }) }
    },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) }
  });
  const generation = createArtifactApplication({ model: 'test', generationService: service });
  const draft = await generation.createDraft(conversation.id);
  const confirmed = generation.startRender(draft.id);
  await generation.waitForRender(confirmed.id);
  const directory = await mkdtemp(path.join(tmpdir(), 'api-artifact-immutable-'));
  const app = express();
  app.use(express.json());
  app.use('/api', createArtifactsRouter(new ArtifactStore({ directory, ttlMs: 60_000 }), generation));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/artifacts/generations/${confirmed.id}/image-consents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageUrl: 'https://images.example.test/immutable.png' })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { message: string }).message, /planning or awaiting-confirmation/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
});
