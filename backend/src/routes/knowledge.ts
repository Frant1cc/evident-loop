import { extname } from 'node:path';

import { Router, type Response } from 'express';
import multer from 'multer';

import { getKnowledgeMaxUploadBytes } from '../knowledge/config.js';
import { KnowledgeImportError } from '../knowledge/errors.js';
import {
  assertDocumentEditable,
  deleteImportedDocument,
  importKnowledgeUpload,
  reparseKnowledgeDocument
} from '../knowledge/importService.js';
import { originalFileStore } from '../knowledge/originalFileStore.js';
import { chunkKnowledgeDocument } from '../rag/chunker.js';
import { getEmbeddingModel } from '../rag/embeddingClient.js';
import {
  knowledgeDocumentExists,
  listKnowledgeDocuments,
  readKnowledgeDocument,
  resolveKnowledgePath,
  resolveManualMarkdownPath,
  writeKnowledgeDocument,
  type KnowledgeDocument
} from '../rag/knowledgeFiles.js';
import { getIndexFingerprint, syncRagIndex, vectorizeKnowledgeDocument } from '../rag/sync.js';
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
      const chunks = chunkKnowledgeDocument(document);
      const indexedChunks = storedByFile.get(document.file) ?? [];
      const documentHash = getIndexFingerprint(document);
      const hasMatchingIndex = indexedChunks.length === chunks.length && indexedChunks.every((storedChunk) =>
        storedChunk.payload.documentHash === documentHash && storedChunk.payload.embeddingModel === getEmbeddingModel()
      );
      const latestIndexedAt = indexedChunks.reduce<string | undefined>((latest, chunk) =>
        !latest || chunk.payload.indexedAt > latest ? chunk.payload.indexedAt : latest,
      undefined);

      return toDocumentSummary(document, {
        chunkCount: chunks.length,
        indexedChunkCount: indexedChunks.length,
        indexStatus: !indexAvailable ? 'unavailable' : hasMatchingIndex ? 'indexed' : indexedChunks.length ? 'outdated' : 'pending',
        indexedAt: latestIndexedAt,
        embeddingModel: indexedChunks[0]?.payload.embeddingModel
      });
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
    res.json(success(toDocumentDetail(readKnowledgeDocument(path))));
  } catch (error) {
    respondDocumentError(res, error);
  }
});

knowledgeRouter.get('/knowledge/documents/original', async (req, res) => {
  try {
    const path = parsePath(req.query.path);
    const document = readKnowledgeDocument(path);
    if (!document.storageKey || document.sourceType !== 'imported') {
      res.status(404).json(failure('Original file is not available for this document'));
      return;
    }

    const bytes = await originalFileStore.read(document.storageKey);
    const filename = document.originalName ?? path;
    res.setHeader('Content-Type', document.mimeType || contentTypeForPath(path));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(bytes);
  } catch (error) {
    respondDocumentError(res, error);
  }
});

knowledgeRouter.post('/knowledge/documents/upload', (req, res) => {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: getKnowledgeMaxUploadBytes(), files: 1 }
  }).single('file');

  upload(req, res, async (error) => {
    try {
      if (error) {
        if (isMulterLimitError(error)) {
          res.status(413).json(failure(`文件不能超过 ${Math.round(getKnowledgeMaxUploadBytes() / 1_000_000)} MB。`));
          return;
        }
        throw error;
      }
      if (!req.file) {
        res.status(400).json(failure('file is required'));
        return;
      }

      const result = await importKnowledgeUpload({
        upload: {
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          size: req.file.size,
          buffer: req.file.buffer
        },
        path: typeof req.body?.path === 'string' ? req.body.path : undefined,
        autoIndex: parseAutoIndex(req.body?.autoIndex)
      });

      const message = result.indexStatus === 'indexed'
        ? 'Document imported'
        : 'Document imported; indexing is pending';
      res.status(201).json(success({
        document: toDocumentDetail(result.document),
        indexStatus: result.indexStatus,
        ...(result.indexResult ? { indexResult: result.indexResult } : {}),
        ...(result.indexError ? { indexError: result.indexError } : {})
      }, message));
    } catch (caught) {
      respondImportError(res, caught);
    }
  });
});

