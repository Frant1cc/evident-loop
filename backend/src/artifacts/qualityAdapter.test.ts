import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createExternalArtifactQualityAdapter, type ArtifactCommandRunner } from './generation/qualityAdapter.js';
import { createDefaultArtifactQualityInspector } from './generation/renderers.js';
import { RendererUnavailableError } from './generation/errors.js';
import type { ArtifactSpec, RendererResult, ResearchSnapshot } from './generation/types.js';

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
  }
} satisfies ArtifactSpec;

test('external QA adapter uses fixed short-lived commands and returns PPT preview', async () => {
  const calls: string[] = [];
  const runner: ArtifactCommandRunner = async (command, args, options) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'pdftoppm') {
      for (let page = 1; page <= 8; page += 1) {
        await writeFile(path.join(options?.cwd ?? '.', `preview-${page}.png`), Buffer.from(`png-preview-${page}`));
      }
    }
    if (command === 'pdfinfo') return { stdout: 'Pages:           8\n', stderr: '' };
    if (command === 'pdftotext') return { stdout: 'extractable text', stderr: '' };
    if (command === 'pdffonts') return { stdout: 'name type encoding emb sub uni object ID\nArial TrueType WinAnsi yes yes yes 1 0\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const adapter = createExternalArtifactQualityAdapter({
    libreOfficeBin: 'soffice-test',
    pdfInfoBin: 'pdfinfo',
    pdfToPpmBin: 'pdftoppm',
    pdfToTextBin: 'pdftotext',
    pdfFontsBin: 'pdffonts',
    commandRunner: runner
  });
  const result: RendererResult = {
    buffer: Buffer.from('PK\x03\x04'),
    fileName: 'qa.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };
  const report = await adapter.inspect('pptx', result, spec, snapshot);
  assert.equal(report.ok, true);
  assert.deepEqual(report.preview, Buffer.from('png-preview-1'));
  assert.match(calls.join('\n'), /soffice-test --headless --convert-to pdf/);
  assert.match(calls.join('\n'), /pdffonts/);
});

test('missing external QA dependency is a structured unavailable error', async () => {
  const runner: ArtifactCommandRunner = async () => {
    const error = new Error('spawn pdftoppm ENOENT') as Error & { code?: string };
    error.code = 'ENOENT';
    throw error;
  };
  const adapter = createExternalArtifactQualityAdapter({ commandRunner: runner });
  await assert.rejects(
    () => adapter.inspect('pdf', { buffer: Buffer.from('%PDF-1.7'), fileName: 'qa.pdf', contentType: 'application/pdf' }, spec, snapshot),
    (error: unknown) => error instanceof RendererUnavailableError && error.code === 'renderer_unavailable'
  );
});

test('process-adapter QA catches an empty second page and unembedded font', async () => {
  const runner: ArtifactCommandRunner = async (command, args, options) => {
    if (command === 'pdfinfo') return { stdout: 'Pages:           8\n', stderr: '' };
    if (command === 'pdftotext') {
      const pageIndex = args.indexOf('-f');
      if (pageIndex >= 0 && args[pageIndex + 1] === '2') return { stdout: '', stderr: '' };
      return { stdout: 'page text', stderr: '' };
    }
    if (command === 'pdffonts') return { stdout: 'name type encoding emb sub uni object ID\nArial TrueType WinAnsi no no no 1 0\n', stderr: '' };
    if (command === 'pdftoppm') {
      for (let page = 1; page <= 8; page += 1) {
        await writeFile(path.join(options?.cwd ?? '.', `preview-${page}.png`), Buffer.from(`png-preview-${page}`));
      }
    }
    return { stdout: '', stderr: '' };
  };
  const adapter = createExternalArtifactQualityAdapter({ commandRunner: runner });
  const report = await adapter.inspect('pptx', {
    buffer: Buffer.from('PK\x03\x04'),
    fileName: 'qa.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }, spec, snapshot);
  assert.equal(report.ok, false);
  assert.match(report.diagnostics.join('\n'), /empty rendered page 2/);
  assert.match(report.diagnostics.join('\n'), /font substitution|missing embedded font/);
});

test('QA rejects a PDF whose actual pages are below the requested target', async () => {
  const runner: ArtifactCommandRunner = async (command, _args, options) => {
    if (command === 'pdfinfo') return { stdout: 'Pages:           3\n', stderr: '' };
    if (command === 'pdftotext') return { stdout: 'text', stderr: '' };
    if (command === 'pdffonts') return { stdout: 'name type encoding emb sub uni object ID\nArial TrueType WinAnsi yes yes yes 1 0\n', stderr: '' };
    if (command === 'pdftoppm') {
      for (let page = 1; page <= 3; page += 1) {
        await writeFile(path.join(options?.cwd ?? '.', `preview-${page}.png`), Buffer.from(`png-preview-${page}`));
      }
    }
    return { stdout: '', stderr: '' };
  };
  const adapter = createExternalArtifactQualityAdapter({ commandRunner: runner });
  const report = await adapter.inspect('pdf', {
    buffer: Buffer.from('%PDF-1.7'),
    fileName: 'qa.pdf',
    contentType: 'application/pdf'
  }, spec, snapshot);
  assert.equal(report.ok, false);
  assert.match(report.diagnostics.join('\n'), /differs from persisted target 6/);
});

test('QA rejects a multi-page output when pdftoppm emits too few page PNGs', async () => {
  const runner: ArtifactCommandRunner = async (command, _args, options) => {
    if (command === 'pdfinfo') return { stdout: 'Pages:           8\n', stderr: '' };
    if (command === 'pdftotext') return { stdout: 'text', stderr: '' };
    if (command === 'pdffonts') return { stdout: 'name type encoding emb sub uni object ID\nArial TrueType WinAnsi yes yes yes 1 0\n', stderr: '' };
    if (command === 'pdftoppm') await writeFile(path.join(options?.cwd ?? '.', 'preview-1.png'), Buffer.from('png-preview'));
    return { stdout: '', stderr: '' };
  };
  const report = await createExternalArtifactQualityAdapter({ commandRunner: runner }).inspect('pptx', {
    buffer: Buffer.from('PK\x03\x04'),
    fileName: 'qa.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }, spec, snapshot);
  assert.equal(report.ok, false);
  assert.match(report.diagnostics.join('\n'), /rasterized 1 PNG pages but expected 8/);
});

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
  const inspector = createDefaultArtifactQualityInspector({
    inspect: async () => ({ ok: true, diagnostics: [] })
  });
  const report = await inspector.inspect('pptx', {
    buffer: Buffer.from('PK\x03\x04'),
    fileName: 'qa.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    layoutManifest: { pageCount: 8, pages }
  }, spec, { snapshot });
  assert.equal(report.ok, false);
  assert.match(report.diagnostics.join('\n'), /title-2.*bounds/);
});
