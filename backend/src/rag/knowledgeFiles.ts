import { basename, extname, isAbsolute } from 'node:path';

import { asc, eq } from 'drizzle-orm';

import { db, sqlite } from '../db.js';
import { knowledgeDocumentBlocks, knowledgeDocuments } from '../schema.js';
import { parseMarkdownDocument } from '../knowledge/parsers/markdownParser.js';
import { hashText } from '../knowledge/originalFileStore.js';
import { parseLocator } from '../knowledge/locator.js';
import type {
  KnowledgeBlock,
  KnowledgeFormat,
  KnowledgeSourceType,
  ParsedKnowledgeDocument
} from '../knowledge/types.js';
import { KNOWLEDGE_FORMATS } from '../knowledge/types.js';
import type { RagDocument } from './types.js';

export type KnowledgeDocument = RagDocument & {
  sizeBytes: number;
  updatedAt: string;
  sourceType: KnowledgeSourceType;
  format: KnowledgeFormat;
  mimeType?: string;
  originalName?: string;
  originalSize?: number;
  storageKey?: string;
  parserName: string;
  parserVersion: string;
  parseWarnings: string[];
  metadata: { pageCount?: number; characterCount?: number };
  contentHash?: string;
  originalHash?: string;
  blocks: KnowledgeBlock[];
  editable: boolean;
};

type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;
type KnowledgeBlockRow = typeof knowledgeDocumentBlocks.$inferSelect;

export type SaveKnowledgeDocumentInput = {
  path: string;
  parsed: ParsedKnowledgeDocument;
  sourceType: KnowledgeSourceType;
  mimeType?: string;
  originalName?: string;
  originalSize?: number;
  storageKey?: string;
  originalHash?: string;
};

export function listKnowledgeDocuments(): KnowledgeDocument[] {
  const rows = db.select().from(knowledgeDocuments).orderBy(asc(knowledgeDocuments.path)).all();
  const blocksByPath = loadAllBlocks();
  return rows.map((row) => toKnowledgeDocument(row, blocksByPath.get(row.path) ?? [], false));
}

export function readKnowledgeDocument(file: string): KnowledgeDocument {
  const path = resolveKnowledgePath(file);
  const row = db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.path, path)).get();
  if (!row) throw new Error(`Document not found: ${path}`);
  return toKnowledgeDocument(row, loadBlocks(path), true);
}

export function knowledgeDocumentExists(file: string) {
  const path = resolveKnowledgePath(file);
  return Boolean(db.select({ path: knowledgeDocuments.path }).from(knowledgeDocuments).where(eq(knowledgeDocuments.path, path)).get());
}

export function writeKnowledgeDocument(file: string, content: string) {
  const path = resolveManualMarkdownPath(file);
  const parsed = parseMarkdownDocument(content, path);
  return saveKnowledgeDocument({
    path,
    parsed: { ...parsed, parserName: 'markdown', parserVersion: '1' },
    sourceType: 'manual',
    mimeType: 'text/markdown',
    originalName: basename(path)
  });
}

export function saveKnowledgeDocument(input: SaveKnowledgeDocumentInput): KnowledgeDocument {
  const path = resolveKnowledgePath(input.path);
  const now = new Date().toISOString();
  const existing = db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.path, path)).get();
  const contentHash = hashText(input.parsed.content);
  const values = {
    path,
    content: input.parsed.content,
    updatedAt: now,
    sourceType: input.sourceType,
    format: input.parsed.format,
    mimeType: input.mimeType ?? null,
    originalName: input.originalName ?? null,
    originalSize: input.originalSize ?? null,
    storageKey: input.storageKey ?? existing?.storageKey ?? null,
    parserName: input.parsed.parserName,
    parserVersion: input.parsed.parserVersion,
    parseWarningsJson: JSON.stringify(input.parsed.warnings),
    metadataJson: JSON.stringify(input.parsed.metadata),
    contentHash,
    originalHash: input.originalHash ?? existing?.originalHash ?? null
  };

  const persist = sqlite.transaction(() => {
    if (existing) {
      db.update(knowledgeDocuments).set(values).where(eq(knowledgeDocuments.path, path)).run();
    } else {
      db.insert(knowledgeDocuments).values({ ...values, createdAt: now }).run();
    }
    replaceBlocks(path, input.parsed.blocks);
  });
  persist();

  return readKnowledgeDocument(path);
}

export function deleteKnowledgeDocument(file: string) {
  const path = resolveKnowledgePath(file);
  const row = db.select({ storageKey: knowledgeDocuments.storageKey }).from(knowledgeDocuments).where(eq(knowledgeDocuments.path, path)).get();
  const deleted = db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.path, path)).run().changes > 0;
  return { deleted, storageKey: row?.storageKey ?? undefined };
}

export function getKnowledgeStorageKey(file: string) {
  const path = resolveKnowledgePath(file);
  return db.select({
    storageKey: knowledgeDocuments.storageKey,
    originalName: knowledgeDocuments.originalName,
    mimeType: knowledgeDocuments.mimeType,
    sourceType: knowledgeDocuments.sourceType
  }).from(knowledgeDocuments).where(eq(knowledgeDocuments.path, path)).get();
}

export function resolveKnowledgePath(file: string) {
  if (!file || file.includes('\0') || file.includes('\\') || isAbsolute(file)) {
    throw new Error('Document path must be a relative knowledge path');
  }

  const path = file.trim();
  const segments = path.split('/');

  if (!path || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Document path must be a relative knowledge path');
  }

  const extension = extname(path).toLowerCase();
  if (!KNOWLEDGE_FORMATS.some((format) => `.${format}` === extension) && extension !== '.markdown') {
    throw new Error('Only Markdown, TXT, DOCX and PDF documents are supported');
  }

  return path;
}

