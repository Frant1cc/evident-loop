import { basename, extname } from 'node:path';

import { createBlock, locatorForLines } from '../blockFactory.js';
import { emptyDocumentError } from '../errors.js';
import type { KnowledgeParser, ParsedKnowledgeDocument } from '../types.js';
import { decodeUtf8 } from './markdownParser.js';

export const textParser: KnowledgeParser = {
  name: 'text',
  version: '1',
  formats: ['txt'],

  canParse(input) {
    return extname(input.originalName).toLowerCase() === '.txt' || input.mimeType === 'text/plain';
  },

  async parse(input) {
    return parseTextDocument(decodeUtf8(input.buffer), input.originalName);
  }
};

export function parseTextDocument(content: string, originalName: string): ParsedKnowledgeDocument {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.trim()) throw emptyDocumentError();

  const lines = normalized.split('\n');
  const fileTitle = basename(originalName, extname(originalName)) || '未命名文档';
  const firstLine = lines.find((line) => line.trim())?.trim() ?? '';
  const title = isReliableTitle(firstLine) ? firstLine : fileTitle;
  const skipFirstLine = title === firstLine;
  const paragraphs = collectParagraphs(lines, skipFirstLine ? lines.findIndex((line) => line.trim()) + 1 : 0);

  if (!paragraphs.length && !skipFirstLine) throw emptyDocumentError();

  const blocks = [
    createBlock({
      order: 0,
      type: 'heading',
      text: title,
      headingPath: [],
      locator: locatorForLines(1, 1, skipFirstLine ? lines.findIndex((line) => line.trim()) + 1 : 1, skipFirstLine ? lines.findIndex((line) => line.trim()) + 1 : 1)
    }),
    ...paragraphs.map((paragraph, index) => createBlock({
      order: index + 1,
      type: 'paragraph',
      text: paragraph.text,
      headingPath: [],
      locator: locatorForLines(paragraph.normalizedStart, paragraph.normalizedEnd, paragraph.originalStart, paragraph.originalEnd)
    }))
  ];

  const body = paragraphs.map((paragraph) => paragraph.text).join('\n\n');
  const markdown = `# ${title}\n\n${body}`.trim() + '\n';
  const markdownLines = markdown.split('\n');
  const withNormalizedLines = blocks.map((block) => {
    if (block.type === 'heading') {
      return { ...block, locator: { ...block.locator, normalizedLineStart: 1, normalizedLineEnd: 1 } };
    }
    const start = markdownLines.findIndex((line) => line === block.text.split('\n')[0]);
    const lineCount = block.text.split('\n').length;
    const normalizedStart = start >= 0 ? start + 1 : block.locator.normalizedLineStart;
    return {
      ...block,
      locator: {
        ...block.locator,
        normalizedLineStart: normalizedStart,
        normalizedLineEnd: normalizedStart + lineCount - 1
      }
    };
  });

  return {
    title,
    format: 'txt',
    content: markdown,
    blocks: withNormalizedLines,
    parserName: textParser.name,
    parserVersion: textParser.version,
    warnings: [],
    metadata: {
      characterCount: Buffer.byteLength(normalized, 'utf8')
    }
  };
}

function collectParagraphs(lines: string[], startIndex: number) {
  const paragraphs: Array<{
    text: string;
    originalStart: number;
    originalEnd: number;
    normalizedStart: number;
    normalizedEnd: number;
  }> = [];
  let index = startIndex;

  while (index < lines.length) {
    if (!lines[index]?.trim()) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && lines[index]?.trim()) index += 1;
    const text = lines.slice(start, index).join('\n').trim();
    if (text) {
      paragraphs.push({
        text,
        originalStart: start + 1,
        originalEnd: index,
        normalizedStart: start + 1,
        normalizedEnd: index
      });
    }
  }

  return paragraphs;
}

function isReliableTitle(line: string) {
  if (!line || line.length > 80) return false;
  if (/[。！？.!?]$/u.test(line)) return false;
  if (line.includes('\n')) return false;
  return true;
}
