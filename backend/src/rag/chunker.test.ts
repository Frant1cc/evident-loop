import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chunkingConfig, chunkMarkdownDocument } from './chunker.js';
import type { RagDocument } from './types.js';

function document(content: string): RagDocument {
  return {
    file: 'guide.md',
    title: 'Guide',
    content,
    lineCount: content.split('\n').length
  };
}

test('按 ##/### 构造完整标题路径，并索引首个 ## 前的引言', () => {
  const chunks = chunkMarkdownDocument(document(`# Guide

这是引言内容。

## 检索

父章节说明。

### 混合检索

Dense 与关键词召回。
`));

  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.headingPath), [
    [],
    ['检索'],
    ['检索', '混合检索']
  ]);
  assert.equal(chunks[0]?.content, '这是引言内容。');
  assert.equal(chunks[2]?.heading, '混合检索');
  assert.equal(chunks[2]?.parentId, 'guide.md:检索');
});

test('稳定 ID 不依赖行号，文档前方插入空行不会改变章节 chunk ID', () => {
  const original = chunkMarkdownDocument(document('# Guide\n\n## 章节\n\n正文内容。'));
  const shifted = chunkMarkdownDocument(document('\n\n# Guide\n\n\n## 章节\n\n正文内容。'));
  assert.equal(original[0]?.id, shifted[0]?.id);
  assert.notEqual(original[0]?.startLine, shifted[0]?.startLine);
});

test('长章节按 token 预算拆分并保留文本 overlap', () => {
  const paragraphs = Array.from({ length: 18 }, (_, index) =>
    `第${index + 1}段：${'这是用于验证自适应分块和上下文连续性的中文内容。'.repeat(8)}`
  );
  const chunks = chunkMarkdownDocument(document(`# Guide

## 长章节

${paragraphs.join('\n\n')}
`));

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) =>
    (chunk.tokenCount ?? 0) <= chunkingConfig.targetMaxTokens
  ));
  assert.ok(chunks.slice(1).some((chunk, index) => {
    const previousTail = chunks[index]!.content.slice(-30);
    return chunk.content.includes(previousTail);
  }), '下一 chunk 应包含上一 chunk 的尾部 overlap');
});

test('围栏代码块与 Markdown 表格保持原子，不从中间切断', () => {
  const filler = Array.from({ length: 10 }, (_, index) =>
    `填充段落 ${index}：${'普通文字。'.repeat(25)}`
  ).join('\n\n');
  const code = '```ts\nconst value = 1;\nconsole.log(value);\n```';
  const table = '| 名称 | 说明 |\n| --- | --- |\n| Dense | 向量召回 |\n| FTS | 关键词召回 |';
  const chunks = chunkMarkdownDocument(document(`# Guide

## 保护内容

${filler}

${code}

${filler}

${table}

${filler}
`));

  assert.equal(chunks.filter((chunk) => chunk.content.includes('const value = 1;')).length, 1);
  assert.ok(chunks.find((chunk) => chunk.content.includes('const value = 1;'))?.content.includes(code));
  assert.equal(chunks.filter((chunk) => chunk.content.includes('| Dense | 向量召回 |')).length, 1);
  assert.ok(chunks.find((chunk) => chunk.content.includes('| Dense | 向量召回 |'))?.content.includes(table));
});

test('生成顺序、part、前后邻接和内容类型元数据', () => {
  const chunks = chunkMarkdownDocument(document(`# Guide

## 示例

普通说明。

\`\`\`js
run();
\`\`\`
`));
  assert.equal(chunks[0]?.chunkIndex, 0);
  assert.equal(chunks[0]?.partIndex, 0);
  assert.equal(chunks[0]?.previousChunkId, undefined);
  assert.equal(chunks[0]?.nextChunkId, undefined);
  assert.equal(chunks[0]?.contentType, 'mixed');
  assert.ok((chunks[0]?.tokenCount ?? 0) > 0);
});
