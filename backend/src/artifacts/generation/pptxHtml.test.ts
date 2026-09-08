import assert from 'node:assert/strict';
import test from 'node:test';

import { createPptxSlideHtmlDocument, sanitizeSlideCss, sanitizeSlideHtml } from './pptxHtml.js';
import type { ArtifactSpec } from './types.js';

const spec = {
  title: 'HTML 演示文稿',
  audience: '产品团队',
  theme: 'research',
  branding: {},
  brief: {
    title: 'HTML 演示文稿',
    audience: '产品团队',
    executiveSummary: '以浏览器布局生成视觉完整的幻灯片。',
    keyFindings: ['视觉结构不能退化成项目符号列表。'],
    recommendations: [],
    sections: [{ id: 's1', title: '发现', summary: '说明', keyPoints: ['要点'], citations: [] }],
    citations: []
  },
  presentation: {
    targetSlideCount: 8,
    themeCss: '.hero { display:grid; grid-template-columns: 1fr 1fr; background:#fff; }',
    slides: []
  },
  pdf: {
    targetPageCount: 6,
    sections: [
      { id: 'p1', title: '一', paragraphs: ['说明'], bullets: [], citations: [] },
      { id: 'p2', title: '二', paragraphs: ['说明'], bullets: [], citations: [] },
      { id: 'p3', title: '三', paragraphs: ['说明'], bullets: [], citations: [] },
      { id: 'p4', title: '四', paragraphs: ['说明'], bullets: [], citations: [] }
    ]
  },
  formats: ['pptx']
} satisfies ArtifactSpec;

test('sanitizes active content and remote fetches from model-authored slide HTML', () => {
  const sanitized = sanitizeSlideHtml(`
    <style>@import 'https://bad.test/x.css'; .x{background:url(https://bad.test/a.png)}</style>
    <section onclick="alert(1)" style="color:red;behavior:url(x)">
      <script>alert(1)</script>
      <iframe src="https://bad.test"></iframe>
      <img src="https://bad.test/a.png">
      <div class="footnote">重复来源</div>
      <svg><a href="https://bad.test"><text>安全内容</text></a><rect fill="url(#gradient)" /></svg>
    </section>
  `);

  assert.doesNotMatch(sanitized, /script|iframe|<img|onclick|https:\/\/bad\.test|@import|behavior/i);
  assert.doesNotMatch(sanitized, /重复来源|footnote/);
  assert.match(sanitized, /安全内容/);
  assert.match(sanitized, /fill="url\(#gradient\)"/);
});

test('sanitizes remote CSS while keeping layout rules', () => {
  const sanitized = sanitizeSlideCss('.grid{display:grid;background:url(https://bad.test/a.png)} @import url(x);');
  assert.match(sanitized, /display:grid/);
  assert.doesNotMatch(sanitized, /https:|@import|url\s*\(/i);
});

test('builds a complete 16:9 HTML document from AI markup with enforced citations', () => {
  const html = createPptxSlideHtmlDocument({
    spec,
    slide: {
      id: 'visual',
      title: '视觉页面',
      kind: 'content',
      bullets: ['左侧结论', '右侧证据'],
      html: '<article class="hero"><h1>视觉页面</h1><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg></article>',
      citations: ['S1']
    },
    index: 1,
    slideCount: 8
  });

  assert.match(html, /1600px/);
  assert.match(html, /900px/);
  assert.match(html, /class="hero"/);
  assert.match(html, /grid-template-columns/);
  assert.match(html, /来源：S1/);
  assert.match(html, /2 \/ 8/);
  assert.match(html, /Content-Security-Policy/);
  assert.ok(html.indexOf('body { background: var(--slide-background)') < html.indexOf('.hero { display:grid'));
  assert.ok(html.indexOf('.hero { display:grid') < html.indexOf('#slide-content > :first-child { width: 100% !important'));
});

test('legacy slides without AI HTML get a visual fallback instead of a bullet list', () => {
  const html = createPptxSlideHtmlDocument({
    spec,
    slide: {
      id: 'legacy',
      title: '旧草稿',
      kind: 'content',
      bullets: ['第一个发现', '第二个发现', '第三个发现'],
      citations: []
    },
    index: 2,
    slideCount: 8
  });

  assert.match(html, /fallback-points/);
  assert.match(html, /fallback-index/);
  assert.match(html, /fallback-kicker \{[^}]*font-size: 24px/);
  assert.doesNotMatch(html, /<ul|<li/);
});
