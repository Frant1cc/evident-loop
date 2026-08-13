import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMarkdownDocument } from './parsers/markdownParser.js';
import { parseTextDocument } from './parsers/textParser.js';
import { decodeUtf8 } from './parsers/markdownParser.js';
import { KnowledgeImportError } from './errors.js';

test('Markdown parser keeps heading path, tables and fenced code', () => {
  const parsed = parseMarkdownDocument(`# 债券手册

引言。

## 市场风险

### 利率风险

久期上升会提高敏感度。

\`\`\`ts
const duration = 5.2;
\`\`\`

| 名称 | 久期 |
| --- | --- |
| 债券 A | 5.2 |
`, 'bond.md');

  assert.equal(parsed.title, '债券手册');
  assert.equal(parsed.format, 'md');
  const headings = parsed.blocks.filter((block) => block.type === 'heading').map((block) => block.headingPath);
  assert.deepEqual(headings, [[], ['市场风险'], ['市场风险', '利率风险']]);
  assert.ok(parsed.blocks.some((block) => block.type === 'code' && block.text.includes('duration')));
  const table = parsed.blocks.find((block) => block.type === 'table');
  assert.ok(table);
  assert.deepEqual(table?.metadata.tableHeaders, ['名称', '久期']);
  assert.equal(table?.locator.normalizedLineStart, 15);
});

test('TXT parser strips BOM, splits on blank lines and keeps original line numbers', () => {
  const parsed = parseTextDocument('\uFEFF标题行\n\n第一段内容。\n仍属第一段。\n\n第二段。', 'note.txt');
  assert.equal(parsed.title, '标题行');
  assert.match(parsed.content, /^# 标题行/u);
  const paragraphs = parsed.blocks.filter((block) => block.type === 'paragraph');
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0]?.locator.originalLineStart, 3);
  assert.equal(paragraphs[1]?.locator.originalLineStart, 6);
});

test('TXT parser uses filename when the first line is not a reliable title', () => {
  const parsed = parseTextDocument('这是一句完整的说明句子。\n\n后续段落。', 'risk-notes.txt');
  assert.equal(parsed.title, 'risk-notes');
  assert.match(parsed.content, /^# risk-notes/u);
});

test('UTF-8 decoder rejects NUL bytes', () => {
  assert.throws(
    () => decodeUtf8(Buffer.from([0x61, 0x00, 0x62])),
    (error: unknown) => error instanceof KnowledgeImportError && error.status === 422
  );
});
