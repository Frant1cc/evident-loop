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

export { RendererUnavailableError } from './errors.js';

export class DefaultPptxRenderer implements ArtifactRenderer {
  async render(spec: ArtifactSpec, _snapshot: ResearchSnapshot, context?: RendererContext): Promise<RendererResult> {
    throwIfAborted(context?.signal);
    const imported = await importOptional('pptxgenjs');
    if (!imported) {
      throw new RendererUnavailableError(
        'PPTX renderer unavailable: install pptxgenjs and ensure the backend can load it'
      );
    }
    const PptxGenJS = imported.default ?? imported;
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

    const colors = themeColors(spec);
    const plannedSlides = normalizePresentationSlides(spec.presentation.slides, spec.title);
    const titleSlide = pptx.addSlide();
    titleSlide.background = { color: colors.background };
    titleSlide.addShape(pptx.ShapeType?.rect ?? 'rect', {
      x: 0,
      y: 0,
      w: 13.333,
      h: 0.22,
      fill: { color: colors.primary },
      line: { color: colors.primary }
    });
    titleSlide.addText(spec.title, {
      x: 0.75,
      y: 2.2,
      w: 11.8,
      h: 0.75,
      fontFace: spec.branding.titleFont ?? 'Aptos Display',
      fontSize: 29,
      bold: true,
      color: colors.primary,
      margin: 0,
      breakLine: false,
      fit: 'shrink'
    });
    titleSlide.addText(spec.audience, {
      x: 0.8,
      y: 3.15,
      w: 11.5,
      h: 0.38,
      fontSize: 15,
      color: colors.muted,
      margin: 0,
      fit: 'shrink'
    });
    titleSlide.addText(spec.brief.executiveSummary, {
      x: 0.8,
      y: 4.1,
      w: 11.3,
      h: 1.2,
      fontSize: 16,
      color: colors.text,
      margin: 0.04,
      breakLine: false,
      fit: 'shrink'
    });
    const logo = findBrandAsset(spec, context?.assets);
    if (logo) {
      titleSlide.addImage({ data: toDataUri(logo), x: 11.45, y: 0.42, w: 1.1, h: 0.55 });
    }
    context?.onProgress?.('PPTX title slide rendered');

    const ordinaryAsset = findOrdinaryAsset(spec, context?.assets);
    for (const slidePlan of plannedSlides.slice(1)) {
      throwIfAborted(context?.signal);
      const slide = pptx.addSlide();
      slide.background = { color: colors.background };
      slide.addText(slidePlan.title, {
        x: 0.65,
        y: 0.42,
        w: logo ? 10.5 : 12,
        h: 0.48,
        fontSize: 24,
        bold: true,
        color: colors.primary,
        margin: 0,
        fit: 'shrink'
      });
      slide.addShape(pptx.ShapeType?.line ?? 'line', {
        x: 0.65,
        y: 1.08,
        w: 12,
        h: 0,
        line: { color: colors.rule, width: 1 }
      });
      if (logo) slide.addImage({ data: toDataUri(logo), x: 11.45, y: 0.38, w: 1.1, h: 0.55 });
      const bullets = slidePlan.bullets;
      const hasVisual = Boolean(slidePlan.visual);
      if (bullets.length) {
        slide.addText(bullets.map((text: string) => ({ text, options: { bullet: { indent: 18 } } })), {
          x: 0.95,
          y: 1.45,
          w: hasVisual ? 6.1 : 11.2,
          h: ordinaryAsset && !hasVisual ? 4.1 : 4.55,
          fontSize: 20,
          breakLine: true,
          color: colors.text,
          margin: 0.06,
          paraSpaceAfterPt: 14,
          fit: 'shrink',
          valign: 'mid'
        });
      }
      if (slidePlan.visual?.type === 'table') {
        slide.addTable([slidePlan.visual.headers, ...slidePlan.visual.rows], {
          x: 7.25,
          y: 1.65,
          w: 5.25,
          h: 3.9,
          fontSize: 10,
          border: { type: 'solid', color: colors.rule, pt: 1 },
          fill: colors.panel,
          color: colors.text,
          margin: 0.06,
          fit: 'shrink'
        });
      } else if (slidePlan.visual?.type === 'bar') {
        const chartType = pptx.ChartType?.bar ?? 'bar';
        slide.addChart?.(chartType, [{ name: '值', labels: slidePlan.visual.labels, values: slidePlan.visual.values }], {
          x: 7.25,
          y: 1.65,
          w: 5.25,
          h: 3.9,
          showLegend: false,
          showTitle: false,
          catAxisLabelFontFace: spec.branding.bodyFont ?? 'Aptos',
          valAxisLabelFontFace: spec.branding.bodyFont ?? 'Aptos',
          chartColors: [colors.primary]
        });
      }
      if (slidePlan.citations.length) {
        slide.addText(`来源：${slidePlan.citations.join('、')}`, {
          x: 0.75,
          y: 6.75,
          w: 11.8,
          h: 0.25,
          fontSize: 8,
          color: colors.muted,
          margin: 0,
          fit: 'shrink'
        });
      }
      if (ordinaryAsset) {
        slide.addImage({
          data: toDataUri(ordinaryAsset),
          x: hasVisual ? 7.25 : 10.8,
          y: 5.72,
          w: hasVisual ? 1.35 : 1.7,
          h: 0.72
        });
      }
      if (slidePlan.speakerNotes) {
        slide.addNotes?.(slidePlan.speakerNotes);
      }
      context?.onProgress?.(`PPTX slide rendered: ${slidePlan.title}`);
    }

    const buffer = await pptx.write({ outputType: 'nodebuffer' });
    return {
      buffer: Buffer.from(buffer),
      fileName: `${safeFileStem(spec.title)}.pptx`,
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      provenance: context?.visualProvenance,
      renderedSpec: spec,
      layoutManifest: createPptxLayoutManifest(spec, plannedSlides, Boolean(logo), Boolean(ordinaryAsset))
    };
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
      const buffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: '<div style="font-size:8px;color:#64748b;width:100%;text-align:center"><span class="pageNumber"></span></div>',
        margin: { top: '16mm', right: '16mm', bottom: '18mm', left: '16mm' }
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
    const visible = page.boxes.filter((box) => box.kind !== 'container');
    for (const box of visible) {
      if (box.x < 0 || box.y < 0 || box.x + box.width > page.width + 0.01 || box.y + box.height > page.height + 0.01) {
        diagnostics.push(`Layout box ${box.id} exceeds page ${page.page} bounds`);
      }
      if (box.scrollWidth !== undefined && box.clientWidth !== undefined && box.scrollWidth > box.clientWidth + 1) {
        diagnostics.push(`Layout box ${box.id} reports horizontal clipping (${box.scrollWidth} > ${box.clientWidth})`);
      }
      if (box.scrollHeight !== undefined && box.clientHeight !== undefined && box.scrollHeight > box.clientHeight + 1) {
        diagnostics.push(`Layout box ${box.id} reports vertical clipping (${box.scrollHeight} > ${box.clientHeight})`);
      }
      if (box.estimatedTextHeight !== undefined && box.estimatedTextHeight > box.height * 1.05) {
        diagnostics.push(`Layout box ${box.id} has estimated text height ${Math.round(box.estimatedTextHeight)} above its ${Math.round(box.height)} box; clipping check is heuristic`);
      }
    }
    for (let left = 0; left < visible.length; left += 1) {
      for (let right = left + 1; right < visible.length; right += 1) {
        const overlap = overlapRatio(visible[left]!, visible[right]!);
        if (overlap >= 0.8) {
          diagnostics.push(`Layout boxes ${visible[left]!.id} and ${visible[right]!.id} have high overlap (${Math.round(overlap * 100)}%); visual collision detection is heuristic`);
        }
      }
    }
  }
  return diagnostics;
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
    const blocks: DocumentBlock[] = [
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
    const presetByTheme: Record<ArtifactSpec['theme'], DocumentPresetName> = {
      research: 'research-report',
      technical: 'technical-report',
      business: 'business-report'
    };
    const resolved = resolveDocumentSpec({
      fileName: `${safeFileStem(spec.title)}.docx`,
      title: spec.title,
      subtitle: spec.audience,
      author: 'EvidentLoop',
      blocks,
      format: {
        preset: presetByTheme[spec.theme],
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

function createPptxLayoutManifest(
  spec: ArtifactSpec,
  slides: ArtifactSpec['presentation']['slides'],
  hasLogo: boolean,
  hasOrdinaryAsset: boolean
): ArtifactLayoutManifest {
  const pages = slides.map((slide, index) => {
    const page = index + 1;
    const boxes: ArtifactLayoutBox[] = [
      { id: `slide-${page}`, page, kind: 'container', x: 0, y: 0, width: 13.333, height: 7.5 }
    ];
    if (index === 0) {
      boxes.push(
        { id: `slide-${page}-top-rule`, page, kind: 'other', x: 0, y: 0, width: 13.333, height: 0.22 },
        textBox(`slide-${page}-title`, page, spec.title, 0.75, 2.2, 11.8, 0.75, 29),
        textBox(`slide-${page}-audience`, page, spec.audience, 0.8, 3.15, 11.5, 0.38, 15),
        textBox(`slide-${page}-summary`, page, spec.brief.executiveSummary, 0.8, 4.1, 11.3, 1.2, 16)
      );
      if (hasLogo) boxes.push({ id: `slide-${page}-logo`, page, kind: 'image', x: 11.45, y: 0.42, width: 1.1, height: 0.55 });
    } else {
      boxes.push(
        textBox(`slide-${page}-title`, page, slide.title, 0.65, 0.42, hasLogo ? 10.5 : 12, 0.48, 24),
        { id: `slide-${page}-rule`, page, kind: 'other', x: 0.65, y: 1.08, width: 12, height: 0.02 }
      );
      if (slide.bullets.length) {
        boxes.push(textBox(`slide-${page}-bullets`, page, slide.bullets.join('\n'), 0.95, 1.45, slide.visual ? 6.1 : 11.2, hasOrdinaryAsset && !slide.visual ? 4.1 : 4.55, 20));
      }
      if (slide.visual?.type === 'table') {
        boxes.push({ id: `slide-${page}-table`, page, kind: 'table', x: 7.25, y: 1.65, width: 5.25, height: 3.9 });
      } else if (slide.visual?.type === 'bar') {
        boxes.push({ id: `slide-${page}-chart`, page, kind: 'chart', x: 7.25, y: 1.65, width: 5.25, height: 3.9 });
      }
      if (slide.citations.length) boxes.push(textBox(`slide-${page}-citations`, page, slide.citations.join('、'), 0.75, 6.75, 11.8, 0.25, 8));
      if (hasLogo) boxes.push({ id: `slide-${page}-logo`, page, kind: 'image', x: 11.45, y: 0.38, width: 1.1, height: 0.55 });
      if (hasOrdinaryAsset) boxes.push({ id: `slide-${page}-asset`, page, kind: 'image', x: slide.visual ? 7.25 : 10.8, y: 5.72, width: slide.visual ? 1.35 : 1.7, height: 0.72 });
    }
    return { page, width: 13.333, height: 7.5, boxes };
  });
  return {
    pageCount: pages.length,
    pages,
    limitations: ['PPTX text height and overlap checks are deterministic estimates; pixel-perfect collision detection is not claimed.']
  };
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
    @page { size: A4; }
    * { box-sizing: border-box; }
    body { margin: 0; color: ${colors.text}; font-family: ${cssFont(spec.branding.bodyFont ?? 'Arial')}; font-size: 11pt; line-height: 1.65; }
    header { border-top: 8px solid ${colors.primary}; padding: 42px 0 24px; margin-bottom: 24px; }
    h1 { color: ${colors.primary}; font-family: ${cssFont(spec.branding.titleFont ?? 'Arial')}; font-size: 27pt; line-height: 1.2; margin: 0 0 12px; }
    .audience { color: ${colors.muted}; margin: 0 0 20px; }
    .summary { background: ${colors.panel}; border-left: 4px solid ${colors.primary}; padding: 16px 18px; }
    h2 { color: ${colors.primary}; font-size: 17pt; border-bottom: 1px solid ${colors.rule}; padding-bottom: 5px; margin: 28px 0 10px; page-break-after: avoid; }
    p { margin: 8px 0; orphans: 3; widows: 3; }
    li { margin: 4px 0; }
    .report-section { page-break-before: always; page-break-inside: avoid; page-break-after: always; min-height: 235mm; }
    .citation { color: ${colors.muted}; font-size: 8.5pt; margin-top: 8px; }
    .references { page-break-before: always; page-break-after: always; min-height: 235mm; }
    .forced-page { page-break-before: always; page-break-after: always; min-height: 235mm; }
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

function findOrdinaryAsset(spec: ArtifactSpec, assets: ArtifactRenderAsset[] | undefined) {
  const logo = findBrandAsset(spec, assets);
  return assets?.find((asset) => asset.id !== logo?.id);
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
