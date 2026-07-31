import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDocumentSpec } from './presets.js';
import { renderWordDocument } from './renderer.js';
import { parseDocumentSpec } from './schema.js';
import type { DocumentPresetName } from './types.js';

const presets: DocumentPresetName[] = [
  'research-report',
  'technical-report',
  'business-report',
  'simple'
];

for (const preset of presets) {
  test(`renders the ${preset} preset as a DOCX package`, async () => {
    const buffer = await renderWordDocument(
      resolveDocumentSpec({
        title: `${preset} 测试文档`,
        subtitle: 'V1 文档生成验证',
        author: 'EvidentLoop',
        format: { preset },
        blocks: [
          { type: 'heading', level: 1, text: '核心能力' },
          { type: 'paragraph', text: '支持中文段落、换行和格式模板。\n第二行内容。' },
          { type: 'bulletList', items: ['结构化输入', '确定性渲染'] },
          { type: 'numberedList', items: ['校验参数', '生成文件'] },
          {
            type: 'table',
            headers: ['模块', '职责', '状态'],
            rows: [
              ['DocumentSpec', '定义文档结构', '完成'],
              ['Renderer', '生成 DOCX 文件', '完成']
            ]
          }
        ]
      })
    );

    assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK');
    assert.ok(buffer.byteLength > 5_000);
    assert.match(buffer.toString('latin1'), /word\/document\.xml/);
  });
}

test('renders Markdown tool input through the complete document pipeline', async () => {
  const input = parseDocumentSpec({
    title: 'Markdown 稳定性验证',
    contentMarkdown: `# 摘要

正文内容。

- 稳定输入
- 确定性转换

| 项目 | 结果 |
| --- | --- |
| DOCX | 通过 |`,
    format: { preset: 'technical-report' }
  });
  const buffer = await renderWordDocument(resolveDocumentSpec(input));

  assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK');
  assert.ok(buffer.byteLength > 5_000);
  assert.match(buffer.toString('latin1'), /word\/document\.xml/);
});
