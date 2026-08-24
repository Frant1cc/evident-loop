import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createResearchArtifactDraft,
  fetchResearchArtifactSourceImage,
  renderResearchArtifact,
  updateResearchArtifactDraft
} from './artifacts';
import type { ArtifactSpec } from '../types/artifacts';

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

test('artifact draft update converts the shared long-form editor content to the persisted report shape', async () => {
  let requestBody = '';
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({ code: 1, message: 'saved', data: { generation: { id: 'generation-1' } } }), { status: 200 });
  };
  const spec = {
    title: '统一文档',
    audience: '团队',
    theme: 'research',
    branding: {},
    brief: {
      title: '统一文档',
      audience: '团队',
      executiveSummary: '摘要',
      keyFindings: [],
      recommendations: [],
      sections: [],
      citations: []
    },
    presentation: { slides: [], targetSlideCount: 8 },
    pdf: { sections: [], targetPageCount: 6 },
    formats: ['docx', 'pdf'],
    longform: {
      blocks: [
        { id: 'heading-1', type: 'heading', level: 1, text: '第一章', citations: [] },
        { id: 'paragraph-1', type: 'paragraph', text: '正文内容', citations: [] }
      ],
      pageSettings: {
        size: 'A4',
        orientation: 'portrait',
        marginTop: 25,
        marginBottom: 25,
        marginLeft: 25,
        marginRight: 25,
        pageNumbers: true
      }
    }
  } as ArtifactSpec;

  await updateResearchArtifactDraft('generation-1', spec);
  const payload = JSON.parse(requestBody) as { spec: Record<string, unknown> & { pdf: { sections: Array<{ title: string; paragraphs: string[] }> } } };
  assert.equal('longform' in payload.spec, false);
  assert.equal(payload.spec.pdf.sections[0]?.title, '第一章');
  assert.deepEqual(payload.spec.pdf.sections[0]?.paragraphs, ['正文内容']);
});
