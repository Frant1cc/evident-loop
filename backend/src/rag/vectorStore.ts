import { QdrantClient } from '@qdrant/js-client-rest';

import type { ChunkContentType, DocumentChunk, RagSource } from './types.js';

const defaultQdrantUrl = 'http://localhost:6333';
const defaultCollectionName = 'knowledge_chunks';
const scrollPageSize = 100;

export type VectorPayload = {
  file: string;
  title: string;
  heading?: string;
  headingPath?: string[];
  content: string;
  startLine: number;
  endLine: number;
  chunkIndex?: number;
  partIndex?: number;
  parentId?: string;
  previousChunkId?: string;
  nextChunkId?: string;
  tokenCount?: number;
  contentType?: ChunkContentType;
  chunkKey: string;
  contentHash: string;
  documentHash: string;
  embeddingModel: string;
  indexedAt: string;
};

export type StoredChunk = {
  id: string;
  payload: VectorPayload;
};

export type VectorPoint = {
  id: string;
  vector: number[];
  payload: VectorPayload;
};

const client = new QdrantClient({
  url: process.env.QDRANT_URL ?? defaultQdrantUrl,
  apiKey: process.env.QDRANT_API_KEY || undefined
});

export function getCollectionName() {
  return process.env.QDRANT_COLLECTION ?? defaultCollectionName;
}

export async function vectorCollectionExists(collectionName = getCollectionName()) {
  return (await client.collectionExists(collectionName)).exists;
}

export async function ensureVectorCollection(vectorSize?: number, collectionName = getCollectionName()): Promise<void> {
  const exists = await client.collectionExists(collectionName);

  if (!exists.exists) {
    if (!vectorSize) {
      throw new Error(
        `Qdrant collection "${collectionName}" does not exist. Run "pnpm --filter backend rag:sync" to create and populate it.`
      );
    }

    await client.createCollection(collectionName, {
      vectors: {
        size: vectorSize,
        distance: 'Cosine'
      }
    });
    await Promise.all([
      client.createPayloadIndex(collectionName, { field_name: 'file', field_schema: 'keyword', wait: true }),
      client.createPayloadIndex(collectionName, { field_name: 'documentHash', field_schema: 'keyword', wait: true })
    ]);
    return;
  }

  if (!vectorSize) return;

  const collection = await client.getCollection(collectionName);
  const vectors = collection.config.params.vectors;

  if (!isDenseVectorConfig(vectors) || vectors.size !== vectorSize) {
    throw new Error(
      `Qdrant collection "${collectionName}" has incompatible vector dimensions. Configure a new QDRANT_COLLECTION and run rag:sync.`
    );
  }
}

export async function listStoredChunks(collectionName = getCollectionName()): Promise<StoredChunk[]> {
  return listChunks(collectionName);
}

export async function listStoredChunksForFile(file: string, collectionName = getCollectionName()): Promise<StoredChunk[]> {
  return listChunks(collectionName, {
    must: [{
      key: 'file',
      match: { value: file }
    }]
  });
}

async function listChunks(
  collectionName: string,
  filter?: { must: Array<{ key: string; match: { value: string } }> }
): Promise<StoredChunk[]> {
  const chunks: StoredChunk[] = [];
  let offset: string | number | Record<string, unknown> | undefined;

  do {
    const page = await client.scroll(collectionName, {
      limit: scrollPageSize,
      offset,
      filter,
      with_payload: true,
      with_vector: false
    });

    for (const point of page.points) {
      const payload = parsePayload(point.payload);
      if (payload) chunks.push({ id: String(point.id), payload });
    }

    offset = page.next_page_offset === null ? undefined : page.next_page_offset;
  } while (offset !== undefined);

  return chunks;
}

export async function upsertChunks(points: VectorPoint[], collectionName = getCollectionName()): Promise<void> {
  if (!points.length) return;

  await client.upsert(collectionName, { points, wait: true });
}

export async function deleteChunks(ids: string[], collectionName = getCollectionName()): Promise<void> {
  if (!ids.length) return;

  await client.delete(collectionName, { points: ids, wait: true });
}

