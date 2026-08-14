import { createHash } from 'node:crypto';

import type { KnowledgeBlock, KnowledgeBlockType, SourceLocator } from './types.js';

export function createBlock(input: {
  order: number;
  type: KnowledgeBlockType;
  text: string;
  headingPath: string[];
  locator: SourceLocator;
  metadata?: KnowledgeBlock['metadata'];
}): KnowledgeBlock {
  return {
    id: blockId(input.order, input.type, input.text, input.headingPath),
    order: input.order,
    type: input.type,
    text: input.text,
    headingPath: input.headingPath,
    locator: input.locator,
    metadata: input.metadata ?? {}
  };
}

export function locatorForLines(
  startLine: number,
  endLine: number,
  originalStart = startLine,
  originalEnd = endLine
): SourceLocator {
  return {
    normalizedLineStart: startLine,
    normalizedLineEnd: endLine,
    originalLineStart: originalStart,
    originalLineEnd: originalEnd
  };
}

export function countCharacters(value: string) {
  return [...value].length;
}

function blockId(order: number, type: string, text: string, headingPath: string[]) {
  return createHash('sha256')
    .update(`${order}:${type}:${headingPath.join('\u001f')}:${text.slice(0, 120)}`)
    .digest('hex')
    .slice(0, 32);
}
