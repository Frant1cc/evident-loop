import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getDocument, GlobalWorkerOptions, InvalidPDFException } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { createBlock } from '../blockFactory.js';
import { getKnowledgeMaxExtractedBytes, getKnowledgeMaxPdfPages } from '../config.js';
import {
  emptyDocumentError,
  encryptedPdfError,
  extractedContentTooLargeError,
  KnowledgeImportError,
  scannedPdfError
} from '../errors.js';
import type { KnowledgeBlock, KnowledgeParser, ParsedKnowledgeDocument } from '../types.js';

const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

const scannedTextThreshold = 8;
const headerFooterMinPages = 3;

type PdfLine = {
  text: string;
  y: number;
  xStart: number;
  xEnd: number;
  page: number;
};

type PdfParagraph = {
  text: string;
  pageStart: number;
  pageEnd: number;
};

export const pdfParser: KnowledgeParser = {
  name: 'pdfjs',
  version: '1',
  formats: ['pdf'],

  canParse(input) {
    return extname(input.originalName).toLowerCase() === '.pdf' || input.mimeType === 'application/pdf';
  },

  async parse(input) {
    if (!input.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new KnowledgeImportError('支持上传 Markdown、TXT、DOCX 和文本型 PDF。', 415);
    }
    if (isEncryptedPdf(input.buffer)) throw encryptedPdfError();

    let document;
    try {
      document = await getDocument({
        data: new Uint8Array(input.buffer),
        disableFontFace: true,
        isEvalSupported: false,
        useSystemFonts: true,
        verbosity: 0,
        standardFontDataUrl: pathToFileURL(require.resolve('pdfjs-dist/package.json')).href.replace(/package\.json$/u, 'standard_fonts/')
      }).promise;
    } catch (error) {
      if (isPasswordError(error)) throw encryptedPdfError();
      if (error instanceof InvalidPDFException) {
        throw new KnowledgeImportError('无法读取 PDF 文件，请确认文件未损坏。', 422);
      }
      throw new KnowledgeImportError('无法读取 PDF 文件，请确认文件未损坏。', 422);
    }

    try {
      if (document.numPages > getKnowledgeMaxPdfPages()) {
        throw new KnowledgeImportError(`PDF 页数不能超过 ${getKnowledgeMaxPdfPages()} 页。`, 413);
      }

      const pageLines: PdfLine[][] = [];
      let columnWarning = false;

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const items = content.items.flatMap((item) => {
          if (!('str' in item) || !item.str) return [];
          const transform = item.transform as number[];
          return [{
            text: item.str,
            x: transform[4] ?? 0,
            y: transform[5] ?? 0,
            width: item.width ?? 0,
            hasEOL: Boolean(item.hasEOL)
          }];
        });
        if (looksLikeTwoColumn(items)) columnWarning = true;
        pageLines.push(mergeLineItems(items, pageNumber));
      }

      const withoutChrome = stripRepeatedChrome(pageLines);
      const paragraphs = paragraphsFromLines(withoutChrome);
      const joined = paragraphs.map((paragraph) => paragraph.text).join('\n');
      const stripped = joined.replace(/\s+/gu, '');
      if (!stripped.length || (document.numPages >= 3 && stripped.length < document.numPages * scannedTextThreshold)) {
        throw scannedPdfError();
      }
      if (stripped.length < scannedTextThreshold) throw scannedPdfError();

      const title = firstTitle(paragraphs) || input.originalName.replace(/\.pdf$/i, '') || '未命名文档';
      const warnings = columnWarning
        ? ['该 PDF 可能包含多栏或复杂布局，阅读顺序可能存在误差。']
        : [];

      return buildPdfDocument(title, paragraphs, document.numPages, warnings);
    } finally {
      await document.destroy();
    }
  }
};

function buildPdfDocument(
  title: string,
  paragraphs: PdfParagraph[],
  pageCount: number,
  warnings: string[]
): ParsedKnowledgeDocument {
  const markdownLines = [`# ${title}`, ''];
  const blocks: KnowledgeBlock[] = [
    createBlock({
      order: 0,
      type: 'heading',
      text: title,
      headingPath: [],
      locator: { normalizedLineStart: 1, normalizedLineEnd: 1, pageStart: 1, pageEnd: 1 }
    })
  ];

  let currentPage = 0;
  let order = 1;

  for (const paragraph of paragraphs) {
    if (paragraph.pageStart !== currentPage) {
      currentPage = paragraph.pageStart;
      markdownLines.push(`## 第 ${currentPage} 页`, '');
    }
    const startLine = markdownLines.length + 1;
    markdownLines.push(paragraph.text, '');
    const endLine = startLine + paragraph.text.split('\n').length - 1;
    blocks.push(createBlock({
      order,
      type: 'paragraph',
      text: paragraph.text,
      headingPath: [],
      locator: {
        normalizedLineStart: startLine,
        normalizedLineEnd: endLine,
        pageStart: paragraph.pageStart,
        pageEnd: paragraph.pageEnd
      }
    }));
    order += 1;
  }

  const content = markdownLines.join('\n').trim() + '\n';
  const characterCount = Buffer.byteLength(content, 'utf8');
  if (characterCount > getKnowledgeMaxExtractedBytes()) throw extractedContentTooLargeError();
  if (!paragraphs.length) throw emptyDocumentError();

  return {
    title,
    format: 'pdf',
    content,
    blocks,
    parserName: pdfParser.name,
    parserVersion: pdfParser.version,
    warnings,
    metadata: { pageCount, characterCount }
  };
}