export async function deleteChunksByFile(file: string, collectionName = getCollectionName()): Promise<void> {
  await client.delete(collectionName, {
    filter: {
      must: [{
        key: 'file',
        match: { value: file }
      }]
    },
    wait: true
  });
}

export async function searchChunks(vector: number[], limit: number, collectionName = getCollectionName()): Promise<RagSource[]> {
  const points = await client.search(collectionName, {
    vector,
    limit,
    with_payload: true
  });

  return points.flatMap((point) => {
    const payload = parsePayload(point.payload);
    if (!payload) return [];

    return [{
      id: payload.chunkKey,
      file: payload.file,
      title: payload.title,
      heading: payload.heading,
      headingPath: payload.headingPath,
      content: payload.content,
      startLine: payload.startLine,
      endLine: payload.endLine,
      chunkIndex: payload.chunkIndex,
      partIndex: payload.partIndex,
      parentId: payload.parentId,
      previousChunkId: payload.previousChunkId,
      nextChunkId: payload.nextChunkId,
      tokenCount: payload.tokenCount,
      contentType: payload.contentType,
      score: point.score,
      semanticScore: point.score
    }];
  });
}

export function toVectorPayload(
  chunk: DocumentChunk,
  contentHash: string,
  documentHash: string,
  embeddingModel: string
): VectorPayload {
  return {
    file: chunk.file,
    title: chunk.title,
    heading: chunk.heading,
    headingPath: chunk.headingPath,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    chunkIndex: chunk.chunkIndex,
    partIndex: chunk.partIndex,
    parentId: chunk.parentId,
    previousChunkId: chunk.previousChunkId,
    nextChunkId: chunk.nextChunkId,
    tokenCount: chunk.tokenCount,
    contentType: chunk.contentType,
    chunkKey: chunk.id,
    contentHash,
    documentHash,
    embeddingModel,
    indexedAt: new Date().toISOString()
  };
}

function isDenseVectorConfig(value: unknown): value is { size: number } {
  return Boolean(value && typeof value === 'object' && 'size' in value && typeof value.size === 'number');
}

function parsePayload(value: unknown): VectorPayload | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const payload = value as Partial<VectorPayload>;
  if (
    typeof payload.file !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.content !== 'string' ||
    typeof payload.startLine !== 'number' ||
    typeof payload.endLine !== 'number' ||
    typeof payload.chunkKey !== 'string' ||
    typeof payload.contentHash !== 'string' ||
    typeof payload.documentHash !== 'string' ||
    typeof payload.embeddingModel !== 'string' ||
    typeof payload.indexedAt !== 'string'
  ) {
    return undefined;
  }

  return {
    file: payload.file,
    title: payload.title,
    heading: typeof payload.heading === 'string' ? payload.heading : undefined,
    headingPath: Array.isArray(payload.headingPath)
      ? payload.headingPath.filter((item): item is string => typeof item === 'string')
      : undefined,
    content: payload.content,
    startLine: payload.startLine,
    endLine: payload.endLine,
    chunkIndex: typeof payload.chunkIndex === 'number' ? payload.chunkIndex : undefined,
    partIndex: typeof payload.partIndex === 'number' ? payload.partIndex : undefined,
    parentId: typeof payload.parentId === 'string' ? payload.parentId : undefined,
    previousChunkId: typeof payload.previousChunkId === 'string' ? payload.previousChunkId : undefined,
    nextChunkId: typeof payload.nextChunkId === 'string' ? payload.nextChunkId : undefined,
    tokenCount: typeof payload.tokenCount === 'number' ? payload.tokenCount : undefined,
    contentType: isChunkContentType(payload.contentType) ? payload.contentType : undefined,
    chunkKey: payload.chunkKey,
    contentHash: payload.contentHash,
    documentHash: payload.documentHash,
    embeddingModel: payload.embeddingModel,
    indexedAt: payload.indexedAt
  };
}

function isChunkContentType(value: unknown): value is ChunkContentType {
  return value === 'text' || value === 'table' || value === 'code' || value === 'mixed';
}
