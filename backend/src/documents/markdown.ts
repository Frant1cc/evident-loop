import type { DocumentBlock } from './types.js';

const headingPattern = /^(#{1,6})\s+(.+)$/;
const bulletPattern = /^\s*[-*+]\s+(.+)$/;
const numberedPattern = /^\s*\d+[.)]\s+(.+)$/;
const pageBreakPattern = /^<!--\s*pagebreak\s*-->$/i;
const fencePattern = /^\s*```/;

export function markdownToDocumentBlocks(markdown: string): DocumentBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocumentBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (pageBreakPattern.test(trimmed)) {
      blocks.push({ type: 'pageBreak' });
      index += 1;
      continue;
    }

    const heading = trimmed.match(headingPattern);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: Math.min(3, heading[1].length) as 1 | 2 | 3,
        text: cleanInlineMarkdown(heading[2])
      });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const table = parseTable(lines, index);
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const bullet = line.match(bulletPattern);
    if (bullet) {
      const list = parseList(lines, index, bulletPattern, 'bulletList');
      blocks.push(list.block);
      index = list.nextIndex;
      continue;
    }

    const numbered = line.match(numberedPattern);
    if (numbered) {
      const list = parseList(lines, index, numberedPattern, 'numberedList');
      blocks.push(list.block);
      index = list.nextIndex;
      continue;
    }

    if (fencePattern.test(line)) {
      const code = parseCodeFence(lines, index);
      if (code.text) blocks.push({ type: 'paragraph', text: code.text });
      index = code.nextIndex;
      continue;
    }

    const paragraph = parseParagraph(lines, index);
    blocks.push({ type: 'paragraph', text: paragraph.text });
    index = paragraph.nextIndex;
  }

  return blocks;
}

function parseList(
  lines: string[],
  startIndex: number,
  pattern: RegExp,
  type: 'bulletList' | 'numberedList'
) {
  const items: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const match = lines[index].match(pattern);
    if (!match) break;
    items.push(cleanInlineMarkdown(match[1]));
    index += 1;
  }

  return {
    block: { type, items } as Extract<DocumentBlock, { type: typeof type }>,
    nextIndex: index
  };
}

function isTableStart(lines: string[], index: number) {
  if (index + 2 >= lines.length) return false;
  const headers = splitTableRow(lines[index]);
  const separators = splitTableRow(lines[index + 1]);
  const firstRow = splitTableRow(lines[index + 2]);

  return (
    headers.length > 0 &&
    separators.length === headers.length &&
    separators.every((cell) => /^:?-{3,}:?$/.test(cell.trim())) &&
    firstRow.length === headers.length
  );
}

function parseTable(lines: string[], startIndex: number) {
  const headers = splitTableRow(lines[startIndex]).map(cleanInlineMarkdown);
  const rows: string[][] = [];
  let index = startIndex + 2;

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed || !trimmed.includes('|')) break;
    const cells = splitTableRow(lines[index]);
    if (cells.length !== headers.length) break;
    rows.push(cells.map(cleanInlineMarkdown));
    index += 1;
  }

  return {
    block: { type: 'table', headers, rows } as const,
    nextIndex: index
  };
}

function splitTableRow(line: string) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed.includes('|')) return [];

  const cells: string[] = [];
  let current = '';
  let escaped = false;

  for (const character of trimmed) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (escaped) current += '\\';
  cells.push(current.trim());
  return cells;
}

function parseCodeFence(lines: string[], startIndex: number) {
  const content: string[] = [];
  let index = startIndex + 1;

  while (index < lines.length && !fencePattern.test(lines[index])) {
    content.push(lines[index]);
    index += 1;
  }

  if (index < lines.length) index += 1;
  return { text: content.join('\n').trim(), nextIndex: index };
}

function parseParagraph(lines: string[], startIndex: number) {
  const content: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) break;
    if (index !== startIndex && isBlockBoundary(lines, index)) break;
    content.push(trimmed.replace(/^>\s?/, ''));
    index += 1;
  }

  return {
    text: cleanInlineMarkdown(content.join('\n')),
    nextIndex: index
  };
}

function isBlockBoundary(lines: string[], index: number) {
  const line = lines[index];
  const trimmed = line.trim();
  return (
    pageBreakPattern.test(trimmed) ||
    headingPattern.test(trimmed) ||
    bulletPattern.test(line) ||
    numberedPattern.test(line) ||
    fencePattern.test(line) ||
    isTableStart(lines, index)
  );
}

function cleanInlineMarkdown(text: string) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[\s（(])([*_])([^*_\n]+)\2(?=$|[\s，。；：、）)])/g, '$1$3')
    .replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, '$1')
    .trim();
}
