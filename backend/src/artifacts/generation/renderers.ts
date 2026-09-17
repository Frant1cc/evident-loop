import type {
  ArtifactFormat,
  ArtifactQualityInspector,
  ArtifactRenderer,
  ArtifactSpec,
  ArtifactRenderAsset,
  ArtifactLayoutManifest,
  ArtifactLayoutBox,
  QualityReport,
  RendererContext,
  RendererResult,
  ResearchSnapshot
} from './types.js';
import { validateArtifactCitations } from './schema.js';
import { RendererUnavailableError } from './errors.js';
import { resolveDocumentSpec } from '../../documents/presets.js';
import { renderWordDocument } from '../../documents/renderer.js';
import type { DocumentBlock, DocumentPresetName } from '../../documents/types.js';
import {
  createPptxSlideHtmlDocument,
  pptxViewport,
  validatePresentationAuthoringCompleteness
} from './pptxHtml.js';

export { RendererUnavailableError } from './errors.js';

export class DefaultPptxRenderer implements ArtifactRenderer {
  async render(spec: ArtifactSpec, _snapshot: ResearchSnapshot, context?: RendererContext): Promise<RendererResult> {
    throwIfAborted(context?.signal);
    const authoringDiagnostics = validatePresentationAuthoringCompleteness(spec);
    if (authoringDiagnostics.length) {
      throw new Error(`PPTX authoring is incomplete: ${authoringDiagnostics.join('; ')}`);
    }
    const [pptxModule, playwrightModule] = await Promise.all([
      importOptional('pptxgenjs'),
      importOptional('playwright')
    ]);
    if (!pptxModule) {
      throw new RendererUnavailableError(
        'PPTX renderer unavailable: install pptxgenjs and ensure the backend can load it'
      );
    }
    const chromium = playwrightModule?.chromium ?? playwrightModule?.default?.chromium;
    if (!chromium) {
      throw new RendererUnavailableError(
        'PPTX renderer unavailable: Playwright Chromium is required for HTML slide rendering'
      );
    }
    const PptxGenJS = pptxModule.default ?? pptxModule;
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'EvidentLoop';
    pptx.subject = spec.title;
    pptx.title = spec.title;
    pptx.company = 'EvidentLoop';
    pptx.lang = 'zh-CN';
    pptx.theme = {
      headFontFace: spec.branding.titleFont ?? 'Aptos Display',
      bodyFontFace: spec.branding.bodyFont ?? 'Aptos',
      lang: 'zh-CN'
    };

    const plannedSlides = normalizePresentationSlides(spec.presentation.slides, spec.title);
    const logo = findBrandAsset(spec, context?.assets);
    let browser: any;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      throw new RendererUnavailableError(
        `PPTX renderer unavailable: Chromium could not start (${error instanceof Error ? error.message : 'launch failed'})`
      );
    }
    try {
      const browserContext = await browser.newContext({
        viewport: pptxViewport,
        deviceScaleFactor: 1,
        javaScriptEnabled: false
      });
      const page = await browserContext.newPage();
      await page.route('**/*', (route: any) => route.abort('blockedbyclient'));
      const screenshots: Buffer[] = [];
      const layoutPages: ArtifactLayoutManifest['pages'] = [];
      const diagnostics: string[] = [];
      for (const [index, slidePlan] of plannedSlides.entries()) {
        throwIfAborted(context?.signal);
        const html = createPptxSlideHtmlDocument({
          spec,
          slide: slidePlan,
          index,
          slideCount: plannedSlides.length,
          ...(logo ? { logoDataUri: toDataUri(logo) } : {})
        });
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        await page.evaluate(async () => { await document.fonts?.ready; });
        await fitOversizedPptxVisuals(page);
        const metrics = await inspectPptxHtmlPage(page, index + 1);
        if (!metrics.boxes.some((box) => box.id.includes('-content-'))) {
          diagnostics.push(`HTML slide ${index + 1} has no visible content after sanitization`);
        }
        const screenshot = Buffer.from(await page.screenshot({ type: 'png', fullPage: false }));
        screenshots.push(screenshot);
        layoutPages.push(metrics);

        const slide = pptx.addSlide();
        slide.background = { color: 'FFFFFF' };
        slide.addImage({
          data: `data:image/png;base64,${screenshot.toString('base64')}`,
          x: 0,
          y: 0,
          w: 13.333,
          h: 7.5
        });
        const notes = [
          slidePlan.speakerNotes,
          slidePlan.citations.length ? `来源：${slidePlan.citations.join('、')}` : undefined
        ].filter((value): value is string => Boolean(value));
        if (notes.length) slide.addNotes?.(notes.join('\n\n'));
        context?.onProgress?.(`HTML slide rendered: ${slidePlan.title}`);
      }

      const preview = await createPptxContactSheet(page, screenshots);
      const buffer = await pptx.write({ outputType: 'nodebuffer' });
      return {
        buffer: Buffer.from(buffer),
        fileName: `${safeFileStem(spec.title)}.pptx`,
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        preview,
        previewContentType: 'image/png',
        diagnostics,
        provenance: context?.visualProvenance,
        renderedSpec: spec,
        layoutManifest: {
          pageCount: layoutPages.length,
          pages: layoutPages,
          limitations: ['PPTX slides contain pixel-faithful HTML renderings; text and diagrams inside the slide image are not independently editable.']
        }
      };
    } finally {
      await browser.close();
    }
  }
}