export function resolveManualMarkdownPath(file: string) {
  const path = resolveKnowledgePath(file);
  if (extname(path).toLowerCase() !== '.md') {
    throw new Error('Only Markdown (.md) documents are supported');
  }
  return path;
}

function toKnowledgeDocument(row: KnowledgeDocumentRow, blocks: KnowledgeBlock[], ensureBlocks: boolean): KnowledgeDocument {
  const format = isKnowledgeFormat(row.format) ? row.format : 'md';
  const sourceType: KnowledgeSourceType = row.sourceType === 'imported' ? 'imported' : 'manual';
  let resolvedBlocks = blocks;
  if (ensureBlocks && !resolvedBlocks.length && format === 'md' && row.content.trim()) {
    resolvedBlocks = backfillMarkdownBlocks(row);
  }

  const lines = row.content.split(/\r?\n/);
  const metadata = parseJsonRecord(row.metadataJson);

  return {
    file: row.path,
    title: getDocumentTitle(lines, row.path),
    content: row.content,
    lineCount: lines.length,
    sizeBytes: Buffer.byteLength(row.content, 'utf8'),
    updatedAt: toIsoTimestamp(row.updatedAt),
    sourceType,
    format,
    ...(row.mimeType ? { mimeType: row.mimeType } : {}),
    ...(row.originalName ? { originalName: row.originalName } : {}),
    ...(typeof row.originalSize === 'number' ? { originalSize: row.originalSize } : {}),
    ...(row.storageKey ? { storageKey: row.storageKey } : {}),
    parserName: row.parserName || 'legacy-markdown',
    parserVersion: row.parserVersion || '1',
    parseWarnings: parseJsonArray(row.parseWarningsJson),
    metadata: {
      ...(typeof metadata.pageCount === 'number' ? { pageCount: metadata.pageCount } : {}),
      ...(typeof metadata.characterCount === 'number' ? { characterCount: metadata.characterCount } : {})
    },
    ...(row.contentHash ? { contentHash: row.contentHash } : {}),
    ...(row.originalHash ? { originalHash: row.originalHash } : {}),
    blocks: resolvedBlocks,
    editable: sourceType === 'manual' && format === 'md'
  };
}

function backfillMarkdownBlocks(row: KnowledgeDocumentRow) {
  const parsed = parseMarkdownDocument(row.content, row.path);
  const persist = sqlite.transaction(() => {
    db.update(knowledgeDocuments)
      .set({
        parserName: row.parserName === 'legacy-markdown' ? 'legacy-markdown' : row.parserName || 'legacy-markdown',
        parserVersion: row.parserVersion || '1',
        mimeType: row.mimeType ?? 'text/markdown',
        contentHash: row.contentHash ?? hashText(row.content)
      })
      .where(eq(knowledgeDocuments.path, row.path))
      .run();
    replaceBlocks(row.path, parsed.blocks);
  });
  persist();
  return parsed.blocks;
}

function replaceBlocks(path: string, blocks: KnowledgeBlock[]) {
  sqlite.prepare('DELETE FROM knowledge_document_blocks WHERE document_path = ?').run(path);
  const insert = sqlite.prepare(`
    INSERT INTO knowledge_document_blocks
      (id, document_path, block_order, block_type, text, heading_path_json, locator_json, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const block of blocks) {
    insert.run(
      block.id,
      path,
      block.order,
      block.type,
      block.text,
      JSON.stringify(block.headingPath),
      JSON.stringify(block.locator),
      JSON.stringify(block.metadata)
    );
  }
}

function loadBlocks(path: string) {
  return db.select().from(knowledgeDocumentBlocks)
    .where(eq(knowledgeDocumentBlocks.documentPath, path))
    .all()
    .sort((left, right) => left.blockOrder - right.blockOrder)
    .map(toBlock);
}

function loadAllBlocks() {
  const grouped = new Map<string, KnowledgeBlock[]>();
  for (const row of db.select().from(knowledgeDocumentBlocks).all()) {
    const blocks = grouped.get(row.documentPath) ?? [];
    blocks.push(toBlock(row));
    grouped.set(row.documentPath, blocks);
  }
  for (const blocks of grouped.values()) {
    blocks.sort((left, right) => left.order - right.order);
  }
  return grouped;
}

function toBlock(row: KnowledgeBlockRow): KnowledgeBlock {
  return {
    id: row.id,
    order: row.blockOrder,
    type: isBlockType(row.blockType) ? row.blockType : 'paragraph',
    text: row.text,
    headingPath: parseJsonArray(row.headingPathJson),
    locator: parseLocator(parseJsonRecord(row.locatorJson)) ?? {
      normalizedLineStart: 1,
      normalizedLineEnd: 1
    },
    metadata: parseJsonRecord(row.metadataJson) as KnowledgeBlock['metadata']
  };
}

function getDocumentTitle(lines: string[], file: string) {
  const titleLine = lines.find((line) => line.startsWith('# '));
  return titleLine ? titleLine.replace(/^#\s+/, '').trim() : basename(file, extname(file));
}

function toIsoTimestamp(value: string) {
  return value.endsWith('Z') ? value : new Date(value.replace(' ', 'T') + 'Z').toISOString();
}

function isKnowledgeFormat(value: string | null | undefined): value is KnowledgeFormat {
  return value === 'md' || value === 'txt' || value === 'docx' || value === 'pdf';
}

function isBlockType(value: string): value is KnowledgeBlock['type'] {
  return value === 'heading' || value === 'paragraph' || value === 'list' || value === 'table' || value === 'code';
}

function parseJsonArray(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string | null | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