function mergeLineItems(
  items: Array<{ text: string; x: number; y: number; width: number; hasEOL: boolean }>,
  page: number
): PdfLine[] {
  const sorted = [...items].sort((left, right) => right.y - left.y || left.x - right.x);
  const lines: Array<{ items: typeof items; y: number }> = [];
  const yTolerance = 3;

  for (const item of sorted) {
    const current = lines[lines.length - 1];
    if (current && Math.abs(current.y - item.y) <= yTolerance) {
      current.items.push(item);
    } else {
      lines.push({ items: [item], y: item.y });
    }
  }

  return lines.map((line) => {
    const ordered = line.items.sort((left, right) => left.x - right.x);
    let text = '';
    let previousEnd = 0;
    for (const item of ordered) {
      if (text && item.x - previousEnd > 1.5) text += ' ';
      text += item.text;
      previousEnd = item.x + item.width;
    }
    return {
      text: text.replace(/\s+/gu, ' ').trim(),
      y: line.y,
      xStart: ordered[0]?.x ?? 0,
      xEnd: previousEnd,
      page
    };
  }).filter((line) => line.text);
}

function looksLikeTwoColumn(items: Array<{ x: number }>) {
  if (items.length < 20) return false;
  const xs = items.map((item) => item.x).sort((left, right) => left - right);
  const gaps = xs.slice(1).map((value, index) => value - xs[index]!);
  const maxGap = Math.max(...gaps, 0);
  const span = (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0);
  return span > 200 && maxGap > span * 0.25;
}

function stripRepeatedChrome(pages: PdfLine[][]) {
  if (pages.length < headerFooterMinPages) return pages;
  const candidates = new Map<string, number>();

  for (const lines of pages) {
    const ends = [lines[0]?.text, lines[lines.length - 1]?.text].filter(Boolean) as string[];
    for (const text of ends) {
      if (text.length <= 40) candidates.set(text, (candidates.get(text) ?? 0) + 1);
    }
  }

  const chrome = new Set(
    [...candidates.entries()]
      .filter(([, count]) => count >= Math.ceil(pages.length * 0.6))
      .map(([text]) => text)
  );

  return pages.map((lines) => lines.filter((line) => !chrome.has(line.text)));
}

function paragraphsFromLines(pages: PdfLine[][]): PdfParagraph[] {
  const all = pages.flat();
  const repaired = joinHyphenated(all);
  const paragraphs: PdfParagraph[] = [];
  let current: PdfParagraph | undefined;

  const flush = () => {
    if (current?.text.trim()) paragraphs.push({ ...current, text: current.text.trim() });
    current = undefined;
  };

  for (const line of repaired) {
    if (!line.text) continue;
    if (!current) {
      current = { text: line.text, pageStart: line.page, pageEnd: line.page };
      continue;
    }

    const shouldBreak = /[。！？.!?]$/u.test(current.text) || looksLikeHeading(line.text);
    if (shouldBreak) {
      flush();
      current = { text: line.text, pageStart: line.page, pageEnd: line.page };
      continue;
    }

    current.text = `${current.text} ${line.text}`;
    current.pageEnd = line.page;
  }
  flush();
  return paragraphs;
}

function joinHyphenated(lines: PdfLine[]) {
  const result: PdfLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]!;
    const next = lines[index + 1];
    if (next && /[A-Za-z\u4e00-\u9fff]-$/u.test(current.text) && /^[a-z\u4e00-\u9fff]/u.test(next.text)) {
      result.push({
        ...current,
        text: current.text.replace(/-$/u, '') + next.text,
        page: current.page
      });
      index += 1;
      continue;
    }
    result.push(current);
  }
  return result;
}

function looksLikeHeading(text: string) {
  return text.length <= 40 && !/[。！？.!?]$/u.test(text) && /^\S/u.test(text);
}

function firstTitle(paragraphs: PdfParagraph[]) {
  const first = paragraphs[0]?.text.trim();
  if (first && first.length <= 80 && !/[。！？.!?]$/u.test(first)) return first;
  return undefined;
}

function isEncryptedPdf(buffer: Buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 64_000)).toString('latin1');
  const tail = buffer.subarray(Math.max(0, buffer.length - 64_000)).toString('latin1');
  return /\/Encrypt[\s\/\[]/.test(head) || /\/Encrypt[\s\/\[]/.test(tail);
}

function isPasswordError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name: string }).name === 'PasswordException');
}
