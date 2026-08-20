import assert from 'node:assert/strict';
import test from 'node:test';

import { createResearchArtifactDraft, fetchResearchArtifactSourceImage, renderResearchArtifact } from './artifacts';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('artifact draft API uses the conversation-scoped endpoint and returns structured generation data', async () => {
  let requestUrl = '';
  let requestMethod = '';
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestMethod = String(init?.method);
    return new Response(JSON.stringify({ code: 1, message: 'ok', data: {
      generation: {
        id: 'generation-1',
        conversationId: 'conversation-1',
        version: 1,
        snapshotDigest: 'digest',
        status: 'awaiting_confirmation',
        stale: false,
        spec: {},
        outputs: [],
        createdAt: 'now',
        updatedAt: 'now'
      }
    } }), { status: 201 });
  };

  const result = await createResearchArtifactDraft('conversation/1', { theme: 'technical' });
  assert.equal(requestUrl, '/api/research/conversations/conversation%2F1/artifacts/drafts');
  assert.equal(requestMethod, 'POST');
  assert.equal(result.generation.status, 'awaiting_confirmation');
});

test('artifact render API is explicit and never uses a download URL as a render command', async () => {
  let requestUrl = '';
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({ code: 1, message: 'started', data: { generation: { id: 'g' } } }), { status: 202 });
  };
  await renderResearchArtifact('generation-1');
  assert.equal(requestUrl, '/api/artifacts/generations/generation-1/render');
});

test('authorized source-image API keeps the consent id in its request body', async () => {
  let requestUrl = '';
  let requestBody = '';
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    return new Response(JSON.stringify({ code: 1, message: 'stored', data: { asset: { id: 'asset-1' } } }), { status: 201 });
  };
  await fetchResearchArtifactSourceImage({
    generationId: 'generation-1',
    imageUrl: 'https://images.example.test/chart.png',
    consentId: 'consent-1'
  });
  assert.equal(requestUrl, '/api/artifacts/generations/generation-1/images/source');
  assert.match(requestBody, /"consentId":"consent-1"/);
});
