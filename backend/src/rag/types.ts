export type RagDocument = {
  file: string;
  title: string;
  content: string;
  lineCount: number;
};

export type ChunkContentType = 'text' | 'table' | 'code' | 'mixed';

export type DocumentChunk = {
  id: string;
  file: string;
  title: string;
  heading?: string;
  /** Full Markdown heading ancestry, from `##` parent to the leaf `###` heading. */
  headingPath?: string[];
  content: string;
  startLine: number;
  endLine: number;
  /** Stable document-order position and section-local part number. */
  chunkIndex?: number;
  partIndex?: number;
  /** Stable parent section key plus neighboring chunk keys for context expansion. */
  parentId?: string;
  previousChunkId?: string;
  nextChunkId?: string;
  tokenCount?: number;
  contentType?: ChunkContentType;
};

export type RagSource = DocumentChunk & {
  score: number;
  keywordScore?: number;
  semanticScore?: number;
  /** Set when adjacent retrieval hits have been assembled into one context block. */
  mergedChunkIds?: string[];
  contextHeadings?: string[];
};