export class DefaultPdfRenderer implements ArtifactRenderer {
  async render(spec: ArtifactSpec, snapshot: ResearchSnapshot, context?: RendererContext): Promise<RendererResult> {
    throwIfAborted(context?.signal);
    const imported = await importOptional('playwright');
    const chromium = imported?.chromium ?? imported?.default?.chromium;
    if (!chromium) {
      throw new RendererUnavailableError(
        'PDF renderer unavailable: install playwright and run its Chromium preflight'
      );
    }
    let browser: any;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      throw new RendererUnavailableError(
        `PDF renderer unavailable: Chromium could not start (${error instanceof Error ? error.message : 'launch failed'})`
      );
    }
    try {
      const page = await browser.newPage({
        viewport: { width: 1_248, height: 1_764 },
        deviceScaleFactor: 1
      });
      await page.setContent(createReportHtml(spec, snapshot, context?.assets), { waitUntil: 'load' });
      throwIfAborted(context?.signal);
      let domMetrics: PdfDomMetrics | undefined;
      try {
        domMetrics = await page.evaluate(() => {
          const root = document.documentElement;
          return {
            root: {
              scrollWidth: root.scrollWidth,
              clientWidth: root.clientWidth,
              scrollHeight: root.scrollHeight,
              clientHeight: root.clientHeight
            },
            sections: Array.from(document.querySelectorAll<HTMLElement>('header, .asset-gallery, .report-section, .references'))
              .map((element, index) => {
                const rect = element.getBoundingClientRect();
                return {
                  index,
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                  scrollWidth: element.scrollWidth,
                  clientWidth: element.clientWidth,
                  scrollHeight: element.scrollHeight,
                  clientHeight: element.clientHeight
                };
              })
          };
        }) as PdfDomMetrics;
      } catch {
        // The external QA adapter will report this limitation rather than
        // claiming that layout inspection was complete.
      }
      const pageSettings = spec.longform?.pageSettings;
      const showHeaderFooter = Boolean(
        pageSettings?.header || pageSettings?.footer || pageSettings?.pageNumbers
      );
      const headerText = pageSettings?.header ? escapeHtml(pageSettings.header) : '';
      const footerText = pageSettings?.footer ? escapeHtml(pageSettings.footer) : '';
      const footerSeparator = footerText && pageSettings?.pageNumbers ? ' · ' : '';
      const buffer = await page.pdf({
        format: pageSettings?.size ?? 'A4',
        landscape: pageSettings?.orientation === 'landscape',
        printBackground: true,
        displayHeaderFooter: showHeaderFooter,
        headerTemplate: `<div style="font-size:8px;color:#64748b;width:100%;padding:0 10mm;text-align:right">${headerText}</div>`,
        footerTemplate: `<div style="font-size:8px;color:#64748b;width:100%;padding:0 10mm;text-align:center">${footerText}${footerSeparator}${pageSettings?.pageNumbers ? '<span class="pageNumber"></span>' : ''}</div>`,
        margin: pageSettings
          ? {
              top: `${pageSettings.marginTop}mm`,
              right: `${pageSettings.marginRight}mm`,
              bottom: `${pageSettings.marginBottom}mm`,
              left: `${pageSettings.marginLeft}mm`
            }
          : { top: '16mm', right: '16mm', bottom: '18mm', left: '16mm' }
      });
      context?.onProgress?.('PDF report rendered by Chromium');
      return {
        buffer: Buffer.from(buffer),
        fileName: `${safeFileStem(spec.title)}.pdf`,
        contentType: 'application/pdf',
        provenance: context?.visualProvenance,
        renderedSpec: spec,
        layoutManifest: createPdfLayoutManifest(spec, domMetrics, context?.assets ?? [])
      };
    } finally {
      await browser.close();
    }
  }
}

