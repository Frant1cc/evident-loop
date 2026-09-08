import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultArtifactQualityInspector,
  DefaultDocxRenderer,
  validatePresentationVisualDesign
} from './generation/renderers.js';
import type { ArtifactSpec, ResearchSnapshot } from './generation/types.js';

const snapshot = {
  conversationId: '00000000-0000-0000-0000-000000000001',
  conversationTitle: 'QA',
  messages: [],
  sources: [],
  notes: [],
  capturedAt: '2026-01-01T00:00:00.000Z',
  digest: 'digest'
} satisfies ResearchSnapshot;

const spec = {
  title: 'QA',
  audience: '团队',
  theme: 'research',
  branding: {},
  brief: {
    title: 'QA',
    audience: '团队',
    executiveSummary: '摘要',
    keyFindings: ['发现'],
    recommendations: [],
    sections: [{ id: 's', title: '章节', summary: '摘要', keyPoints: ['要点'], citations: [] }],
    citations: []
  },
  presentation: {
    slides: [
      { id: 'title', title: 'QA', kind: 'title', bullets: [], citations: [] },
      { id: 'content', title: '内容', kind: 'content', bullets: ['要点'], citations: [] }
    ],
    targetSlideCount: 8
  },
  pdf: {
    sections: [
      { id: 'p1', title: '一', paragraphs: ['段落'], bullets: [], citations: [] },
      { id: 'p2', title: '二', paragraphs: ['段落'], bullets: [], citations: [] },
      { id: 'p3', title: '三', paragraphs: ['段落'], bullets: [], citations: [] }
    ],
    targetPageCount: 6
  },
  formats: ['pptx', 'pdf']
} satisfies ArtifactSpec;

test('layout QA catches a bad second-page bbox without claiming perfect overlap detection', async () => {
  const pages = Array.from({ length: 8 }, (_, index) => ({
    page: index + 1,
    width: 13.333,
    height: 7.5,
    boxes: [{ id: `page-${index + 1}`, page: index + 1, kind: 'container' as const, x: 0, y: 0, width: 13.333, height: 7.5 }, {
      id: `title-${index + 1}`,
      page: index + 1,
      kind: 'text' as const,
      x: index === 1 ? -0.2 : 0.5,
      y: 0.5,
      width: 5,
      height: 1
    }]
  }));
  const inspector = createDefaultArtifactQualityInspector();
  const report = await inspector.inspect('pptx', {
    buffer: Buffer.from('PK\x03\x04'),
    fileName: 'qa.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    layoutManifest: { pageCount: 8, pages }
  }, spec, { snapshot });
  assert.equal(report.ok, false);
  assert.match(report.diagnostics.join('\n'), /title-2.*bounds/);
});

test('layout QA ignores visible font line-box overflow but rejects overflow from clipped containers', async () => {
  const makePages = (overflowY: string) => Array.from({ length: 8 }, (_, index) => ({
    page: index + 1,
    width: 13.333,
    height: 7.5,
    boxes: [
      { id: `page-${index + 1}`, page: index + 1, kind: 'container' as const, x: 0, y: 0, width: 13.333, height: 7.5 },
      {
        id: `slide-${index + 1}-content-1`,
        page: index + 1,
        kind: 'text' as const,
        x: 0.6,
        y: 0.6,
        width: 6,
        height: 0.6,
        textLength: 8,
        fontSizePx: 30,
        scrollHeight: 65,
        clientHeight: 57,
        overflowY
      }
    ]
  }));
  const inspector = createDefaultArtifactQualityInspector();
  const visible = await inspector.inspect('pptx', {
    buffer: Buffer.from('PK\x03\x04'),
    fileName: 'visible.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    layoutManifest: { pageCount: 8, pages: makePages('visible') }
  }, spec, { snapshot });
  assert.equal(visible.ok, true);
  assert.doesNotMatch(visible.diagnostics.join('\n'), /vertical clipping/);

  const clipped = await inspector.inspect('pptx', {
    buffer: Buffer.from('PK\x03\x04'),
    fileName: 'hidden.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    layoutManifest: { pageCount: 8, pages: makePages('hidden') }
  }, spec, { snapshot });
  assert.equal(clipped.ok, false);
  assert.match(clipped.diagnostics.join('\n'), /vertical clipping/);
});

