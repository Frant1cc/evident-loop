import { createHash } from 'node:crypto';

import { Router, type Response } from 'express';

import { chunkMarkdownDocument } from '../rag/chunker.js';
import { getEmbeddingModel } from '../rag/embeddingClient.js';
import {
  deleteKnowledgeDocument,
  knowledgeDocumentExists,
  listKnowledgeDocuments,
  readKnowledgeDocument,
  resolveKnowledgePath,
  writeKnowledgeDocument
} from '../rag/knowledgeFiles.js';
import { removeKnowledgeDocumentVectors, syncRagIndex, vectorizeKnowledgeDocument } from '../rag/sync.js';
import { listStoredChunks, vectorCollectionExists } from '../rag/vectorStore.js';
import { failure, success } from '../response.js';

const maxDocumentBytes = 1_000_000;

export const knowledgeRouter = Router();

knowledgeRouter.get('/knowledge/documents', async (_req, res) => {
  try {
    const documents = listKnowledgeDocuments();
    const { storedChunks, indexAvailable } = await getStoredChunks();
    const storedByFile = new Map<string, typeof storedChunks>();

    for (const storedChunk of storedChunks) {
      const chunks = storedByFile.get(storedChunk.payload.file) ?? [];
      chunks.push(storedChunk);
      storedByFile.set(storedChunk.payload.file, chunks);
    }

    const summaries = documents.map((document) => {
      const chunks = chunkMarkdownDocument(document);
      const indexedChunks = storedByFile.get(document.file) ?? [];
      const documentHash = createHash('sha256').update(document.content).digest('hex');
      const hasMatchingIndex = indexedChunks.length === chunks.length && indexedChunks.every((storedChunk) =>
        storedChunk.payload.documentHash === documentHash && storedChunk.payload.embeddingModel === getEmbeddingModel()
      );
      const latestIndexedAt = indexedChunks.reduce<string | undefined>((latest, chunk) =>
        !latest || chunk.payload.indexedAt > latest ? chunk.payload.indexedAt : latest,
      undefined);

      return {
        path: document.file,
        title: document.title,
        lineCount: document.lineCount,
        sizeBytes: document.sizeBytes,
        updatedAt: document.updatedAt,
        chunkCount: chunks.length,
        indexedChunkCount: indexedChunks.length,
        indexStatus: !indexAvailable ? 'unavailable' : hasMatchingIndex ? 'indexed' : indexedChunks.length ? 'outdated' : 'pending',
        indexedAt: latestIndexedAt,
        embeddingModel: indexedChunks[0]?.payload.embeddingModel
      };
    });

    res.json(success({
      documents: summaries,
      summary: {
        documentCount: summaries.length,
        indexedDocumentCount: summaries.filter((document) => document.indexStatus === 'indexed').length,
        chunkCount: summaries.reduce((total, document) => total + document.chunkCount, 0),
        indexedChunkCount: summaries.reduce((total, document) => total + document.indexedChunkCount, 0)
      }
    }));
  } catch (error) {
    res.status(502).json(failure(getErrorMessage(error, 'Failed to list knowledge documents')));
  }
});

knowledgeRouter.get('/knowledge/documents/content', (req, res) => {
  try {
    const path = parsePath(req.query.path);
    const document = readKnowledgeDocument(path);

    res.json(success({
      path: document.file,
      title: document.title,
      content: document.content,
      lineCount: document.lineCount,
      sizeBytes: document.sizeBytes,
      updatedAt: document.updatedAt
    }));
  } catch (error) {
    respondDocumentError(res, error);
  }
});

knowledgeRouter.post('/knowledge/documents', async (req, res) => {
  try {
    const { path, content, autoIndex } = parseDocumentBody(req.body);

    if (knowledgeDocumentExists(path)) {
      res.status(409).json(failure(`Document already exists: ${path}`));
      return;
    }

    const document = writeKnowledgeDocument(path, content);
    const indexResult = autoIndex ? await vectorizeKnowledgeDocument(document.file) : undefined;

    res.status(201).json(success({ document: toDocumentDetail(document), indexResult }, 'Document created'));
  } catch (error) {
    respondMutationError(res, error, 'Document was saved but indexing failed');
  }
});

