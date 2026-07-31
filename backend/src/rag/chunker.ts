import type { ChunkContentType, DocumentChunk, RagDocument } from './types.js';

export const chunkingConfig = {
  targetMaxTokens: 500,
  targetMinTokens: 200,
  overlapTokens: 60
} as const;

type BlockKind = 'text' | 'table' | 'code';

type MarkdownBlock = {
  content: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
  kind: BlockKind;
};

type Section = {
  heading?: string;
  headingPath: string[];
  parentPath: string[];
  pathOccurrence: number;
  bodyStartIndex: number;
  endIndex: number;
};

type ChunkDraft = Omit<DocumentChunk,
  'chunkIndex' | 'previousChunkId' | 'nextChunkId'
>;

/**
 * Markdown-aware adaptive chunker.
 *
 * - Splits structurally at `##` and `###`, retaining the complete heading path.
 * - Packs ordinary paragraphs into ~200-500-token chunks with a small paragraph overlap.
 * - Keeps fenced code blocks and Markdown tables atomic, even when they exceed the target size.
 * - Derives stable IDs from file + heading path + section occurrence + part number, never line offsets.
 */
export function chunkMarkdownDocument(document: RagDocument): DocumentChunk[] {
  const lines = document.content.split(/\r?\n/);
  const sections = splitSections(lines);
  const drafts = sections.flatMap((section) => chunkSection(document, lines, section));

  return drafts.map((chunk, index) => ({
    ...chunk,
    chunkIndex: index,
    previousChunkId: drafts[index - 1]?.id,
    nextChunkId: drafts[index + 1]?.id
  }));
}

/** Approximation used for chunk budgets and diagnostics; avoids coupling indexing to a model tokenizer. */
export function estimateTokens(value: string) {
  let cjk = 0;
  let other = 0;
  for (const char of value) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(char)) cjk += 1;
    else if (!/\s/u.test(char)) other += 1;
  }
  return Math.max(1, Math.ceil(cjk + other / 4));
}

function splitSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  const occurrences = new Map<string, number>();
  let currentLevelTwo: string | undefined;
  let current: Omit<Section, 'endIndex' | 'pathOccurrence'> = {
    headingPath: [],
    parentPath: [],
    bodyStartIndex: skipDocumentTitle(lines)
  };

  const closeCurrent = (endIndex: number) => {
    const pathKey = current.headingPath.join('\u001f') || '__intro__';
    const pathOccurrence = (occurrences.get(pathKey) ?? 0) + 1;
    occurrences.set(pathKey, pathOccurrence);
    sections.push({ ...current, endIndex, pathOccurrence });
  };

  for (let index = current.bodyStartIndex; index < lines.length; index += 1) {
    const heading = parseSectionHeading(lines[index]);
    if (!heading) continue;

    closeCurrent(index - 1);
    if (heading.level === 2) {
      currentLevelTwo = heading.text;
      current = {
        heading: heading.text,
        headingPath: [heading.text],
        parentPath: [],
        bodyStartIndex: index + 1
      };
    } else {
      const parentPath = currentLevelTwo ? [currentLevelTwo] : [];
      current = {
        heading: heading.text,
        headingPath: [...parentPath, heading.text],
        parentPath,
        bodyStartIndex: index + 1
      };
    }
  }

  closeCurrent(lines.length - 1);
  return sections;
}

function chunkSection(document: RagDocument, lines: string[], section: Section): ChunkDraft[] {
  const blocks = parseBlocks(lines, section.bodyStartIndex, section.endIndex);
  if (!blocks.length) return [];

  const groups = packBlocks(blocks);
  const pathKey = stablePathKey(section.headingPath);
  const sectionKey = `${document.file}:${pathKey}:section-${section.pathOccurrence}`;
  const parentId = section.parentPath.length
    ? `${document.file}:${stablePathKey(section.parentPath)}`
    : undefined;

  return groups.map((group, index) => {
    const content = group.map((block) => block.content).join('\n\n').trim();
    const kinds = new Set(group.map((block) => block.kind));
    return {
      id: `${sectionKey}:part-${index + 1}`,
      file: document.file,
      title: document.title,
      heading: section.heading,
      headingPath: section.headingPath,
      content,
      startLine: Math.min(...group.map((block) => block.startLine)),
      endLine: Math.max(...group.map((block) => block.endLine)),
      partIndex: index,
      parentId,
      tokenCount: estimateTokens(content),
      contentType: contentType(kinds)
    };
  });
}

