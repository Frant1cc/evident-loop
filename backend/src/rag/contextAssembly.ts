import { estimateTokens } from './chunker.js';
import type { ChunkContentType, RagSource } from './types.js';
import { mergeLocators } from '../knowledge/locator.js';

/**
 * Combines retrieval hits whose source line ranges overlap or touch.
 * Ranking and confidence stay anchored to the highest-ranked member; only the context payload expands.
 */
export type MergeAdjacentChunksOptions = {
  /** Prevent one document from swallowing the whole context window. */
  maxChunks?: number;
  /** Conservative sum of member token counts; overlap removal can make the actual result smaller. */
  maxTokens?: number;
};

export function mergeAdjacentChunks(
  results: RagSource[],
  options: MergeAdjacentChunksOptions = {}
): RagSource[] {
  if (results.length < 2) return results.map(withContextMetadata);
  validateOptions(options);

  const parent = results.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] !== index) parent[index] = find(parent[index]!);
    return parent[index]!;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  for (let left = 0; left < results.length; left += 1) {
    for (let right = left + 1; right < results.length; right += 1) {
      if (areAdjacent(results[left]!, results[right]!)) union(left, right);
    }
  }

  const components = new Map<number, number[]>();
  results.forEach((_, index) => {
    const root = find(index);
    const members = components.get(root) ?? [];
    members.push(index);
    components.set(root, members);
  });

  return [...components.values()]
    .flatMap((indexes) => partitionComponent(indexes, results, options))
    .sort((left, right) => left.rank - right.rank)
    .map((component) => assembleComponent(component.indexes.map((index) => results[index]!)));
}

function partitionComponent(
  indexes: number[],
  results: RagSource[],
  options: MergeAdjacentChunksOptions
) {
  const maxChunks = options.maxChunks ?? Number.POSITIVE_INFINITY;
  const maxTokens = options.maxTokens ?? Number.POSITIVE_INFINITY;
  const remaining = new Set(indexes);
  const partitions: Array<{ rank: number; indexes: number[] }> = [];

  while (remaining.size) {
    const primaryIndex = Math.min(...remaining);
    const selected = [primaryIndex];
    remaining.delete(primaryIndex);
    let selectedTokens = sourceTokenCount(results[primaryIndex]!);

    while (selected.length < maxChunks) {
      const candidates = [...remaining]
        .filter((candidateIndex) =>
          selected.some((selectedIndex) => areAdjacent(
            results[candidateIndex]!,
            results[selectedIndex]!
          ))
        )
        .sort((left, right) => left - right);
      const nextIndex = candidates.find((candidateIndex) =>
        selectedTokens + sourceTokenCount(results[candidateIndex]!) <= maxTokens
      );
      if (nextIndex === undefined) break;

      selected.push(nextIndex);
      remaining.delete(nextIndex);
      selectedTokens += sourceTokenCount(results[nextIndex]!);
    }

    partitions.push({ rank: Math.min(...selected), indexes: selected });
  }

  return partitions;
}

function areAdjacent(left: RagSource, right: RagSource) {
  if (left.file !== right.file) return false;
  const structurallyAdjacent = left.nextChunkId === right.id
    || right.nextChunkId === left.id
    || left.previousChunkId === right.id
    || right.previousChunkId === left.id;
  return structurallyAdjacent
    || (
      left.startLine <= right.endLine + 1
      && right.startLine <= left.endLine + 1
    );
}

function assembleComponent(rankedMembers: RagSource[]): RagSource {
  const primary = rankedMembers[0]!;
  const members = [...rankedMembers].sort((left, right) =>
    left.startLine - right.startLine || left.endLine - right.endLine
  );
  const content = mergeContents(members.map((member) => member.content));
  const contentTypes = new Set(members.map((member) => member.contentType).filter(Boolean));

  return {
    ...primary,
    content,
    startLine: Math.min(...members.map((member) => member.startLine)),
    endLine: Math.max(...members.map((member) => member.endLine)),
    tokenCount: estimateTokens(content),
    contentType: mergedContentType(contentTypes),
    mergedChunkIds: members.flatMap((member) => member.mergedChunkIds ?? [member.id]),
    contextHeadings: unique(members.flatMap((member) => [
      ...(member.contextHeadings ?? []),
      ...(member.headingPath ?? []),
      ...(member.heading ? [member.heading] : [])
    ])),
    previousChunkId: members[0]?.previousChunkId,
    nextChunkId: members[members.length - 1]?.nextChunkId,
    locator: mergeLocators(members.map((member) => member.locator)),
    format: primary.format
  };
}

function withContextMetadata(source: RagSource): RagSource {
  return {
    ...source,
    mergedChunkIds: source.mergedChunkIds ?? [source.id],
    contextHeadings: source.contextHeadings ?? unique([
      ...(source.headingPath ?? []),
      ...(source.heading ? [source.heading] : [])
    ])
  };
}

function mergeContents(contents: string[]) {
  let merged = contents[0]?.trim() ?? '';
  for (const content of contents.slice(1)) {
    const next = content.trim();
    if (!next || merged.includes(next)) continue;
    if (next.includes(merged)) {
      merged = next;
      continue;
    }
    const leftLines = merged.split('\n');
    const rightLines = next.split('\n');
    let overlap = Math.min(leftLines.length, rightLines.length);
    while (
      overlap > 0
      && leftLines.slice(-overlap).join('\n').trim() !== rightLines.slice(0, overlap).join('\n').trim()
    ) {
      overlap -= 1;
    }
    merged = `${merged}\n\n${rightLines.slice(overlap).join('\n')}`.trim();
  }
  return merged;
}

function mergedContentType(values: Set<RagSource['contentType']>): ChunkContentType | undefined {
  if (!values.size) return undefined;
  if (values.size === 1) return values.values().next().value;
  return 'mixed';
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function sourceTokenCount(source: RagSource) {
  return source.tokenCount ?? estimateTokens(source.content);
}

function validateOptions(options: MergeAdjacentChunksOptions) {
  for (const [name, value] of Object.entries(options)) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
}
