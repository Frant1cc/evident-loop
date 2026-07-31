import { createHash } from 'node:crypto';

import { chunkMarkdownDocument } from './chunker.js';
import { loadMarkdownDocuments } from './documentLoader.js';
import { createEmbeddings, getEmbeddingModel, isEmbeddingConfigured } from './embeddingClient.js';
import { getKeywordStore } from './keywordStore.js';
import { readKnowledgeDocument } from './knowledgeFiles.js';
import type { RagDocument } from './types.js';
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
  chunk: ReturnType<typeof chunkMarkdownDocument>[number];
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
    documentHash: hash(document.content),
    chunkCount: desiredChunks.length,
    unchanged: desiredChunks.length - changedChunks.length,
    upserted: points.length,
    deleted: staleIds.length,
    indexedAt: new Date().toISOString(),
    embeddingModel: model
  };
}

function createDesiredChunks(document: RagDocument): DesiredChunk[] {
  const documentHash = hash(document.content);

  return chunkMarkdownDocument(document).map((chunk) => {
    const embeddingInput = getEmbeddingInput(chunk);

    return {
      id: deterministicPointId(chunk.id),
      // Neighbor links affect retrieval-time context assembly. Include them in the incremental
      // signature so inserting/removing a section refreshes the two affected payloads without
      // making document-order shifts re-embed every later chunk.
      contentHash: hash(JSON.stringify({
        embeddingInput,
        previousChunkId: chunk.previousChunkId,
        nextChunkId: chunk.nextChunkId
      })),
      documentHash,
      embeddingInput,
      chunk
    };
  });
}

export function deterministicPointId(value: string) {
  const digest = createHash('sha256').update(value).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function getEmbeddingInput(chunk: DesiredChunk['chunk']) {
  const headingPath = chunk.headingPath?.length
    ? `章节路径: ${chunk.headingPath.join(' > ')}`
    : chunk.heading;
  return [`文档: ${chunk.title}`, headingPath, chunk.content].filter(Boolean).join('\n');
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
