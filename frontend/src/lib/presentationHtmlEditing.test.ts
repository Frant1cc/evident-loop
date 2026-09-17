import assert from 'node:assert/strict';
import test from 'node:test';

import { patchPresentationHtmlText } from './presentationHtmlEditing';

test('editing a title keeps authored slide structure and styles', () => {
  const html = '<article class="slide editorial"><div class="rail"></div><h1 class="hero">旧标题</h1></article>';
  const result = patchPresentationHtmlText(html, '旧标题', '新标题', { type: 'title' });

  assert.equal(result.replaced, true);
  assert.equal(
    result.html,
    '<article class="slide editorial"><div class="rail"></div><h1 class="hero">新标题</h1></article>'
  );
});

test('editing one bullet changes only that bullet', () => {
  const html = '<div class="slide"><p class="point">相同内容</p><p class="point">相同内容</p></div>';
  const result = patchPresentationHtmlText(html, '相同内容', '第二条更新', {
    type: 'bullet',
    index: 1,
    duplicateOccurrence: 1
  });

  assert.equal(result.replaced, true);
  assert.equal(
    result.html,
    '<div class="slide"><p class="point">相同内容</p><p class="point">第二条更新</p></div>'
  );
});

test('editable markers update content without depending on previous copy', () => {
  const html = '<div class="slide"><h1 data-el-field="title"><span>分段</span>标题</h1></div>';
  const result = patchPresentationHtmlText(html, '模型里的其他标题', '用户标题', { type: 'title' });

  assert.equal(result.replaced, true);
  assert.equal(result.html, '<div class="slide"><h1 data-el-field="title">用户标题</h1></div>');
});

test('text-like attribute values are never rewritten', () => {
  const html = '<div class="slide" aria-label="旧标题"><h1>页面标题</h1></div>';
  const result = patchPresentationHtmlText(html, '旧标题', '新标题', { type: 'title' });

  assert.equal(result.replaced, false);
  assert.equal(result.html, html);
});
