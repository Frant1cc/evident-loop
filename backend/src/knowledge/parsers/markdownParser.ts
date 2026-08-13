import { basename, extname } from 'node:path';

import { createBlock, locatorForLines } from '../blockFactory.js';
import { emptyDocumentError, KnowledgeImportError } from '../errors.js';
import type { KnowledgeBlock, KnowledgeParser, KnowledgeUpload, ParsedKnowledgeDocument } from '../types.js';

export const markdownParser: KnowledgeParser = {
  name: 'markdown',
  version: '1',
  formats: ['md'],

  canParse(input) {
    return extname(input.originalName).toLowerCase() === '.md'
      || extname(input.originalName).toLowerCase() === '.markdown'
      || input.mimeType.includes('markdown');
  },

  async parse(input) {
    return parseMarkdownDocument(decodeUtf8(input.buffer), input.originalName);
  }
};

export function parseMarkdownDocument(content: string, originalName: string): ParsedKnowledgeDocument {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.trim()) throw emptyDocumentError();

  const lines = normalized.split('\n');
  const blocks = parseMarkdownBlocks(lines);
  if (!blocks.length) throw emptyDocumentError();

  const title = headingText(lines.find((line) => /^#\s+/u.test(line))) || fallbackTitle(originalName);

  return {
    title,
    format: 'md',
    content: normalized,
    blocks,
    parserName: markdownParser.name,
    parserVersion: markdownParser.version,
    warnings: [],
    metadata: {
      characterCount: Buffer.byteLength(normalized, 'utf8')
    }
  };
}

function parseMarkdownBlocks(lines: string[]): KnowledgeBlock[] {
  const blocks: KnowledgeBlock[] = [];
  const headingStack: Array<{ level: number; text: string }> = [];
  let index = 0;
  let order = 0;

  const headingPath = () => headingStack.filter((item) => item.level > 1).map((item) => item.text);

  const push = (block: Omit<KnowledgeBlock, 'id' | 'order'> & { order?: number }) => {
    blocks.push(createBlock({
      order,
      type: block.type,
      text: block.text,
      headingPath: block.headingPath,
      locator: block.locator,
      metadata: block.metadata
    }));
    order += 1;
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      while (headingStack.length && headingStack[headingStack.length - 1]!.level >= heading.level) {
        headingStack.pop();
      }
      headingStack.push(heading);
      const path = heading.level === 1 ? [] : headingPath();
      push({
        type: 'heading',
        text: heading.text,
        headingPath: path,
        locator: locatorForLines(index + 1, index + 1),
        metadata: {}
      });
      index += 1;
      continue;
    }

    const fence = fenceMarker(line);
    if (fence) {
      const start = index;
      index += 1;
      while (index < lines.length && !lines[index]?.trimStart().startsWith(fence)) index += 1;
      if (index < lines.length) index += 1;
      const text = lines.slice(start, index).join('\n').trim();
      const language = line.trim().slice(fence.length).trim() || undefined;
      push({
        type: 'code',
        text,
        headingPath: headingPath(),
        locator: locatorForLines(start + 1, index),
        metadata: language ? { language } : {}
      });
      continue;
    }

    if (isTableLine(line)) {
      const start = index;
      while (index < lines.length && isTableLine(lines[index] ?? '')) index += 1;
      const text = lines.slice(start, index).join('\n').trim();
      const headers = parseTableHeaders(lines[start] ?? '');
      push({
        type: 'table',
        text,
        headingPath: headingPath(),
        locator: locatorForLines(start + 1, index),
        metadata: headers.length ? { tableHeaders: headers } : {}
      });
      continue;
    }

    if (isListLine(line)) {
      const start = index;
      while (index < lines.length && (isListLine(lines[index] ?? '') || isListContinuation(lines[index] ?? ''))) {
        index += 1;
      }
      push({
        type: 'list',
        text: lines.slice(start, index).join('\n').trim(),
        headingPath: headingPath(),
        locator: locatorForLines(start + 1, index),
        metadata: { listLevel: listLevel(line) }
      });
      continue;
    }

    const start = index;
    while (
      index < lines.length
      && Boolean(lines[index]?.trim())
      && !parseHeading(lines[index] ?? '')
      && !fenceMarker(lines[index] ?? '')
      && !isTableLine(lines[index] ?? '')
      && !isListLine(lines[index] ?? '')
    ) {
      index += 1;
    }
    push({
      type: 'paragraph',
      text: lines.slice(start, index).join('\n').trim(),
      headingPath: headingPath(),
      locator: locatorForLines(start + 1, index),
      metadata: {}
    });
  }

  return blocks;
}

function parseHeading(line: string) {
  const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
  if (!match) return undefined;
  return { level: match[1]!.length, text: match[2]!.trim() };
}

function headingText(line: string | undefined) {
  return line ? parseHeading(line)?.text : undefined;
}

function fenceMarker(line: string) {
  const match = line.trimStart().match(/^(```+|~~~+)/u);
  return match?.[1]?.slice(0, 3);
}

function isTableLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  return trimmed.startsWith('|')
    || trimmed.endsWith('|')
    || (trimmed.match(/\|/gu)?.length ?? 0) >= 2;
}

function parseTableHeaders(line: string) {
  return line.split('|').map((cell) => cell.trim()).filter((cell) => cell && !/^:?-+:?$/u.test(cell));
}

function isListLine(line: string) {
  return /^\s*(?:[-*+]|\d+\.)\s+\S/u.test(line);
}

function isListContinuation(line: string) {
  return /^\s+\S/u.test(line);
}

function listLevel(line: string) {
  const indent = line.match(/^\s*/u)?.[0]?.length ?? 0;
  return Math.floor(indent / 2) + 1;
}

export function decodeUtf8(buffer: Buffer) {
  if (buffer.includes(0)) {
    throw new KnowledgeImportError('文件包含二进制内容，无法作为文本导入。', 422);
  }
  const withoutBom = hasUtf8Bom(buffer) ? buffer.subarray(3) : buffer;
  const text = withoutBom.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(withoutBom)) {
    throw new KnowledgeImportError('文件不是有效的 UTF-8 文本。', 422);
  }
  return text;
}

function hasUtf8Bom(buffer: Buffer) {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function fallbackTitle(originalName: string) {
  return basename(originalName, extname(originalName)) || '未命名文档';
}
