import { extname } from 'node:path';

import * as cheerio from 'cheerio';
import mammoth from 'mammoth';

import { createBlock } from '../blockFactory.js';
import { getKnowledgeMaxExtractedBytes } from '../config.js';
import {
  corruptDocxError,
  emptyDocumentError,
  extractedContentTooLargeError
} from '../errors.js';
import type { KnowledgeBlock, KnowledgeParser, ParsedKnowledgeDocument, SourceLocator } from '../types.js';

export const docxParser: KnowledgeParser = {
  name: 'mammoth-cheerio',
  version: '1',
  formats: ['docx'],

  canParse(input) {
    return extname(input.originalName).toLowerCase() === '.docx'
      || input.mimeType.includes('wordprocessingml');
  },

  async parse(input) {
    let html: string;
    let messages: Array<{ type: string; message: string }>;
    try {
      const result = await mammoth.convertToHtml(
        { buffer: input.buffer },
        {
          styleMap: [
            "p[style-name='Title'] => h1:fresh",
            "p[style-name='Subtitle'] => h2:fresh"
          ]
        }
      );
      html = result.value;
      messages = result.messages;
    } catch {
      throw corruptDocxError();
    }

    const warnings = messages
      .filter((message) => message.type === 'warning' || /image/i.test(message.message))
      .map((message) => message.message);
    return htmlToDocument(html, input.originalName, warnings);
  }
};

function htmlToDocument(html: string, originalName: string, extraWarnings: string[]): ParsedKnowledgeDocument {
  const $ = cheerio.load(html);
  if ($('img').length) extraWarnings.push('已忽略 Word 文档中的嵌入图片。');

  const blocks: KnowledgeBlock[] = [];
  const headingStack: string[] = [];
  const headingLevels: number[] = [];
  let title = '';
  let order = 0;
  let line = 1;
  let sawImplicitTableHeader = false;

  const currentPath = () => headingStack.slice();

  const push = (block: Omit<KnowledgeBlock, 'id' | 'order' | 'locator'> & { locator?: SourceLocator }) => {
    const text = block.text.trim();
    if (!text) return;
    const lineCount = Math.max(1, text.split('\n').length);
    const locator = block.locator ?? {
      normalizedLineStart: line,
      normalizedLineEnd: line + lineCount - 1
    };
    blocks.push(createBlock({
      order,
      type: block.type,
      text,
      headingPath: block.headingPath,
      locator,
      metadata: block.metadata
    }));
    order += 1;
    line = locator.normalizedLineEnd + 2;
  };

  const visit = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (!isElement(node)) continue;
      const element = node;
      const tag = element.tagName.toLowerCase();

      if (/^h[1-6]$/u.test(tag)) {
        const level = Number(tag.slice(1));
        const text = nodeText($, element);
        if (!text) continue;
        while (headingLevels.length && headingLevels[headingLevels.length - 1]! >= level) {
          headingLevels.pop();
          headingStack.pop();
        }
        if (!title && level === 1) {
          title = text;
          push({ type: 'heading', text, headingPath: [], metadata: {} });
          continue;
        }
        headingStack.push(text);
        headingLevels.push(level);
        push({ type: 'heading', text, headingPath: currentPath(), metadata: {} });
        continue;
      }

      if (tag === 'p') {
        const text = nodeText($, element);
        if (text) push({ type: 'paragraph', text, headingPath: currentPath(), metadata: {} });
        continue;
      }

      if (tag === 'ul' || tag === 'ol') {
        collectListItems($, element, 1, (item, listLevel) => {
          push({
            type: 'list',
            text: item,
            headingPath: currentPath(),
            metadata: { listLevel }
          });
        });
        continue;
      }

      if (tag === 'table') {
        const table = parseTable($, element);
        if (!table.headers.length && table.rows.length) sawImplicitTableHeader = true;
        push({
          type: 'table',
          text: table.markdown,
          headingPath: currentPath(),
          metadata: table.headers.length ? { tableHeaders: table.headers } : {}
        });
        continue;
      }

      if (element.children?.length) visit(element.children);
    }
  };

  visit($.root().children().toArray() as unknown[]);

  if (!blocks.length) throw emptyDocumentError();
  if (!title) title = fallbackTitle(originalName);

  const markdown = blocksToMarkdown(title, blocks);
  assignNormalizedLines(blocks, markdown);

  const characterCount = Buffer.byteLength(markdown, 'utf8');
  if (characterCount > getKnowledgeMaxExtractedBytes()) throw extractedContentTooLargeError();

  const warnings = [...extraWarnings];
  if (sawImplicitTableHeader) warnings.push('部分表格没有显式表头，已将第一行作为检索语境。');

  return {
    title,
    format: 'docx',
    content: markdown,
    blocks,
    parserName: docxParser.name,
    parserVersion: docxParser.version,
    warnings: unique(warnings),
    metadata: { characterCount }
  };
}