export class DefaultArtifactQualityInspector implements ArtifactQualityInspector {
  async inspect(format: ArtifactFormat, result: RendererResult, spec: ArtifactSpec, context?: RendererContext): Promise<QualityReport> {
    const diagnostics = [...(result.diagnostics ?? [])];
    if (result.buffer.byteLength === 0) diagnostics.push(`${format} renderer returned an empty file`);
    if (format === 'pptx' && !result.buffer.subarray(0, 2).equals(Buffer.from('PK'))) {
      diagnostics.push('PPTX output is not a valid ZIP package');
    }
    if (format === 'docx' && !result.buffer.subarray(0, 2).equals(Buffer.from('PK'))) {
      diagnostics.push('DOCX output is not a valid ZIP/OOXML package');
    }
    if (format === 'pdf' && !result.buffer.subarray(0, 4).equals(Buffer.from('%PDF'))) {
      diagnostics.push('PDF output does not have a PDF header');
    }
    if (format === 'pptx') {
      diagnostics.push(...validatePresentationAuthoringCompleteness(spec));
      diagnostics.push(...validatePresentationVisualDesign(spec));
    }

    // Basic DOCX OOXML structure validation
    if (format === 'docx') {
      let AdmZip: any;
      try {
        const mod = await importOptional('adm-zip');
        if (mod) AdmZip = mod.default ?? mod;
      } catch {
        AdmZip = null;
      }

      if (AdmZip && result.buffer.subarray(0, 2).equals(Buffer.from('PK'))) {
        try {
          const zip = new AdmZip(result.buffer);
          const entries = zip.getEntries().map((entry: any) => entry.entryName as string);
          if (!entries.includes('[Content_Types].xml')) {
            diagnostics.push('DOCX is missing [Content_Types].xml');
          }
          if (!entries.includes('word/document.xml')) {
            diagnostics.push('DOCX is missing word/document.xml');
          }
          if (entries.includes('word/document.xml')) {
            const docXml = zip.readAsText('word/document.xml');
            if (!docXml.includes(spec.title.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] ?? c)))) {
              diagnostics.push('DOCX document.xml does not include the title');
            }
          }
        } catch (error) {
          diagnostics.push(`DOCX structure validation failed: ${error instanceof Error ? error.message : 'unknown'}`);
        }
      }
    }

    const snapshot = context?.snapshot;
    if (snapshot) {
      diagnostics.push(...validateArtifactCitationsAgainstSnapshot(spec, snapshot));
    } else {
      diagnostics.push(...validateArtifactCitations(spec).map((key) => `Unknown citation key in spec: ${key}`));
    }
    // PPTX and PDF renderers produce page geometry that can be checked for
    // clipping and overlap. DOCX is a reflowable OOXML document, so requiring
    // the same fixed-page manifest would reject an otherwise valid Word file.
    if (format !== 'docx') {
      diagnostics.push(...validateLayoutManifest(format, result.layoutManifest, spec));
    }
    return { ok: diagnostics.length === 0, diagnostics };
  }
}

function validateLayoutManifest(
  format: ArtifactFormat,
  manifest: ArtifactLayoutManifest | undefined,
  spec: ArtifactSpec
) {
  if (!manifest) return ['Visual layout manifest unavailable; bounds, overlap, and DOM overflow checks were not performed'];
  const expected = format === 'pptx' ? spec.presentation.targetSlideCount : spec.pdf.targetPageCount;
  const diagnostics: string[] = [];
  if (manifest.pageCount !== expected) diagnostics.push(`Layout manifest page count ${manifest.pageCount} differs from target ${expected}`);
  if (manifest.pages.length !== manifest.pageCount) diagnostics.push(`Layout manifest contains ${manifest.pages.length} pages for declared ${manifest.pageCount}`);
  for (const page of manifest.pages) {
    if (page.scrollWidth !== undefined && page.clientWidth !== undefined && page.scrollWidth > page.clientWidth + 1) {
      diagnostics.push(`Layout page ${page.page} has horizontal DOM overflow (${page.scrollWidth} > ${page.clientWidth})`);
    }
    if (page.scrollHeight !== undefined && page.clientHeight !== undefined && page.scrollHeight > page.clientHeight + 1) {
      diagnostics.push(`Layout page ${page.page} has vertical DOM overflow (${page.scrollHeight} > ${page.clientHeight})`);
    }
    for (const box of page.boxes) {
      if (box.x < 0 || box.y < 0 || box.x + box.width > page.width + 0.01 || box.y + box.height > page.height + 0.01) {
        diagnostics.push(`Layout box ${describeLayoutBox(box)} exceeds page ${page.page} bounds`);
      }
      const clippedContentRootX = box.id.endsWith('-content-root')
        && (box.overflowX === 'hidden' || box.overflowX === 'clip');
      const clippedContentRootY = box.id.endsWith('-content-root')
        && (box.overflowY === 'hidden' || box.overflowY === 'clip');
      if (
        !clippedContentRootX
        && box.overflowX !== 'visible'
        && box.scrollWidth !== undefined
        && box.clientWidth !== undefined
        && box.scrollWidth > box.clientWidth + 1
      ) {
        diagnostics.push(`Layout box ${describeLayoutBox(box)} reports horizontal clipping (${box.scrollWidth} > ${box.clientWidth})`);
      }
      if (
        !clippedContentRootY
        && box.overflowY !== 'visible'
        && box.scrollHeight !== undefined
        && box.clientHeight !== undefined
        && box.scrollHeight > box.clientHeight + 1
      ) {
        diagnostics.push(`Layout box ${describeLayoutBox(box)} reports vertical clipping (${box.scrollHeight} > ${box.clientHeight})`);
      }
      if (box.estimatedTextHeight !== undefined && box.estimatedTextHeight > box.height * 1.05) {
        diagnostics.push(`Layout box ${describeLayoutBox(box)} has estimated text height ${Math.round(box.estimatedTextHeight)} above its ${Math.round(box.height)} box; clipping check is heuristic`);
      }
    }
    const undersizedText = page.boxes.filter((box) =>
      box.kind === 'text'
      && box.id.includes('-content-')
      && box.textLength
      && box.fontSizePx !== undefined
      && box.fontSizePx < 24
    );
    if (undersizedText.length) {
      const smallest = Math.min(...undersizedText.map((box) => box.fontSizePx!));
      diagnostics.push(`Layout page ${page.page} contains ${undersizedText.length} text element(s) below 24px (minimum ${Math.round(smallest)}px)`);
    }
    const unsafeText = page.boxes.filter((box) =>
      box.kind === 'text'
      && box.id.includes('-content-')
      && (
        box.x < 0.3
        || box.x + box.width > page.width - 0.3
        || box.y < 0.25
        || box.y + box.height > page.height - 0.6
      )
    );
    if (unsafeText.length) {
      diagnostics.push(`Layout page ${page.page} places text outside the title/body safe area or inside the footer zone: ${unsafeText.map(describeLayoutBox).join('; ')}`);
    }
    const visible = page.boxes.filter((box) => box.kind !== 'container');
    for (let left = 0; left < visible.length; left += 1) {
      for (let right = left + 1; right < visible.length; right += 1) {
        const overlap = overlapRatio(visible[left]!, visible[right]!);
        if (overlap >= 0.8) {
          diagnostics.push(`Layout boxes ${describeLayoutBox(visible[left]!)} and ${describeLayoutBox(visible[right]!)} have high overlap (${Math.round(overlap * 100)}%); visual collision detection is heuristic`);
        }
      }
    }
  }
  return diagnostics;
}