knowledgeRouter.post('/knowledge/documents/reparse', async (req, res) => {
  try {
    const path = parsePath(req.body?.path);
    const autoIndex = parseAutoIndex(req.body?.autoIndex);
    const result = await reparseKnowledgeDocument(path, autoIndex);
    const message = result.indexStatus === 'indexed'
      ? 'Document reparsed'
      : 'Document reparsed; indexing is pending';
    res.json(success({
      document: toDocumentDetail(result.document),
      indexStatus: result.indexStatus,
      ...(result.indexResult ? { indexResult: result.indexResult } : {}),
      ...(result.indexError ? { indexError: result.indexError } : {})
    }, message));
  } catch (error) {
    respondImportError(res, error);
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
    const indexed = await indexIfRequested(document.file, autoIndex);
    res.status(201).json(success({ document: toDocumentDetail(document), ...indexed }, 'Document created'));
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

    assertDocumentEditable(path);
    const document = writeKnowledgeDocument(path, content);
    const indexed = await indexIfRequested(document.file, autoIndex);
    res.json(success({ document: toDocumentDetail(document), ...indexed }, 'Document updated'));
  } catch (error) {
    respondImportError(res, error, 'Document was saved but indexing failed');
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

    await deleteImportedDocument(path, autoIndex);
    res.json(success({ path, vectorsDeleted: autoIndex }, 'Document deleted'));
  } catch (error) {
    respondMutationError(res, error, 'Document was deleted but vector cleanup failed');
  }
});

knowledgeRouter.post('/knowledge/documents/chunk', (req, res) => {
  try {
    const path = parsePath(req.body?.path);
    const document = readKnowledgeDocument(path);
    const chunks = chunkKnowledgeDocument(document);

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
        contentType: chunk.contentType,
        format: chunk.format,
        locator: chunk.locator
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
  const parsedPath = resolveManualMarkdownPath(parseRawPath(path));

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content must be a non-empty string');
  }

  if (Buffer.byteLength(content, 'utf8') > maxDocumentBytes) {
    throw new Error(`content must not exceed ${maxDocumentBytes} bytes`);
  }

  return { path: parsedPath, content, autoIndex: parseAutoIndex(autoIndex) };
}

function parsePath(value: unknown) {
  const path = parseRawPath(value);
  resolveKnowledgePath(path);
  return path;
}

function parseRawPath(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('path must be a non-empty document path');
  }
  return value.trim();
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

async function indexIfRequested(path: string, autoIndex: boolean) {
  if (!autoIndex) return {};
  try {
    return { indexResult: await vectorizeKnowledgeDocument(path), indexStatus: 'indexed' as const };
  } catch (error) {
    return {
      indexStatus: 'pending' as const,
      indexError: error instanceof Error ? error.message : 'Indexing failed'
    };
  }
}

function toDocumentSummary(document: KnowledgeDocument, index: {
  chunkCount: number;
  indexedChunkCount: number;
  indexStatus: 'indexed' | 'pending' | 'outdated' | 'unavailable';
  indexedAt?: string;
  embeddingModel?: string;
}) {
  return {
    path: document.file,
    title: document.title,
    lineCount: document.lineCount,
    sizeBytes: document.sizeBytes,
    updatedAt: document.updatedAt,
    format: document.format,
    sourceType: document.sourceType,
    originalName: document.originalName,
    originalSize: document.originalSize,
    pageCount: document.metadata.pageCount,
    editable: document.editable,
    parseWarnings: document.parseWarnings,
    ...index
  };
}

function toDocumentDetail(document: KnowledgeDocument) {
  return {
    path: document.file,
    title: document.title,
    content: document.content,
    lineCount: document.lineCount,
    sizeBytes: document.sizeBytes,
    updatedAt: document.updatedAt,
    format: document.format,
    sourceType: document.sourceType,
    originalName: document.originalName,
    originalSize: document.originalSize,
    pageCount: document.metadata.pageCount,
    editable: document.editable,
    parseWarnings: document.parseWarnings
  };
}

function contentTypeForPath(path: string) {
  const extension = extname(path).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (extension === '.txt') return 'text/plain; charset=utf-8';
  return 'text/markdown; charset=utf-8';
}

function respondDocumentError(res: Response, error: unknown) {
  if (error instanceof KnowledgeImportError) {
    res.status(error.status).json(failure(error.message));
    return;
  }
  const message = getErrorMessage(error, 'Knowledge document request failed');
  res.status(message.startsWith('Document not found:') ? 404 : 400).json(failure(message));
}

function respondImportError(res: Response, error: unknown, upstreamMessage?: string) {
  if (error instanceof KnowledgeImportError) {
    res.status(error.status).json(failure(error.message));
    return;
  }
  respondMutationError(res, error, upstreamMessage ?? 'Knowledge import failed');
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
  return message.includes('path') || message.includes('Markdown') || message.includes('content') || message.includes('Request body') || message.includes('document');
}

function isMulterLimitError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'LIMIT_FILE_SIZE');
}
