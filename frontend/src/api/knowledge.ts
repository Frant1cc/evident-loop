export type KnowledgeIndexStatus = 'indexed' | 'pending' | 'outdated' | 'unavailable';

export type KnowledgeDocumentSummary = {
  path: string;
  title: string;
  lineCount: number;
  sizeBytes: number;
  updatedAt: string;
  chunkCount: number;
  indexedChunkCount: number;
  indexStatus: KnowledgeIndexStatus;
  indexedAt?: string;
  embeddingModel?: string;
};

export type KnowledgeDocumentDetail = {
  path: string;
  title: string;
  content: string;
  lineCount: number;
  sizeBytes: number;
  updatedAt: string;
};

export type KnowledgeChunk = {
  id: string;
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
  contentType?: 'text' | 'table' | 'code' | 'mixed';
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

export type KnowledgeSyncResult = {
  documents: number;
  chunks: number;
  unchanged: number;
  upserted: number;
  deleted: number;
  collection: string;
  durationMs: number;
};

type KnowledgeListResult = {
  documents: KnowledgeDocumentSummary[];
  summary: {
    documentCount: number;
    indexedDocumentCount: number;
    chunkCount: number;
    indexedChunkCount: number;
  };
};

type ApiResponse<T> = {
  code: 0 | 1;
  message: string;
  data: T | null;
};

type SaveDocumentInput = {
  path: string;
  content: string;
  autoIndex: boolean;
};

export function listKnowledgeDocuments() {
  return request<KnowledgeListResult>('/api/knowledge/documents');
}

export function readKnowledgeDocument(path: string) {
  return request<KnowledgeDocumentDetail>(`/api/knowledge/documents/content?path=${encodeURIComponent(path)}`);
}

export function createKnowledgeDocument(input: SaveDocumentInput) {
  return request<{ document: KnowledgeDocumentDetail; indexResult?: KnowledgeIndexResult }>('/api/knowledge/documents', {
    method: 'POST',
    body: input
  });
}

export function updateKnowledgeDocument(input: SaveDocumentInput) {
  return request<{ document: KnowledgeDocumentDetail; indexResult?: KnowledgeIndexResult }>('/api/knowledge/documents', {
    method: 'PUT',
    body: input
  });
}

export function deleteKnowledgeDocument(path: string, autoIndex: boolean) {
  return request<{ path: string; vectorsDeleted: boolean }>(
    `/api/knowledge/documents?path=${encodeURIComponent(path)}&autoIndex=${autoIndex}`,
    { method: 'DELETE' }
  );
}

export function previewKnowledgeChunks(path: string) {
  return request<{ path: string; title: string; chunks: KnowledgeChunk[] }>('/api/knowledge/documents/chunk', {
    method: 'POST',
    body: { path }
  });
}

export function vectorizeKnowledgeDocument(path: string) {
  return request<KnowledgeIndexResult>('/api/knowledge/documents/vectorize', {
    method: 'POST',
    body: { path }
  });
}

export function syncKnowledgeBase() {
  return request<KnowledgeSyncResult>('/api/knowledge/sync', { method: 'POST' });
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method,
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const payload = await response.json() as ApiResponse<T>;

  if (!response.ok || payload.code !== 1 || !payload.data) {
    throw new Error(payload.message || `请求失败：${response.status}`);
  }

  return payload.data;
}