function describeLayoutBox(box: ArtifactLayoutBox) {
  const identity = box.debugLabel ? `${box.id} [${box.debugLabel}]` : box.id;
  return `${identity} at x=${box.x.toFixed(2)}, y=${box.y.toFixed(2)}, w=${box.width.toFixed(2)}, h=${box.height.toFixed(2)}`;
}

export function validatePresentationVisualDesign(spec: ArtifactSpec) {
  const authoredSlides = spec.presentation.slides.filter((slide) => Boolean(slide.html?.trim()));
  if (!authoredSlides.length) return [];
  const diagnostics: string[] = [];
  const cardHeavySlides = authoredSlides.filter((slide) => countHtmlClass(slide.html ?? '', 'card') >= 2);
  if (cardHeavySlides.length >= Math.max(2, Math.ceil(authoredSlides.length * 0.4))) {
    diagnostics.push(`Presentation repeats card-grid UI composition on ${cardHeavySlides.length} of ${authoredSlides.length} authored slides; use flatter, content-specific layouts`);
  }
  const listSlides = authoredSlides.filter((slide) => /<(?:ul|ol)\b/i.test(slide.html ?? ''));
  if (listSlides.length > authoredSlides.length / 2) {
    diagnostics.push(`Presentation uses HTML bullet lists on ${listSlides.length} of ${authoredSlides.length} authored slides; replace repeated lists with visual explanations`);
  }
  return diagnostics;
}