test('layout QA tolerates small hidden root scroll after browser grid rounding', async () => {
  const pages = Array.from({ length: 8 }, (_, index) => ({
    page: index + 1,
    width: 13.333,
    height: 7.5,
    boxes: [
      { id: `page-${index + 1}`, page: index + 1, kind: 'container' as const, x: 0, y: 0, width: 13.333, height: 7.5 },
      {
        id: `slide-${index + 1}-content-root`,
        page: index + 1,
        kind: 'container' as const,
        x: 0,
        y: 0,
        width: 13.333,
        height: 7.5,
        scrollHeight: 933,
        clientHeight: 900,
        overflowY: 'hidden'
      }
    ]
  }));
  const report = await createDefaultArtifactQualityInspector().inspect('pptx', {
    buffer: Buffer.from('PK\x03\x04'),
    fileName: 'grid-rounding.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    layoutManifest: { pageCount: 8, pages }
  }, spec, { snapshot });

  assert.equal(report.ok, true);
  assert.doesNotMatch(report.diagnostics.join('\n'), /vertical clipping/);
});

test('DOCX renderer persists the long-form report content as an Office package', async () => {
  const result = await new DefaultDocxRenderer().render(spec, snapshot);

  assert.equal(result.fileName, 'QA.docx');
  assert.equal(result.buffer.subarray(0, 2).toString('ascii'), 'PK');
  assert.ok(result.buffer.byteLength > 5_000);
  assert.match(result.buffer.toString('latin1'), /word\/document\.xml/);
});

test('DOCX quality inspection does not require a fixed-page layout manifest', async () => {
  const result = await new DefaultDocxRenderer().render(spec, snapshot);
  const report = await createDefaultArtifactQualityInspector().inspect('docx', result, spec, { snapshot });

  assert.equal(report.ok, true);
  assert.deepEqual(report.diagnostics, []);
});

test('fixed-layout formats still fail quality inspection without a layout manifest', async () => {
  const report = await createDefaultArtifactQualityInspector().inspect('pptx', {
    buffer: Buffer.from('PK\x03\x04'),
    fileName: 'qa.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }, spec, { snapshot });

  assert.equal(report.ok, false);
  assert.match(report.diagnostics.join('\n'), /Visual layout manifest unavailable/);
});

test('presentation design QA rejects a repeated card-grid deck', () => {
  const cardSpec = {
    ...spec,
    presentation: {
      targetSlideCount: 8,
      slides: Array.from({ length: 8 }, (_, index) => ({
        id: `slide-${index + 1}`,
        title: `页面 ${index + 1}`,
        kind: index === 0 ? 'title' as const : 'content' as const,
        bullets: [],
        html: '<main class="slide"><section class="card">一</section><section class="card">二</section></main>',
        citations: []
      }))
    }
  } satisfies ArtifactSpec;

  assert.match(validatePresentationVisualDesign(cardSpec).join('\n'), /repeats card-grid UI composition/);
});

test('layout QA reports presentation text that is too small to read', async () => {
  const pages = Array.from({ length: 8 }, (_, index) => ({
    page: index + 1,
    width: 13.333,
    height: 7.5,
    boxes: [
      { id: `page-${index + 1}`, page: index + 1, kind: 'container' as const, x: 0, y: 0, width: 13.333, height: 7.5 },
      { id: `slide-${index + 1}-content-1`, page: index + 1, kind: 'text' as const, x: 0.5, y: 7, width: 5, height: 0.3, textLength: 12, fontSizePx: 16 }
    ]
  }));
  const report = await createDefaultArtifactQualityInspector().inspect('pptx', {
    buffer: Buffer.from('PK\x03\x04'),
    fileName: 'qa.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    layoutManifest: { pageCount: 8, pages }
  }, spec, { snapshot });

  assert.equal(report.ok, false);
  assert.match(report.diagnostics.join('\n'), /below 24px/);
  assert.match(report.diagnostics.join('\n'), /footer zone/);
});
