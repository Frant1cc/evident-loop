import assert from 'node:assert/strict';
import test from 'node:test';

import { inferArtifactFormats, normalizeArtifactFormats, resolveArtifactFormats } from './formats.js';

test('infers pptx or pdf from explicit user wording and does not treat a generic report as PDF', () => {
  assert.deepEqual(inferArtifactFormats('请生成一份 PPT'), ['pptx']);
  assert.deepEqual(inferArtifactFormats('导出 PDF'), ['pdf']);
  assert.deepEqual(inferArtifactFormats('做成演示文稿和 PDF'), ['pptx', 'pdf']);
  assert.equal(inferArtifactFormats('把研究结论整理成报告'), undefined);
});

test('requested formats win over inferred wording', () => {
  assert.deepEqual(normalizeArtifactFormats(['pdf', 'pptx', 'pdf', 'docx']), ['pptx', 'pdf']);
  assert.deepEqual(resolveArtifactFormats({ requested: ['pdf'], userText: '请生成 PPT' }), ['pdf']);
  assert.deepEqual(resolveArtifactFormats({ userText: '只要幻灯片' }), ['pptx']);
  assert.deepEqual(resolveArtifactFormats({}), ['pptx', 'pdf']);
});
