import { createHash } from 'node:crypto';

import { chunkKnowledgeDocument, getChunkerVersion } from './chunker.js';
import { loadMarkdownDocuments } from './documentLoader.js';
import { createEmbeddings, getEmbeddingModel, isEmbeddingConfigured } from './embeddingClient.js';
import { getKeywordStore } from './keywordStore.js';
import { readKnowledgeDocument, type KnowledgeDocument } from './knowledgeFiles.js';
import type { DocumentChunk, RagDocument } from './types.js';
import { formatSourceLocator } from '../knowledge/locator.js';
import {
  deleteChunks,
  deleteChunksByFile,
  ensureVectorCollection,
  getCollectionName,
  listStoredChunks,
  listStoredChunksForFile,
  toVectorPayload,
  upsertChunks,
  vectorCollectionExists,
  type StoredChunk,
  type VectorPoint
} from './vectorStore.js';

const batchSize = 64;
let indexingQueue = Promise.resolve();

type DesiredChunk = {
  id: string;
  contentHash: string;
  documentHash: string;
  embeddingInput: string;
  chunk: DocumentChunk;
};

export type KnowledgeIndexResult = {
  file: string;
  documentHash: string;
  chunkCount: number;
  unchanged: number;
  upserted: number;
  deleted: number;
  indexedAt: string;
  embeddingModel: string;
};

export type RagSyncResult = {
  documents: number;
  chunks: number;
  unchanged: number;
  upserted: number;
  deleted: number;
  collection: string;
  durationMs: number;
};

type RagSyncOptions = {
  documents?: RagDocument[];
  collection?: string;
};

export function vectorizeKnowledgeDocument(file: string): Promise<KnowledgeIndexResult> {
  return enqueueIndexing(() => vectorizeDocument(readKnowledgeDocument(file)));
}

export function removeKnowledgeDocumentVectors(file: string): Promise<void> {
  return enqueueIndexing(async () => {
    if (await vectorCollectionExists()) {
      await deleteChunksByFile(file);
    }
    (await getKeywordStore()).deleteFileChunks(getCollectionName(), file);
  });
}

export function syncRagIndex(options: RagSyncOptions = {}): Promise<RagSyncResult> {
  return enqueueIndexing(() => syncAllDocuments(options));
}

async function syncAllDocuments(options: RagSyncOptions): Promise<RagSyncResult> {
  ensureEmbeddingConfigured();

  const startedAt = Date.now();
  const documents = options.documents ?? loadMarkdownDocuments();
  const collection = options.collection ?? getCollectionName();
  const hasCollection = await vectorCollectionExists(collection);

  if (!documents.length) {
    if (!hasCollection) {
      throw new Error('No knowledge documents found and the Qdrant collection does not exist. Add Markdown files before the first rag:sync.');
    }

    const storedChunks = await listStoredChunks(collection);
    await deleteInBatches(storedChunks.map((chunk) => chunk.id), collection);
    (await getKeywordStore()).deleteFilesNotIn(collection, []);

    return {
      documents: 0,
      chunks: 0,
      unchanged: 0,
      upserted: 0,
      deleted: storedChunks.length,
      collection,
      durationMs: Date.now() - startedAt
    };
  }

  const results: KnowledgeIndexResult[] = [];
  for (const document of documents) {
    results.push(await vectorizeDocument(document, collection));
  }

  const existingFiles = new Set(documents.map((document) => document.file));
  const storedChunks = await listStoredChunks(collection);
  const staleIds = storedChunks.filter((chunk) => !existingFiles.has(chunk.payload.file)).map((chunk) => chunk.id);
  await deleteInBatches(staleIds, collection);
  (await getKeywordStore()).deleteFilesNotIn(collection, [...existingFiles]);

  return {
    documents: documents.length,
    chunks: results.reduce((total, result) => total + result.chunkCount, 0),
    unchanged: results.reduce((total, result) => total + result.unchanged, 0),
    upserted: results.reduce((total, result) => total + result.upserted, 0),
    deleted: staleIds.length + results.reduce((total, result) => total + result.deleted, 0),
    collection,
    durationMs: Date.now() - startedAt
  };
}

async function vectorizeDocument(document: RagDocument, collection = getCollectionName()): Promise<KnowledgeIndexResult> {
  ensureEmbeddingConfigured();

  const desiredChunks = createDesiredChunks(document);
  const documentHash = getIndexFingerprint(document);
  const hasCollection = await vectorCollectionExists(collection);
  const storedChunks = hasCollection ? await listStoredChunksForFile(document.file, collection) : [];
  const storedById = new Map(storedChunks.map((chunk) => [chunk.id, chunk]));
  const model = getEmbeddingModel();
  const changedChunks = desiredChunks.filter((chunk) => {
    const stored = storedById.get(chunk.id);
    return !stored || stored.payload.contentHash !== chunk.contentHash || stored.payload.embeddingModel !== model;
  });
  const desiredIds = new Set(desiredChunks.map((chunk) => chunk.id));
  const staleIds = storedChunks.filter((chunk) => !desiredIds.has(chunk.id)).map((chunk) => chunk.id);
  const points: VectorPoint[] = [];

  for (const chunkBatch of batches(changedChunks)) {
    const vectors = await createEmbeddings(chunkBatch.map((chunk) => chunk.embeddingInput));
    if (points.length === 0 && vectors[0]) await ensureVectorCollection(vectors[0].length, collection);

    chunkBatch.forEach((chunk, index) => {
      points.push({
        id: chunk.id,
        vector: vectors[index]!,
        payload: toVectorPayload(chunk.chunk, chunk.contentHash, chunk.documentHash, model)
      });
    });
  }

  if (!hasCollection && !points.length) {
    throw new Error('The Qdrant collection does not exist. Add a Markdown document with content before vectorizing.');
  }

  await upsertInBatches(points, collection);
  await deleteInBatches(staleIds, collection);
  // 关键词索引与向量索引同步维护：整体替换该文档的 FTS 行（与嵌入是否变化无关，写入成本低）
  (await getKeywordStore()).replaceFileChunks(collection, document.file, desiredChunks.map((chunk) => chunk.chunk));

  return {
    file: document.file,
    documentHash,
    chunkCount: desiredChunks.length,
    unchanged: desiredChunks.length - changedChunks.length,
    upserted: points.length,
    deleted: staleIds.length,
    indexedAt: new Date().toISOString(),
    embeddingModel: model
  };
}

