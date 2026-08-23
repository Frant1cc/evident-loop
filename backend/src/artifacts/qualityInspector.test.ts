import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultArtifactQualityInspector } from './generation/renderers.js';
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
