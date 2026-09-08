import * as cheerio from 'cheerio';

import type { ArtifactSpec, PresentationSlide } from './types.js';

export const pptxViewport = { width: 1_600, height: 900 } as const;

type SlideHtmlInput = {
  spec: ArtifactSpec;
  slide: PresentationSlide;
  index: number;
  slideCount: number;
  logoDataUri?: string;
};

const forbiddenElements = [
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'video',
  'audio',
  'canvas',
  'img'
].join(',');

/**
 * Treat model-authored HTML as untrusted input even though it is rendered in
 * an isolated browser with JavaScript and networking disabled. The sanitized
 * result still supports semantic HTML, CSS layouts, tables, and inline SVG.
 */
export function sanitizeSlideHtml(value: string) {
  const $ = cheerio.load(value, undefined, false);
  $(forbiddenElements).remove();
  // The renderer owns the page number, citations, and footer safe area.
  // Model-authored footnotes otherwise duplicate that chrome and frequently
  // occupy the same bottom strip in an otherwise valid slide.
  $('.footnote, .slide-footer, [data-slide-footer]').remove();

  $('style').each((_index, element) => {
    const css = sanitizeSlideCss($(element).html() ?? '');
    if (css.trim()) $(element).text(css);
    else $(element).remove();
  });

  $('*').each((_index, element) => {
    const attributes: Record<string, string> = {
      ...('attribs' in element ? element.attribs : {})
    };
    for (const [name, attributeValue] of Object.entries(attributes)) {
      const normalizedName = name.toLowerCase();
      if (
        normalizedName.startsWith('on') ||
        normalizedName === 'srcdoc' ||
        normalizedName === 'nonce' ||
        normalizedName === 'integrity' ||
        normalizedName === 'crossorigin'
      ) {
        $(element).removeAttr(name);
        continue;
      }
      if (normalizedName === 'style') {
        const css = sanitizeSlideCss(attributeValue);
        if (css.trim()) $(element).attr(name, css);
        else $(element).removeAttr(name);
        continue;
      }
      if (
        normalizedName === 'src' ||
        normalizedName === 'href' ||
        normalizedName === 'xlink:href' ||
        normalizedName === 'action' ||
        normalizedName === 'formaction' ||
        normalizedName === 'poster'
      ) {
        // Fragment references are required by safe inline SVG gradients and
        // clip paths. Every other navigation or fetch target is removed.
        if (!attributeValue.trim().startsWith('#')) $(element).removeAttr(name);
        continue;
      }
      if (/url\s*\(/i.test(attributeValue)) {
        const target = attributeValue.match(/url\s*\(\s*['"]?([^)'"\s]+)['"]?\s*\)/i)?.[1];
        if (!target?.startsWith('#')) $(element).removeAttr(name);
      }
      if (/javascript\s*:/i.test(attributeValue)) {
        $(element).removeAttr(name);
      }
    }
  });

  return $.root().html()?.trim() ?? '';
}

export function sanitizeSlideCss(value: string) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[\s\S]*?;/gi, '')
    .replace(/@font-face\s*\{[\s\S]*?\}/gi, '')
    .replace(/url\s*\(([^)]*)\)/gi, (_match, rawTarget: string) => {
      const target = rawTarget.trim().replace(/^['"]|['"]$/g, '');
      return target.startsWith('#') ? `url(${target})` : 'none';
    })
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/(?:^|;)\s*(?:behavior|-moz-binding)\s*:[^;]*/gi, '')
    .replace(/javascript\s*:/gi, '');
}

