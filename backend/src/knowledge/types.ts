export type KnowledgeFormat = 'md' | 'txt' | 'docx' | 'pdf';
export type KnowledgeSourceType = 'manual' | 'imported';
export type KnowledgeBlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'code';

export type SourceLocator = {
  normalizedLineStart: number;
  normalizedLineEnd: number;
  originalLineStart?: number;
  originalLineEnd?: number;
  pageStart?: number;
  pageEnd?: number;
};

export type KnowledgeBlock = {
  id: string;
  order: number;
  type: KnowledgeBlockType;
  text: string;
  headingPath: string[];
  locator: SourceLocator;
  metadata: {
    tableHeaders?: string[];
    listLevel?: number;
    language?: string;
  };
};

export type ParsedKnowledgeDocument = {
  title: string;
  format: KnowledgeFormat;
  content: string;
  blocks: KnowledgeBlock[];
  parserName: string;
  parserVersion: string;
  warnings: string[];
  metadata: {
    pageCount?: number;
    characterCount?: number;
  };
};

export type KnowledgeUpload = {
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
};

export interface KnowledgeParser {
  readonly name: string;
  readonly version: string;
  readonly formats: KnowledgeFormat[];
  canParse(input: KnowledgeUpload): boolean;
  parse(input: KnowledgeUpload): Promise<ParsedKnowledgeDocument>;
}

export interface OriginalFileStore {
  save(input: { bytes: Buffer; extension: string }): Promise<string>;
  read(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
}

export const KNOWLEDGE_FORMATS: KnowledgeFormat[] = ['md', 'txt', 'docx', 'pdf'];

export const KNOWLEDGE_MIME_TYPES: Record<KnowledgeFormat, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf'
};