function parseBlocks(lines: string[], startIndex: number, endIndex: number): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let index = Math.max(0, startIndex);

  while (index <= endIndex) {
    if (!lines[index]?.trim()) {
      index += 1;
      continue;
    }

    const fence = fenceMarker(lines[index]!);
    if (fence) {
      const blockStart = index;
      index += 1;
      while (index <= endIndex) {
        if (lines[index]?.trimStart().startsWith(fence)) {
          index += 1;
          break;
        }
        index += 1;
      }
      blocks.push(createBlock(lines, blockStart, index - 1, 'code'));
      continue;
    }

    if (isTableLine(lines[index]!)) {
      const blockStart = index;
      while (index <= endIndex && isTableLine(lines[index]!)) index += 1;
      blocks.push(createBlock(lines, blockStart, index - 1, 'table'));
      continue;
    }

    const blockStart = index;
    while (
      index <= endIndex
      && Boolean(lines[index]?.trim())
      && !fenceMarker(lines[index]!)
      && !isTableLine(lines[index]!)
    ) {
      index += 1;
    }
    blocks.push(...splitOversizedTextBlock(lines, blockStart, index - 1));
  }

  return blocks;
}

function splitOversizedTextBlock(lines: string[], startIndex: number, endIndex: number): MarkdownBlock[] {
  const whole = createBlock(lines, startIndex, endIndex, 'text');
  if (whole.tokenCount <= chunkingConfig.targetMaxTokens) return [whole];

  const blocks: MarkdownBlock[] = [];
  let currentLines: Array<{ text: string; line: number }> = [];
  let currentTokens = 0;

  const flush = () => {
    if (!currentLines.length) return;
    const content = currentLines.map((item) => item.text).join('\n').trim();
    if (content) {
      blocks.push({
        content,
        startLine: currentLines[0]!.line,
        endLine: currentLines[currentLines.length - 1]!.line,
        tokenCount: estimateTokens(content),
        kind: 'text'
      });
    }
    currentLines = [];
    currentTokens = 0;
  };

  for (let index = startIndex; index <= endIndex; index += 1) {
    for (const segment of splitLongLine(lines[index]!, chunkingConfig.targetMaxTokens)) {
      const segmentTokens = estimateTokens(segment);
      if (currentLines.length && currentTokens + segmentTokens > chunkingConfig.targetMaxTokens) flush();
      currentLines.push({ text: segment, line: index + 1 });
      currentTokens += segmentTokens;
    }
  }
  flush();
  return blocks;
}