function createDesiredChunks(document: RagDocument): DesiredChunk[] {
  const documentHash = getIndexFingerprint(document);
  const chunks = chunkKnowledgeDocument(document as KnowledgeDocument);

  return chunks.map((chunk) => {
    const embeddingInput = getEmbeddingInput(chunk);

    return {
      id: deterministicPointId(chunk.id),
      contentHash: hash(JSON.stringify({
        embeddingInput,
        previousChunkId: chunk.previousChunkId,
        nextChunkId: chunk.nextChunkId,
        locator: chunk.locator,
        parserVersion: 'parserVersion' in document ? document.parserVersion : undefined,
        chunkerVersion: getChunkerVersion(document)
      })),
      documentHash,
      embeddingInput,
      chunk
    };
  });
}

export function getIndexFingerprint(document: RagDocument) {
  const structured = 'blocks' in document ? document as KnowledgeDocument : undefined;
  return hash(JSON.stringify({
    content: document.content,
    blocks: structured?.blocks.map((block) => ({
      type: block.type,
      text: block.text,
      headingPath: block.headingPath,
      locator: block.locator
    })),
    parserName: structured?.parserName ?? document.parserName,
    parserVersion: structured?.parserVersion ?? document.parserVersion,
    chunkerVersion: getChunkerVersion(document)
  }));
}

export function deterministicPointId(value: string) {
  const digest = createHash('sha256').update(value).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function getEmbeddingInput(chunk: DesiredChunk['chunk']) {
  const headingPath = chunk.headingPath?.length
    ? `章节: ${chunk.headingPath.join(' > ')}`
    : chunk.heading ? `章节: ${chunk.heading}` : undefined;
  const formatLine = chunk.format && chunk.format !== 'md' ? `文件类型: ${formatLabel(chunk.format)}` : undefined;
  const source = chunk.format && chunk.format !== 'md'
    ? formatSourceLocator(chunk.locator, { startLine: chunk.startLine, endLine: chunk.endLine })
    : undefined;
  const sourceLine = source ? `来源: ${source}` : undefined;
  const body = chunk.contentType === 'table' ? tableEmbeddingText(chunk) : chunk.content;
  return [`文档: ${chunk.title}`, formatLine, headingPath, sourceLine, body].filter(Boolean).join('\n');
}

function formatLabel(format: string) {
  if (format === 'pdf') return 'PDF';
  if (format === 'docx') return 'DOCX';
  if (format === 'txt') return 'TXT';
  return 'Markdown';
}

function tableEmbeddingText(chunk: DocumentChunk) {
  const lines = chunk.content.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('|'));
  const rows = lines
    .filter((line) => !/^\|?\s*:?-{3,}/u.test(line))
    .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
  const headers = rows[0] ?? [];
  const records = rows.slice(1);
  const heading = chunk.headingPath?.length ? `章节: ${chunk.headingPath.join(' > ')}` : '';
  const headerLine = headers.length ? `列: ${headers.join('、')}` : '';
  const body = records.map((row) => {
    const pairs = headers.map((header, index) => `${header}：${row[index] ?? ''}`).join('\n');
    return `记录：\n${pairs || row.join('、')}`;
  }).join('\n\n');
  return [`文档: ${chunk.title}`, heading, headerLine, '', body || chunk.content].filter((line) => line !== undefined).join('\n');
}

function ensureEmbeddingConfigured() {
  if (!isEmbeddingConfigured()) {
    throw new Error('EMBEDDING_API_KEY is required for semantic RAG synchronization');
  }
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function upsertInBatches(points: VectorPoint[], collection: string) {
  for (const batch of batches(points)) {
    await upsertChunks(batch, collection);
  }
}

async function deleteInBatches(ids: string[], collection: string) {
  for (const batch of batches(ids)) {
    await deleteChunks(batch, collection);
  }
}

function enqueueIndexing<T>(operation: () => Promise<T>): Promise<T> {
  const result = indexingQueue.then(operation, operation);
  indexingQueue = result.then(() => undefined, () => undefined);
  return result;
}

function* batches<T>(values: T[]) {
  for (let index = 0; index < values.length; index += batchSize) {
    yield values.slice(index, index + batchSize);
  }
}
