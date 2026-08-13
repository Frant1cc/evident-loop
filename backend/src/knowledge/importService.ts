import { extname } from 'node:path';

import { getKnowledgeMaxExtractedBytes } from './config.js';
import {
  extractedContentTooLargeError,
  KnowledgeImportError,
  notEditableError,
  pathConflictError
} from './errors.js';
import { detectKnowledgeFormat, pathFromOriginalName, sanitizeKnowledgePath, sanitizeOriginalName } from './fileValidation.js';
import { hashBuffer } from './originalFileStore.js';
import { originalFileStore } from './originalFileStore.js';
import { resolveParser } from './parserRegistry.js';
import type { KnowledgeUpload, OriginalFileStore, ParsedKnowledgeDocument } from './types.js';
import {
  deleteKnowledgeDocument,
  knowledgeDocumentExists,
  readKnowledgeDocument,
  saveKnowledgeDocument,
  type KnowledgeDocument
} from '../rag/knowledgeFiles.js';
import { chunkKnowledgeDocument } from '../rag/chunker.js';
import { removeKnowledgeDocumentVectors, vectorizeKnowledgeDocument } from '../rag/sync.js';

export type ImportIndexStatus = 'indexed' | 'pending';

export type ImportResult = {
  document: KnowledgeDocument;
  indexStatus: ImportIndexStatus;
  indexResult?: Awaited<ReturnType<typeof vectorizeKnowledgeDocument>>;
  indexError?: string;
};

export async function importKnowledgeUpload(input: {
  upload: KnowledgeUpload;
  path?: string;
  autoIndex?: boolean;
  files?: OriginalFileStore;
}): Promise<ImportResult> {
  const startedAt = Date.now();
  const originalName = sanitizeOriginalName(input.upload.originalName);
  const format = detectKnowledgeFormat({ ...input.upload, originalName });
  const parser = resolveParser({ ...input.upload, originalName });
  const parsed = await parser.parse({ ...input.upload, originalName });
  assertExtractedSize(parsed);

  const path = input.path?.trim()
    ? sanitizeKnowledgePath(input.path, format)
    : pathFromOriginalName(originalName, format);

  if (knowledgeDocumentExists(path)) throw pathConflictError();

  const originalHash = hashBuffer(input.upload.buffer);
  const files = input.files ?? originalFileStore;
  const storageKey = await files.save({ bytes: input.upload.buffer, extension: extname(originalName) });

  let document: KnowledgeDocument;
  try {
    document = saveKnowledgeDocument({
      path,
      parsed,
      sourceType: 'imported',
      mimeType: input.upload.mimeType || undefined,
      originalName,
      originalSize: input.upload.size,
      storageKey,
      originalHash
    });
  } catch (error) {
    await files.delete(storageKey);
    throw error;
  }

  logImport({
    format,
    size: input.upload.size,
    parserName: parsed.parserName,
    parserVersion: parsed.parserVersion,
    durationMs: Date.now() - startedAt,
    pageCount: parsed.metadata.pageCount,
    blockCount: parsed.blocks.length,
    characterCount: parsed.metadata.characterCount,
    warningCount: parsed.warnings.length,
    chunkCount: chunkKnowledgeDocument(document).length
  });

  return indexAfterSave(document, input.autoIndex !== false);
}

export async function reparseKnowledgeDocument(path: string, autoIndex = true, files = originalFileStore): Promise<ImportResult> {
  const current = readKnowledgeDocument(path);
  if (!current.storageKey) {
    throw new KnowledgeImportError('该文档没有可重新解析的原文件。', 422);
  }

  const bytes = await files.read(current.storageKey);
  const originalName = current.originalName ?? path;
  const upload: KnowledgeUpload = {
    originalName,
    mimeType: current.mimeType ?? '',
    size: bytes.length,
    buffer: bytes
  };
  const parser = resolveParser(upload);
  const parsed = await parser.parse(upload);
  assertExtractedSize(parsed);

  const document = saveKnowledgeDocument({
    path,
    parsed,
    sourceType: current.sourceType,
    mimeType: current.mimeType,
    originalName,
    originalSize: current.originalSize ?? bytes.length,
    storageKey: current.storageKey,
    originalHash: current.originalHash
  });

  return indexAfterSave(document, autoIndex);
}

export async function deleteImportedDocument(path: string, autoIndex = true, files = originalFileStore) {
  const current = knowledgeDocumentExists(path) ? readKnowledgeDocument(path) : undefined;
  const { deleted, storageKey } = deleteKnowledgeDocument(path);
  if (storageKey) await files.delete(storageKey);
  if (autoIndex) await removeKnowledgeDocumentVectors(path);
  return { deleted, storageKey: current?.storageKey };
}

export function assertDocumentEditable(path: string) {
  const document = readKnowledgeDocument(path);
  if (!document.editable) throw notEditableError();
  return document;
}

async function indexAfterSave(document: KnowledgeDocument, autoIndex: boolean): Promise<ImportResult> {
  if (!autoIndex) {
    return { document, indexStatus: 'pending' };
  }

  const indexStarted = Date.now();
  try {
    const indexResult = await vectorizeKnowledgeDocument(document.file);
    logImport({ indexMs: Date.now() - indexStarted, chunkCount: indexResult.chunkCount, file: document.file });
    return { document, indexStatus: 'indexed', indexResult };
  } catch (error) {
    const indexError = error instanceof Error ? error.message : 'Indexing failed';
    logImport({ indexMs: Date.now() - indexStarted, indexError, file: document.file });
    return { document, indexStatus: 'pending', indexError };
  }
}

function assertExtractedSize(parsed: ParsedKnowledgeDocument) {
  const bytes = Buffer.byteLength(parsed.content, 'utf8');
  if (bytes > getKnowledgeMaxExtractedBytes()) throw extractedContentTooLargeError();
}

function logImport(fields: Record<string, unknown>) {
  console.info(JSON.stringify({ msg: 'knowledge-import', ...fields }));
}