function splitLongLine(line: string, maxTokens: number): string[] {
  if (estimateTokens(line) <= maxTokens) return [line];
  const units = line.match(/[^。！？.!?；;]+[。！？.!?；;]?/gu) ?? [line];
  const result: string[] = [];
  let current = '';

  for (const unit of units) {
    if (estimateTokens(unit) > maxTokens) {
      if (current.trim()) result.push(current.trim());
      current = '';
      result.push(...hardSplit(unit, maxTokens));
      continue;
    }
    const candidate = `${current}${unit}`;
    if (current && estimateTokens(candidate) > maxTokens) {
      result.push(current.trim());
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function hardSplit(value: string, maxTokens: number): string[] {
  const chars = [...value];
  const result: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(chars.length, start + maxTokens * 4);
    while (end > start + 1 && estimateTokens(chars.slice(start, end).join('')) > maxTokens) end -= 1;
    result.push(chars.slice(start, end).join('').trim());
    start = end;
  }
  return result.filter(Boolean);
}

function packBlocks(blocks: MarkdownBlock[]): MarkdownBlock[][] {
  const groups: MarkdownBlock[][] = [];
  let current: MarkdownBlock[] = [];
  let currentTokens = 0;

  for (const block of blocks) {
    if (current.length && currentTokens + block.tokenCount > chunkingConfig.targetMaxTokens) {
      groups.push(current);
      current = overlapTail(current);
      currentTokens = current.reduce((total, item) => total + item.tokenCount, 0);
      while (current.length && currentTokens + block.tokenCount > chunkingConfig.targetMaxTokens) {
        currentTokens -= current.shift()!.tokenCount;
      }
    }
    current.push(block);
    currentTokens += block.tokenCount;
  }
  if (current.length) groups.push(current);

  rebalanceSmallTail(groups);
  return groups;
}

function overlapTail(blocks: MarkdownBlock[]) {
  const overlap: MarkdownBlock[] = [];
  let tokens = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind !== 'text') continue;
    if (tokens + block.tokenCount > chunkingConfig.overlapTokens) break;
    overlap.unshift(block);
    tokens += block.tokenCount;
  }
  if (!overlap.length) {
    const lastText = [...blocks].reverse().find((block) => block.kind === 'text');
    if (lastText) overlap.push(tailExcerpt(lastText, chunkingConfig.overlapTokens));
  }
  return overlap;
}

function tailExcerpt(block: MarkdownBlock, tokenBudget: number): MarkdownBlock {
  const chars = [...block.content];
  let start = Math.max(0, chars.length - tokenBudget * 4);
  while (start < chars.length - 1 && estimateTokens(chars.slice(start).join('')) > tokenBudget) start += 1;
  const content = chars.slice(start).join('').trim();
  return {
    ...block,
    content,
    tokenCount: estimateTokens(content)
  };
}

function rebalanceSmallTail(groups: MarkdownBlock[][]) {
  if (groups.length < 2) return;
  const tail = groups[groups.length - 1]!;
  const previous = groups[groups.length - 2]!;
  const tailTokens = uniqueTokenCount(tail);
  if (tailTokens >= chunkingConfig.targetMinTokens) return;

  const merged = dedupeBlocks([...previous, ...tail]);
  if (merged.reduce((total, block) => total + block.tokenCount, 0) <= chunkingConfig.targetMaxTokens) {
    groups.splice(groups.length - 2, 2, merged);
  }
}

function uniqueTokenCount(blocks: MarkdownBlock[]) {
  return dedupeBlocks(blocks).reduce((total, block) => total + block.tokenCount, 0);
}

function dedupeBlocks(blocks: MarkdownBlock[]) {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    const key = `${block.startLine}:${block.endLine}:${block.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createBlock(lines: string[], startIndex: number, endIndex: number, kind: BlockKind): MarkdownBlock {
  const content = lines.slice(startIndex, endIndex + 1).join('\n').trim();
  return {
    content,
    startLine: startIndex + 1,
    endLine: endIndex + 1,
    tokenCount: estimateTokens(content),
    kind
  };
}

function parseSectionHeading(line: string | undefined) {
  const match = line?.match(/^(#{2,3})\s+(.+?)\s*#*\s*$/u);
  if (!match) return undefined;
  return { level: match[1]!.length as 2 | 3, text: match[2]!.trim() };
}

function skipDocumentTitle(lines: string[]) {
  const firstContent = lines.findIndex((line) => line.trim());
  return firstContent >= 0 && /^#\s+/u.test(lines[firstContent]!)
    ? firstContent + 1
    : Math.max(0, firstContent);
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

function stablePathKey(path: string[]) {
  if (!path.length) return '__intro__';
  return path
    .map((value) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/gu, '-').replace(/[^\p{L}\p{N}._-]+/gu, '-'))
    .join('/');
}

function contentType(kinds: Set<BlockKind>): ChunkContentType {
  if (kinds.size > 1) return 'mixed';
  if (kinds.has('code')) return 'code';
  if (kinds.has('table')) return 'table';
  return 'text';
}