function countHtmlClass(html: string, className: string) {
  let count = 0;
  const classPattern = /\bclass\s*=\s*(['"])(.*?)\1/gi;
  for (const match of html.matchAll(classPattern)) {
    if (match[2]?.split(/\s+/).includes(className)) count += 1;
  }
  return count;
}

function overlapRatio(left: ArtifactLayoutBox, right: ArtifactLayoutBox) {
  if (left.page !== right.page) return 0;
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = width * height;
  if (!intersection) return 0;
  return intersection / Math.min(left.width * left.height, right.width * right.height);
}

export class DefaultDocxRenderer implements ArtifactRenderer {
  async render(spec: ArtifactSpec, _snapshot: ResearchSnapshot, context?: RendererContext): Promise<RendererResult> {
    throwIfAborted(context?.signal);
    const blocks = createArtifactDocumentBlocks(spec);
    const presetByTheme: Record<ArtifactSpec['theme'], DocumentPresetName> = {
      research: 'research-report',
      technical: 'technical-report',
      business: 'business-report'
    };
    const pageSettings = spec.longform?.pageSettings;
    const resolved = resolveDocumentSpec({
      fileName: `${safeFileStem(spec.title)}.docx`,
      title: spec.title,
      subtitle: spec.audience,
      author: 'EvidentLoop',
      blocks,
      format: {
        preset: presetByTheme[spec.theme],
        ...(pageSettings ? {
          pageSize: pageSettings.size === 'Letter' ? 'LETTER' as const : 'A4' as const,
          orientation: pageSettings.orientation,
          margins: {
            top: pageSettings.marginTop,
            right: pageSettings.marginRight,
            bottom: pageSettings.marginBottom,
            left: pageSettings.marginLeft
          },
          showHeader: Boolean(pageSettings.header),
          ...(pageSettings.header ? { headerText: pageSettings.header } : {}),
          ...(pageSettings.footer ? { footerText: pageSettings.footer } : {}),
          showPageNumber: pageSettings.pageNumbers
        } : {}),
        ...(spec.branding.primaryColor ? { primaryColor: spec.branding.primaryColor } : {}),
        ...(spec.branding.titleFont ? { titleFont: spec.branding.titleFont } : {}),
        ...(spec.branding.bodyFont ? { bodyFont: spec.branding.bodyFont } : {})
      }
    });
    const buffer = await renderWordDocument(resolved);
    context?.onProgress?.('Word document rendered');
    return {
      buffer,
      fileName: resolved.fileName,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      renderedSpec: spec
    };
  }
}

function createArtifactDocumentBlocks(spec: ArtifactSpec): DocumentBlock[] {
  if (spec.longform?.blocks.length) {
    return spec.longform.blocks.map((block): DocumentBlock => {
      switch (block.type) {
        case 'heading':
          return { type: 'heading', level: block.level, text: block.text };
        case 'paragraph':
          return { type: 'paragraph', text: block.text };
        case 'bulletList':
          return { type: 'bulletList', items: block.items };
        case 'numberedList':
          return { type: 'numberedList', items: block.items };
        case 'table':
          return { type: 'table', headers: block.headers, rows: block.rows };
        case 'pageBreak':
          return { type: 'pageBreak' };
      }
    });
  }

  return [
    { type: 'heading', level: 1, text: '执行摘要' },
    { type: 'paragraph', text: spec.brief.executiveSummary },
    ...spec.pdf.sections.flatMap<DocumentBlock>((section) => [
      { type: 'heading', level: 1, text: section.title },
      ...section.paragraphs.map((text): DocumentBlock => ({ type: 'paragraph', text })),
      ...(section.bullets.length
        ? [{ type: 'bulletList', items: section.bullets } satisfies DocumentBlock]
        : [])
    ]),
    ...(spec.brief.keyFindings.length
      ? [
          { type: 'heading', level: 1, text: '主要结论' } satisfies DocumentBlock,
          { type: 'bulletList', items: spec.brief.keyFindings } satisfies DocumentBlock
        ]
      : []),
    ...(spec.brief.recommendations.length
      ? [
          { type: 'heading', level: 1, text: '建议' } satisfies DocumentBlock,
          { type: 'numberedList', items: spec.brief.recommendations } satisfies DocumentBlock
        ]
      : [])
  ];
}

export function createDefaultRenderers() {
  return {
    pptx: new DefaultPptxRenderer(),
    docx: new DefaultDocxRenderer(),
    pdf: new DefaultPdfRenderer()
  } satisfies Record<ArtifactFormat, ArtifactRenderer>;
}

export function createDefaultArtifactQualityInspector() {
  return new DefaultArtifactQualityInspector();
}

type PdfDomMetrics = {
  root: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number };
  sections: Array<{
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
  }>;
};

async function fitOversizedPptxVisuals(page: any) {
  await page.evaluate(() => {
    const footerSafeTop = 828;
    for (const visual of document.querySelectorAll<SVGElement>('#slide-content svg')) {
      const rect = visual.getBoundingClientRect();
      if (rect.height <= 0 || rect.bottom <= footerSafeTop) continue;
      const availableHeight = footerSafeTop - rect.top;
      if (availableHeight < 160) continue;
      const scale = Math.min(1, availableHeight / rect.height);
      visual.style.setProperty('width', `${Math.floor(rect.width * scale)}px`, 'important');
      visual.style.setProperty('height', `${Math.floor(rect.height * scale)}px`, 'important');
      visual.style.setProperty('max-width', '100%', 'important');
      visual.style.setProperty('max-height', `${Math.floor(availableHeight)}px`, 'important');
    }
  });
}

async function inspectPptxHtmlPage(page: any, pageNumber: number): Promise<ArtifactLayoutManifest['pages'][number]> {
  return page.evaluate((input: { pageNumber: number; viewportWidth: number; viewportHeight: number }) => {
    const slideWidth = 13.333;
    const slideHeight = 7.5;
    const scaleX = slideWidth / input.viewportWidth;
    const scaleY = slideHeight / input.viewportHeight;
    const stage = document.querySelector<HTMLElement>('#slide-stage');
    const content = document.querySelector<HTMLElement>('#slide-content');
    const boxes: Array<{
      id: string;
      debugLabel?: string;
      page: number;
      kind: 'container' | 'text' | 'image' | 'table' | 'chart' | 'other';
      x: number;
      y: number;
      width: number;
      height: number;
      textLength?: number;
      fontSizePx?: number;
      scrollWidth?: number;
      clientWidth?: number;
      scrollHeight?: number;
      clientHeight?: number;
      overflowX?: string;
      overflowY?: string;
    }> = [{
      id: `slide-${input.pageNumber}`,
      page: input.pageNumber,
      kind: 'container',
      x: 0,
      y: 0,
      width: slideWidth,
      height: slideHeight
    }];

    const contentRoot = content?.firstElementChild;
    if (contentRoot instanceof HTMLElement) {
      const rect = contentRoot.getBoundingClientRect();
      const style = getComputedStyle(contentRoot);
      boxes.push({
        id: `slide-${input.pageNumber}-content-root`,
        page: input.pageNumber,
        kind: 'container',
        x: rect.x * scaleX,
        y: rect.y * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY,
        scrollWidth: contentRoot.scrollWidth,
        clientWidth: contentRoot.clientWidth,
        scrollHeight: contentRoot.scrollHeight,
        clientHeight: contentRoot.clientHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY
      });
    }

    const elements = Array.from(document.querySelectorAll<HTMLElement>(
      '#slide-content *, .evident-citations, .evident-page, .evident-logo'
    )).filter((element) => {
      if (element.closest('svg') && element.tagName.toLowerCase() !== 'svg') return false;
      if (element.closest('table') && element.tagName.toLowerCase() !== 'table') return false;
      if (element.tagName.toLowerCase() === 'svg' || element.tagName.toLowerCase() === 'table') return true;
      return element.childElementCount === 0 && Boolean(element.textContent?.trim());
    }).slice(0, 120);

    elements.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return;
      const tag = element.tagName.toLowerCase();
      const kind = tag === 'img'
        ? 'image'
        : tag === 'table'
          ? 'table'
          : tag === 'svg'
            ? 'chart'
            : 'text';
      const area = element.closest('#slide-content') ? 'content' : 'frame';
      const classNames = typeof element.className === 'string'
        ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 4)
        : [];
      const selector = `${tag}${element.id ? `#${element.id}` : ''}${classNames.map((className) => `.${className}`).join('')}`;
      const text = element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80);
      boxes.push({
        id: `slide-${input.pageNumber}-${area}-${index + 1}`,
        debugLabel: text ? `${selector} “${text}”` : selector,
        page: input.pageNumber,
        kind,
        x: rect.x * scaleX,
        y: rect.y * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY,
        ...(element.textContent?.trim() ? {
          textLength: element.textContent.trim().length,
          fontSizePx: Number.parseFloat(style.fontSize)
        } : {}),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY
      });
    });

    return {
      page: input.pageNumber,
      width: slideWidth,
      height: slideHeight,
      boxes,
      scrollWidth: Math.max(stage?.scrollWidth ?? 0, content?.scrollWidth ?? 0),
      clientWidth: input.viewportWidth,
      scrollHeight: Math.max(stage?.scrollHeight ?? 0, content?.scrollHeight ?? 0),
      clientHeight: input.viewportHeight
    };
  }, { pageNumber, viewportWidth: pptxViewport.width, viewportHeight: pptxViewport.height });
}