knowledgeRouter.put('/knowledge/documents', async (req, res) => {
  try {
    const { path, content, autoIndex } = parseDocumentBody(req.body);

    if (!knowledgeDocumentExists(path)) {
      res.status(404).json(failure(`Document not found: ${path}`));
      return;
    }

    const document = writeKnowledgeDocument(path, content);
    const indexResult = autoIndex ? await vectorizeKnowledgeDocument(document.file) : undefined;

    res.json(success({ document: toDocumentDetail(document), indexResult }, 'Document updated'));
  } catch (error) {
    respondMutationError(res, error, 'Document was saved but indexing failed');
  }
});

knowledgeRouter.delete('/knowledge/documents', async (req, res) => {
  try {
    const path = parsePath(req.query.path);
    const autoIndex = parseAutoIndex(req.query.autoIndex);

    if (!knowledgeDocumentExists(path)) {
      res.status(404).json(failure(`Document not found: ${path}`));
      return;
    }

    deleteKnowledgeDocument(path);
    if (autoIndex) await removeKnowledgeDocumentVectors(path);

    res.json(success({ path, vectorsDeleted: autoIndex }, 'Document deleted'));
  } catch (error) {
    respondMutationError(res, error, 'Document was deleted but vector cleanup failed');
  }
});

knowledgeRouter.post('/knowledge/documents/chunk', (req, res) => {
  try {
    const path = parsePath(req.body?.path);
    const document = readKnowledgeDocument(path);
    const chunks = chunkMarkdownDocument(document);

    res.json(success({
      path: document.file,
      title: document.title,
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
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
        contentType: chunk.contentType
      }))
    }));
  } catch (error) {
    respondDocumentError(res, error);
  }
});

knowledgeRouter.post('/knowledge/documents/vectorize', async (req, res) => {
  try {
    const path = parsePath(req.body?.path);

    if (!knowledgeDocumentExists(path)) {
      res.status(404).json(failure(`Document not found: ${path}`));
      return;
    }

    res.json(success(await vectorizeKnowledgeDocument(path), 'Document vectorized'));
  } catch (error) {
    respondUpstreamError(res, error, 'Document vectorization failed');
  }
});

knowledgeRouter.post('/knowledge/sync', async (_req, res) => {
  try {
    res.json(success(await syncRagIndex(), 'Knowledge base synchronized'));
  } catch (error) {
    respondUpstreamError(res, error, 'Knowledge base synchronization failed');
  }
});

function parseDocumentBody(body: unknown) {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body is required');
  }

  const { path, content, autoIndex } = body as { path?: unknown; content?: unknown; autoIndex?: unknown };
  const parsedPath = parsePath(path);

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content must be a non-empty string');
  }

  if (Buffer.byteLength(content, 'utf8') > maxDocumentBytes) {
    throw new Error(`content must not exceed ${maxDocumentBytes} bytes`);
  }

  return { path: parsedPath, content, autoIndex: parseAutoIndex(autoIndex) };
}

function parsePath(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('path must be a non-empty Markdown path');
  }

  const path = value.trim();
  resolveKnowledgePath(path);
  return path;
}

function parseAutoIndex(value: unknown) {
  if (value === undefined) return true;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('autoIndex must be a boolean');
}

async function getStoredChunks() {
  try {
    if (!await vectorCollectionExists()) {
      return { storedChunks: [], indexAvailable: false };
    }

    return { storedChunks: await listStoredChunks(), indexAvailable: true };
  } catch {
    return { storedChunks: [], indexAvailable: false };
  }
}

function toDocumentDetail(document: ReturnType<typeof readKnowledgeDocument>) {
  return {
    path: document.file,
    title: document.title,
    content: document.content,
    lineCount: document.lineCount,
    sizeBytes: document.sizeBytes,
    updatedAt: document.updatedAt
  };
}

function respondDocumentError(res: Response, error: unknown) {
  const message = getErrorMessage(error, 'Knowledge document request failed');
  res.status(message.startsWith('Document not found:') ? 404 : 400).json(failure(message));
}

function respondMutationError(res: Response, error: unknown, upstreamMessage: string) {
  const message = getErrorMessage(error, upstreamMessage);
  const status = isClientError(message) ? 400 : 502;
  res.status(status).json(failure(status === 502 ? `${upstreamMessage}: ${message}` : message));
}

function respondUpstreamError(res: Response, error: unknown, fallbackMessage: string) {
  res.status(502).json(failure(getErrorMessage(error, fallbackMessage)));
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isClientError(message: string) {
  return message.includes('path') || message.includes('Markdown') || message.includes('content') || message.includes('Request body');
}