export function createPptxSlideHtmlDocument(input: SlideHtmlInput) {
  const colors = themeColors(input.spec);
  const authoredHtml = input.slide.html ? sanitizeSlideHtml(input.slide.html) : '';
  const themeCss = authoredHtml ? sanitizeSlideCss(input.spec.presentation.themeCss ?? '') : '';
  const content = authoredHtml || createFallbackSlideMarkup(input.slide, input.spec);
  const citationText = input.slide.citations.length
    ? `来源：${input.slide.citations.join(' · ')}`
    : '';
  const fontFamily = cssFont(input.spec.branding.bodyFont ?? 'Aptos');
  const titleFontFamily = cssFont(input.spec.branding.titleFont ?? input.spec.branding.bodyFont ?? 'Aptos Display');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none';" />
    <style>
      :root {
        --slide-primary: #${colors.primary};
        --slide-accent: #${colors.accent};
        --slide-background: #${colors.background};
        --slide-panel: #${colors.panel};
        --slide-text: #${colors.text};
        --slide-muted: #${colors.muted};
        --slide-rule: #${colors.rule};
        --slide-font: ${fontFamily};
        --slide-title-font: ${titleFontFamily};
      }
      * { box-sizing: border-box; }
      html, body { width: ${pptxViewport.width}px; height: ${pptxViewport.height}px; margin: 0; overflow: hidden; }
      body { background: var(--slide-background); color: var(--slide-text); font-family: var(--slide-font); }
      #slide-stage { position: relative; width: 100%; height: 100%; overflow: hidden; isolation: isolate; }
      #slide-content { position: absolute; inset: 0; overflow: hidden; }
      #slide-content > :first-child { min-height: 100%; }
      .evident-logo { position: absolute; z-index: 20; top: 34px; right: 42px; max-width: 150px; max-height: 62px; object-fit: contain; }
      .evident-footer { position: absolute; z-index: 20; left: 54px; right: 54px; bottom: 24px; display: flex; align-items: flex-end; gap: 20px; color: var(--slide-muted); font-size: 15px; line-height: 1.25; }
      .evident-citations { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .evident-page { margin-left: auto; font-weight: 700; letter-spacing: .08em; }
      .fallback-slide { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; padding: 68px 76px 82px; overflow: hidden; }
      .fallback-kicker { color: var(--slide-primary); font-size: 24px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
      .fallback-title { max-width: 1320px; margin: 14px 0 0; color: var(--slide-text); font-family: var(--slide-title-font); font-size: 54px; line-height: 1.08; letter-spacing: -.025em; }
      .fallback-title-slide { justify-content: center; padding-right: 440px; background: var(--slide-background); }
      .fallback-title-slide::after { content: ''; position: absolute; z-index: -1; top: 0; right: 0; width: 28%; height: 100%; background: var(--slide-primary); }
      .fallback-title-slide .fallback-title { margin: 0; font-size: 72px; }
      .fallback-summary { max-width: 1050px; margin: 34px 0 0; color: var(--slide-muted); font-size: 28px; line-height: 1.45; }
      .fallback-audience { margin-top: 42px; color: var(--slide-primary); font-size: 24px; font-weight: 750; }
      .fallback-points { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 34px 54px; margin-top: 54px; }
      .fallback-point { position: relative; min-height: 128px; padding: 6px 0 24px 74px; border-bottom: 2px solid var(--slide-rule); }
      .fallback-index { position: absolute; left: 0; top: 0; color: var(--slide-primary); font-family: var(--slide-title-font); font-size: 44px; font-weight: 800; line-height: 1; }
      .fallback-point-text { font-size: 25px; line-height: 1.38; }
      .fallback-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 70px; margin-top: 58px; }
      .fallback-compare-column { padding-top: 22px; border-top: 8px solid var(--slide-primary); }
      .fallback-compare-column:last-child { border-color: var(--slide-accent); }
      .fallback-compare-column p { margin: 0 0 28px; font-size: 25px; line-height: 1.4; }
      .fallback-roadmap { display: flex; align-items: stretch; gap: 0; margin-top: 76px; }
      .fallback-step { position: relative; flex: 1; padding: 74px 30px 28px; border-top: 6px solid var(--slide-primary); }
      .fallback-step + .fallback-step { border-left: 2px solid var(--slide-rule); }
      .fallback-step-number { position: absolute; top: 18px; left: 30px; color: var(--slide-primary); font-size: 24px; font-weight: 850; }
      .fallback-step-text { font-size: 24px; line-height: 1.4; }
      .fallback-chart { display: grid; gap: 24px; margin-top: 54px; }
      .fallback-bar-row { display: grid; grid-template-columns: 220px 1fr 100px; align-items: center; gap: 22px; font-size: 24px; }
      .fallback-bar-track { height: 30px; background: var(--slide-panel); overflow: hidden; }
      .fallback-bar-fill { height: 100%; min-width: 3px; background: var(--slide-primary); }
      .fallback-bar-value { color: var(--slide-primary); font-weight: 800; text-align: right; }
      .fallback-table { width: 100%; margin-top: 46px; border-collapse: collapse; table-layout: fixed; font-size: 24px; }
      .fallback-table th { padding: 18px 20px; background: var(--slide-primary); color: white; text-align: left; }
      .fallback-table td { padding: 17px 20px; border-bottom: 2px solid var(--slide-rule); vertical-align: top; }
      ${themeCss}
    </style>
  </head>
  <body>
    <main id="slide-stage" data-slide-id="${escapeHtml(input.slide.id)}">
      <section id="slide-content">${content}</section>
      ${input.logoDataUri ? `<img class="evident-logo" src="${input.logoDataUri}" alt="品牌标识" />` : ''}
      <footer class="evident-footer">
        <div class="evident-citations">${escapeHtml(citationText)}</div>
        <div class="evident-page">${input.index + 1} / ${input.slideCount}</div>
      </footer>
    </main>
    <style>
      html, body { width: ${pptxViewport.width}px !important; height: ${pptxViewport.height}px !important; margin: 0 !important; overflow: hidden !important; }
      body > #slide-stage { position: relative !important; display: block !important; width: 100% !important; height: 100% !important; overflow: hidden !important; }
      #slide-content > :first-child { width: 100% !important; height: 100% !important; max-height: 100% !important; overflow: hidden !important; }
      #slide-stage > .evident-footer { position: absolute !important; display: flex !important; visibility: visible !important; left: 54px !important; right: 54px !important; bottom: 24px !important; }
    </style>
  </body>
</html>`;
}

function createFallbackSlideMarkup(slide: PresentationSlide, spec: ArtifactSpec) {
  if (slide.kind === 'title') {
    return `<article class="fallback-slide fallback-title-slide" data-pptx-box="title-slide">
      <h1 class="fallback-title">${escapeHtml(slide.title || spec.title)}</h1>
      <p class="fallback-summary">${escapeHtml(spec.brief.executiveSummary)}</p>
      <div class="fallback-audience">${escapeHtml(spec.audience)}</div>
    </article>`;
  }

  const heading = `<div class="fallback-kicker">${escapeHtml(kindLabel(slide.kind))}</div><h1 class="fallback-title">${escapeHtml(slide.title)}</h1>`;
  if (slide.visual?.type === 'table') {
    return `<article class="fallback-slide" data-pptx-box="table-slide">${heading}${tableMarkup(slide.visual.headers, slide.visual.rows)}</article>`;
  }
  if (slide.visual?.type === 'bar') {
    return `<article class="fallback-slide" data-pptx-box="chart-slide">${heading}${barMarkup(slide.visual.labels, slide.visual.values)}</article>`;
  }
  if (slide.kind === 'comparison') {
    const midpoint = Math.max(1, Math.ceil(slide.bullets.length / 2));
    return `<article class="fallback-slide" data-pptx-box="comparison-slide">${heading}
      <div class="fallback-compare">
        <section class="fallback-compare-column">${slide.bullets.slice(0, midpoint).map((item) => `<p>${escapeHtml(item)}</p>`).join('')}</section>
        <section class="fallback-compare-column">${slide.bullets.slice(midpoint).map((item) => `<p>${escapeHtml(item)}</p>`).join('')}</section>
      </div>
    </article>`;
  }
  if (slide.kind === 'closing') {
    return `<article class="fallback-slide" data-pptx-box="closing-slide">${heading}
      <div class="fallback-roadmap">${slide.bullets.map((item, index) => `<section class="fallback-step"><div class="fallback-step-number">${String(index + 1).padStart(2, '0')}</div><div class="fallback-step-text">${escapeHtml(item)}</div></section>`).join('')}</div>
    </article>`;
  }
  return `<article class="fallback-slide" data-pptx-box="content-slide">${heading}
    <div class="fallback-points">${slide.bullets.map((item, index) => `<section class="fallback-point"><div class="fallback-index">${String(index + 1).padStart(2, '0')}</div><div class="fallback-point-text">${escapeHtml(item)}</div></section>`).join('')}</div>
  </article>`;
}

function tableMarkup(headers: string[], rows: string[][]) {
  return `<table class="fallback-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, 8).map((row) => `<tr>${headers.map((_header, index) => `<td>${escapeHtml(row[index] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function barMarkup(labels: string[], values: number[]) {
  const maximum = Math.max(1, ...values.map((value) => Math.abs(value)));
  return `<div class="fallback-chart">${labels.map((label, index) => {
    const value = values[index] ?? 0;
    const width = Math.max(1, Math.round(Math.abs(value) / maximum * 100));
    return `<div class="fallback-bar-row"><div>${escapeHtml(label)}</div><div class="fallback-bar-track"><div class="fallback-bar-fill" style="width:${width}%"></div></div><div class="fallback-bar-value">${escapeHtml(formatNumber(value))}</div></div>`;
  }).join('')}</div>`;
}

function kindLabel(kind: PresentationSlide['kind']) {
  if (kind === 'comparison') return '对比';
  if (kind === 'closing') return '结论与行动';
  return '关键发现';
}

function themeColors(spec: ArtifactSpec) {
  const primary = normalizeHex(spec.branding.primaryColor) ?? ({
    research: '174A67',
    technical: '0F5D62',
    business: '315C4C'
  }[spec.theme]);
  const accent = ({ research: 'D97757', technical: 'D49A45', business: 'C9855B' }[spec.theme]);
  return {
    primary,
    accent,
    background: 'F7F5F0',
    panel: 'E8ECE8',
    text: '172126',
    muted: '667178',
    rule: 'CDD4D1'
  };
}

function normalizeHex(value: string | undefined) {
  return value?.replace(/^#/, '').toUpperCase();
}

function cssFont(value: string) {
  const safe = value.replace(/[^A-Za-z0-9\u3400-\u9FFF ,._-]/g, '').trim() || 'Arial';
  return `'${safe.replace(/'/g, '')}', 'PingFang SC', 'Microsoft YaHei', Arial, sans-serif`;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character] ?? character));
}