async function createPptxContactSheet(page: any, screenshots: Buffer[]) {
  const columns = 3;
  const rows = Math.max(1, Math.ceil(screenshots.length / columns));
  await page.setViewportSize({ width: 1_200, height: rows * 232 + 36 });
  const images = screenshots.map((screenshot, index) =>
    `<figure><img src="data:image/png;base64,${screenshot.toString('base64')}" alt="第 ${index + 1} 页" /><figcaption>${index + 1}</figcaption></figure>`
  ).join('');
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; background: #dfe3e6; }
    body { display: grid; grid-template-columns: repeat(${columns}, 1fr); gap: 18px; padding: 18px; font-family: Arial, sans-serif; }
    figure { position: relative; margin: 0; overflow: hidden; border-radius: 4px; background: white; box-shadow: 0 2px 8px rgba(20, 30, 35, .18); }
    img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }
    figcaption { position: absolute; right: 8px; bottom: 7px; min-width: 24px; padding: 3px 6px; border-radius: 3px; background: rgba(0, 0, 0, .66); color: white; font-size: 12px; text-align: center; }
  </style></head><body>${images}</body></html>`, { waitUntil: 'domcontentloaded' });
  return Buffer.from(await page.screenshot({ type: 'png', fullPage: true }));
}

function textBox(
  id: string,
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize: number
): ArtifactLayoutBox {
  return {
    id,
    page,
    kind: 'text',
    x,
    y,
    width,
    height,
    textLength: text.length,
    // Store the estimate in the same physical-ish unit as renderer boxes
    // (inches for PPTX, a conservative fraction for the PDF CSS boxes).
    estimatedTextHeight: Math.max(fontSize * 1.2 / 72, Math.ceil(text.length / Math.max(1, Math.floor(width * 8))) * fontSize * 1.2 / 72)
  };
}

function createPdfLayoutManifest(spec: ArtifactSpec, metrics: PdfDomMetrics | undefined, assets: ArtifactRenderAsset[]): ArtifactLayoutManifest {
  const width = 794;
  const height = 1123;
  const pages = Array.from({ length: spec.pdf.sections.length + 2 }, (_, index) => {
    const page = index + 1;
    const boxes: ArtifactLayoutBox[] = [{ id: `page-${page}`, page, kind: 'container', x: 0, y: 0, width, height }];
    if (page === 1) {
      boxes.push(
        { id: 'page-1-header', page, kind: 'container', x: 0, y: 0, width, height: 260 },
        textBox('page-1-title', page, spec.title, 45, 60, 704, 80, 36),
        textBox('page-1-summary', page, spec.brief.executiveSummary, 45, 155, 704, 90, 15)
      );
      const logo = findBrandAsset(spec, assets);
      if (logo) boxes.push({ id: 'page-1-logo', page, kind: 'image', x: 650, y: 20, width: 120, height: 56 });
      const gallery = assets.filter((asset) => asset.id !== logo?.id).slice(0, 3);
      gallery.forEach((_asset, index) => boxes.push({ id: `page-1-asset-${index + 1}`, page, kind: 'image', x: 45 + index * 165, y: 270, width: 145, height: 120 }));
    } else if (page <= spec.pdf.sections.length + 1) {
      const section = spec.pdf.sections[page - 2]!;
      boxes.push(
        { id: `page-${page}-section`, page, kind: 'container', x: 45, y: 45, width: 704, height: 1_020 },
        textBox(`page-${page}-title`, page, section.title, 45, 72, 704, 70, 23),
        textBox(`page-${page}-body`, page, [...section.paragraphs, ...section.bullets].join('\n'), 45, 160, 704, 760, 15)
      );
    } else {
      boxes.push(
        { id: `page-${page}-references`, page, kind: 'container', x: 45, y: 45, width: 704, height: 1_020 },
        textBox(`page-${page}-references-text`, page, spec.brief.citations.map((citation) => citation.title).join('\n'), 45, 72, 704, 900, 12)
      );
    }
    const dom = metrics?.sections[page - 1];
    if (dom) {
      const measuredBoxes = boxes.map((box, boxIndex) => boxIndex === 1
        ? { ...box, scrollWidth: dom.scrollWidth, clientWidth: dom.clientWidth, scrollHeight: dom.scrollHeight, clientHeight: dom.clientHeight }
        : box);
      return {
        page,
        width,
        height,
        boxes: measuredBoxes,
      };
    }
    return { page, width, height, boxes };
  });
  return {
    pageCount: pages.length,
    pages,
    limitations: [
      'PDF DOM metrics are captured before printing; CSS page-break placement is checked heuristically against raster/text QA.',
      ...(metrics ? [] : ['PDF DOM scroll/client metrics were unavailable; only deterministic planned bounds were inspected.'])
    ]
  };
}

function createReportHtml(spec: ArtifactSpec, snapshot: ResearchSnapshot, assets: ArtifactRenderAsset[] = []) {
  const colors = themeColors(spec);
  const pageSettings = spec.longform?.pageSettings;
  const portraitHeight = pageSettings?.size === 'Letter' ? 279.4 : 297;
  const physicalHeight = pageSettings?.orientation === 'landscape'
    ? (pageSettings?.size === 'Letter' ? 215.9 : 210)
    : portraitHeight;
  const contentMinHeight = Math.max(
    80,
    physicalHeight - (pageSettings?.marginTop ?? 16) - (pageSettings?.marginBottom ?? 18) - 8
  );
  const pageSize = pageSettings
    ? `${pageSettings.size} ${pageSettings.orientation}`
    : 'A4 portrait';
  const sourceByKey = new Map(snapshot.sources.map((source) => [source.citationKey, source]));
  const logo = findBrandAsset(spec, assets);
  const gallery = assets.filter((asset) => asset.id !== logo?.id).slice(0, 3);
  const sections = spec.pdf.sections.map((section) => `
    <section class="report-section">
      <h2>${escapeHtml(section.title)}</h2>
      ${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}
      ${section.bullets.length ? `<ul>${section.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>` : ''}
      ${renderCitations(section.citations, sourceByKey)}
    </section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    @page { size: ${pageSize}; }
    * { box-sizing: border-box; }
    body { margin: 0; color: ${colors.text}; font-family: ${cssFont(spec.branding.bodyFont ?? 'Arial')}; font-size: 11pt; line-height: 1.65; }
    header { border-top: 8px solid ${colors.primary}; padding: 42px 0 24px; margin-bottom: 24px; }
    h1 { color: ${colors.primary}; font-family: ${cssFont(spec.branding.titleFont ?? 'Arial')}; font-size: 27pt; line-height: 1.2; margin: 0 0 12px; }
    .audience { color: ${colors.muted}; margin: 0 0 20px; }
    .summary { background: ${colors.panel}; border-left: 4px solid ${colors.primary}; padding: 16px 18px; }
    h2 { color: ${colors.primary}; font-size: 17pt; border-bottom: 1px solid ${colors.rule}; padding-bottom: 5px; margin: 28px 0 10px; page-break-after: avoid; }
    p { margin: 8px 0; orphans: 3; widows: 3; }
    li { margin: 4px 0; }
    .report-section { page-break-before: always; page-break-inside: avoid; page-break-after: always; min-height: ${contentMinHeight}mm; }
    .citation { color: ${colors.muted}; font-size: 8.5pt; margin-top: 8px; }
    .references { page-break-before: always; page-break-after: always; min-height: ${contentMinHeight}mm; }
    .forced-page { page-break-before: always; page-break-after: always; min-height: ${contentMinHeight}mm; }
    .references li { font-size: 9pt; }
    .brand-logo { max-width: 120px; max-height: 56px; object-fit: contain; float: right; }
    .asset-gallery { display: flex; gap: 12px; margin: 12px 0; }
    .asset-gallery img { max-width: 30%; max-height: 120px; object-fit: contain; }
  </style></head><body>
    <header>${logo ? `<img class="brand-logo" src="${toDataUri(logo)}" alt="品牌标识" />` : ''}<h1>${escapeHtml(spec.title)}</h1><p class="audience">面向：${escapeHtml(spec.audience)}</p><div class="summary">${escapeHtml(spec.brief.executiveSummary)}</div></header>
    ${gallery.length ? `<div class="asset-gallery">${gallery.map((asset) => `<img src="${toDataUri(asset)}" alt="研究素材" />`).join('')}</div>` : ''}
    ${sections}
    <section class="references"><h2>参考来源</h2><ol>${spec.brief.citations.map((citation) => `<li id="${escapeHtml(citation.citationKey)}"><strong>${escapeHtml(citation.citationKey)}</strong> ${escapeHtml(citation.title)}${citation.locator ? ` · ${escapeHtml(citation.locator)}` : ''}</li>`).join('')}</ol></section>
  </body></html>`;
}

function normalizePresentationSlides(slides: ArtifactSpec['presentation']['slides'], title: string) {
  const normalized = slides.filter((slide) => slide.kind !== 'title');
  const titleSlide = slides.find((slide) => slide.kind === 'title') ?? {
    id: 'title',
    title,
    kind: 'title' as const,
    bullets: [],
    citations: []
  };
  return [titleSlide, ...normalized];
}

function findBrandAsset(spec: ArtifactSpec, assets: ArtifactRenderAsset[] | undefined) {
  if (!spec.branding.logoUrl || !assets?.length) return undefined;
  return assets.find((asset) => asset.imageUrl === spec.branding.logoUrl || asset.originalPageUrl === spec.branding.logoUrl);
}

function toDataUri(asset: ArtifactRenderAsset) {
  return `data:${asset.mimeType};base64,${asset.data.toString('base64')}`;
}

function validateArtifactCitationsAgainstSnapshot(spec: ArtifactSpec, snapshot: ResearchSnapshot) {
  const sourceByKey = new Map(snapshot.sources.map((source) => [source.citationKey, source]));
  const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
  const diagnostics: string[] = [];
  for (const citation of spec.brief.citations) {
    const source = sourceByKey.get(citation.citationKey);
    if (!source) diagnostics.push(`Citation ${citation.citationKey} is not present in the frozen snapshot`);
    else if (source.id !== citation.sourceId) diagnostics.push(`Citation ${citation.citationKey} points to a different source id`);
  }
  const allKeys = [
    ...spec.brief.sections.flatMap((section) => section.citations),
    ...spec.presentation.slides.flatMap((slide) => slide.citations),
    ...spec.pdf.sections.flatMap((section) => section.citations)
  ];
  for (const key of allKeys) if (!sourceByKey.has(key)) diagnostics.push(`Citation ${key} is not present in the frozen snapshot`);
  for (const citation of spec.brief.citations) if (!sourceById.has(citation.sourceId)) diagnostics.push(`Citation source ${citation.sourceId} is not present in the frozen snapshot`);
  return [...new Set(diagnostics)];
}

function renderCitations(keys: string[], sourceByKey: Map<string, { title: string; file: string }>) {
  if (!keys.length) return '';
  const content = keys.map((key) => {
    const source = sourceByKey.get(key);
    return source ? `${key} ${source.title}` : key;
  }).join('；');
  return `<p class="citation">来源：${escapeHtml(content)}</p>`;
}

function themeColors(spec: ArtifactSpec) {
  const primary = normalizeHex(spec.branding.primaryColor) ?? ({
    research: '1F4E78',
    technical: '185C66',
    business: '315C4C'
  }[spec.theme]);
  return {
    primary,
    background: 'FFFFFF',
    panel: 'EEF4F8',
    text: '1F2937',
    muted: '64748B',
    rule: 'CBD5E1'
  };
}

function normalizeHex(value: string | undefined) {
  if (!value) return undefined;
  return value.replace(/^#/, '').toUpperCase();
}

function safeFileStem(value: string) {
  const normalized = value.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim().slice(0, 120);
  return normalized || 'research-artifact';
}

function cssFont(value: string) {
  const safe = value.replace(/[^A-Za-z0-9 ,._-]/g, '').trim() || 'Arial';
  return `'${safe}', Arial, sans-serif`;
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

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Artifact generation cancelled');
}

async function importOptional(name: 'pptxgenjs' | 'playwright' | 'adm-zip'): Promise<any | undefined> {
  try {
    // Keep renderers optional so the backend can start and report a structured
    // preflight diagnostic on machines without Chromium tooling.
    const load = Function('moduleName', 'return import(moduleName)') as (moduleName: string) => Promise<any>;
    return await load(name);
  } catch {
    return undefined;
  }
}
