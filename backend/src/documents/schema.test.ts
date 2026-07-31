import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDocumentSpec } from './presets.js';
import { parseDocumentSpec } from './schema.js';
import { isExplicitWordDocumentRequest } from '../tools/wordDocumentTool.js';

test('parses a valid document spec and applies preset overrides', () => {
  const parsed = parseDocumentSpec({
    title: 'Agent 文档生成方案',
    blocks: [
      { type: 'heading', level: 1, text: '总体设计' },
      { type: 'paragraph', text: '使用结构化规格生成 DOCX。' }
    ],
    format: {
      preset: 'technical-report',
      bodyFontSize: 12,
      primaryColor: '#123456'
    }
  });
  const resolved = resolveDocumentSpec(parsed);

  assert.equal(resolved.fileName, 'Agent 文档生成方案.docx');
  assert.equal(resolved.format.name, 'technical-report');
  assert.equal(resolved.format.bodyFontSize, 12);
  assert.equal(resolved.format.primaryColor, '123456');
  assert.equal(resolved.format.pageSize, 'A4');
});

test('converts Markdown content into validated document blocks', () => {
  const parsed = parseDocumentSpec({
    title: 'Markdown document',
    contentMarkdown: `# Overview

This is **deterministic** content with a [source](https://example.com).

- First item
- Second item

1. Plan
2. Execute

| Dimension | Result |
| --- | --- |
| Stability | Improved |

<!-- pagebreak -->

## Next page`
  });

  assert.deepEqual(parsed.blocks, [
    { type: 'heading', level: 1, text: 'Overview' },
    {
      type: 'paragraph',
      text: 'This is deterministic content with a source（https://example.com）.'
    },
    { type: 'bulletList', items: ['First item', 'Second item'] },
    { type: 'numberedList', items: ['Plan', 'Execute'] },
    {
      type: 'table',
      headers: ['Dimension', 'Result'],
      rows: [['Stability', 'Improved']]
    },
    { type: 'pageBreak' },
    { type: 'heading', level: 2, text: 'Next page' }
  ]);
});

test('keeps the legacy block input compatible', () => {
  const parsed = parseDocumentSpec({
    title: 'Legacy document',
    blocks: [{ type: 'bulletList', items: ['Existing caller'] }]
  });

  assert.deepEqual(parsed.blocks, [{ type: 'bulletList', items: ['Existing caller'] }]);
});

test('requires exactly one supported content representation', () => {
  assert.throws(
    () =>
      parseDocumentSpec({
        title: 'Ambiguous document',
        contentMarkdown: 'Body',
        blocks: [{ type: 'paragraph', text: 'Body' }]
      }),
    /Invalid document specification/
  );
});

test('rejects table rows that do not match the header width', () => {
  assert.throws(
    () =>
      parseDocumentSpec({
        title: 'Invalid table',
        blocks: [
          {
            type: 'table',
            headers: ['A', 'B'],
            rows: [['only one cell']]
          }
        ]
      }),
    /must contain exactly 2 cells/
  );
});

test('rejects unsupported document format values', () => {
  assert.throws(
    () =>
      parseDocumentSpec({
        title: 'Invalid format',
        blocks: [{ type: 'paragraph', text: 'content' }],
        format: { pageSize: 'LEGAL' }
      }),
    /Invalid document specification/
  );
});

test('only forces document generation for explicit Word artifact requests', () => {
  assert.equal(isExplicitWordDocumentRequest('把结果导出成 Word 文档'), true);
  assert.equal(isExplicitWordDocumentRequest('Generate a DOCX report for download'), true);
  assert.equal(isExplicitWordDocumentRequest('帮我总结成一份技术文档'), false);
  assert.equal(isExplicitWordDocumentRequest('介绍一下 Word 文档格式'), false);
});