function collectListItems(
  $: cheerio.CheerioAPI,
  element: CheerioElement,
  level: number,
  emit: (text: string, level: number) => void
) {
  for (const child of element.children ?? []) {
    if (!isElement(child) || child.tagName.toLowerCase() !== 'li') continue;
    const li = child;
    const nested = wrap($, li).children('ul,ol').toArray();
    const clone = wrap($, li).clone();
    clone.children('ul,ol').remove();
    const text = clone.text().replace(/\s+/gu, ' ').trim();
    if (text) emit(text, level);
    for (const nestedList of nested) {
      if (isElement(nestedList)) collectListItems($, nestedList, level + 1, emit);
    }
  }
}

function parseTable($: cheerio.CheerioAPI, table: CheerioElement) {
  const rows = wrap($, table).find('tr').toArray().map((row) =>
    wrap($, row).find('th,td').toArray().map((cell) => nodeText($, cell))
  ).filter((row) => row.some(Boolean));
  const hasHeader = wrap($, table).find('th').length > 0;
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  return {
    headers,
    rows: body,
    markdown: toMarkdownTable(headers, body, hasHeader)
  };
}

function toMarkdownTable(headers: string[], rows: string[][], _hasHeader: boolean) {
  const width = Math.max(headers.length, ...rows.map((row) => row.length), 1);
  const pad = (row: string[]) => Array.from({ length: width }, (_, index) => row[index] || '');
  const header = pad(headers);
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${pad(row).join(' | ')} |`)
  ];
  return lines.join('\n');
}

function blocksToMarkdown(title: string, blocks: KnowledgeBlock[]) {
  const lines: string[] = [];
  if (!blocks.some((block) => block.type === 'heading' && block.headingPath.length === 0 && block.text === title)) {
    lines.push(`# ${title}`, '');
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      const level = block.headingPath.length === 0 ? 1 : Math.min(block.headingPath.length + 1, 6);
      lines.push(`${'#'.repeat(level)} ${block.text}`, '');
      continue;
    }
    if (block.type === 'list') {
      const indent = '  '.repeat(Math.max(0, (block.metadata.listLevel ?? 1) - 1));
      lines.push(`${indent}- ${block.text}`);
      continue;
    }
    lines.push(block.text, '');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function assignNormalizedLines(blocks: KnowledgeBlock[], markdown: string) {
  const lines = markdown.split('\n');
  let searchFrom = 0;
  for (const block of blocks) {
    const firstLine = block.text.split('\n')[0] ?? block.text;
    const index = lines.findIndex((line, lineIndex) => lineIndex >= searchFrom && line.includes(firstLine.slice(0, 80)));
    if (index < 0) continue;
    const lineCount = block.text.split('\n').length;
    block.locator.normalizedLineStart = index + 1;
    block.locator.normalizedLineEnd = index + lineCount;
    searchFrom = index + 1;
  }
}

function fallbackTitle(originalName: string) {
  return originalName.replace(/\.[^.]+$/u, '') || '未命名文档';
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

type CheerioElement = {
  tagName: string;
  children?: unknown[];
};

function isElement(value: unknown): value is CheerioElement {
  return Boolean(value && typeof value === 'object' && 'tagName' in value && typeof (value as CheerioElement).tagName === 'string');
}

function wrap($: cheerio.CheerioAPI, node: unknown) {
  return $(node as never);
}

function nodeText($: cheerio.CheerioAPI, node: unknown) {
  return wrap($, node).text().replace(/\s+/gu, ' ').trim();
}
