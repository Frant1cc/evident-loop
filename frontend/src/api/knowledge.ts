import type { KnowledgeFormat, SourceLocator } from '../lib/sourceLocator';

export type KnowledgeIndexStatus = 'indexed' | 'pending' | 'outdated' | 'unavailable';
export type KnowledgeSourceType = 'manual' | 'imported';

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
  format?: KnowledgeFormat;
  sourceType?: KnowledgeSourceType;
  originalName?: string;
  originalSize?: number;
  pageCount?: number;
  editable?: boolean;
  parseWarnings?: string[];
};

export type KnowledgeDocumentDetail = {
  path: string;
  title: string;
  content: string;
  lineCount: number;
  sizeBytes: number;
  updatedAt: string;
  format?: KnowledgeFormat;
  sourceType?: KnowledgeSourceType;
  originalName?: string;
  originalSize?: number;
  pageCount?: number;
  editable?: boolean;
  parseWarnings?: string[];
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
  format?: KnowledgeFormat;
  locator?: SourceLocator;
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

export type KnowledgeImportResult = {
  document: KnowledgeDocumentDetail;
  indexStatus?: 'indexed' | 'pending';
  indexResult?: KnowledgeIndexResult;
  indexError?: string;
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
  return request<KnowledgeImportResult>('/api/knowledge/documents', {
    method: 'POST',
    body: input
  });
}

export function updateKnowledgeDocument(input: SaveDocumentInput) {
  return request<KnowledgeImportResult>('/api/knowledge/documents', {
    method: 'PUT',
    body: input
  });
}

export function uploadKnowledgeDocument(input: { file: File; path?: string; autoIndex: boolean }) {
  const body = new FormData();
  body.append('file', input.file);
  if (input.path) body.append('path', input.path);
  body.append('autoIndex', String(input.autoIndex));
  return request<KnowledgeImportResult>('/api/knowledge/documents/upload', {
    method: 'POST',
    body
  });
}

export function reparseKnowledgeDocument(path: string, autoIndex: boolean) {
  return request<KnowledgeImportResult>('/api/knowledge/documents/reparse', {
    method: 'POST',
    body: { path, autoIndex }
  });
}

export async function downloadKnowledgeOriginal(path: string) {
  const response = await fetch(`/api/knowledge/documents/original?path=${encodeURIComponent(path)}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as ApiResponse<null> | undefined;
    throw new Error(payload?.message || `下载失败：${response.status}`);
  }

  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const filename = encoded ? decodeURIComponent(encoded) : path.split('/').pop() || 'download';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
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
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const response = await fetch(path, {
    method: init.method,
    headers: init.body === undefined || isFormData ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : isFormData ? init.body as FormData : JSON.stringify(init.body)
  });
  const text = await response.text();
  let payload: ApiResponse<T> | null = null;
  try {
    payload = text ? JSON.parse(text) as ApiResponse<T> : null;
  } catch {
    throw new Error(
      `请求失败：${response.status}。请确认 Evident Loop 后端已启动，且未被其他项目占用 3000 端口。`
    );
  }

  if (!response.ok || payload?.code !== 1 || !payload.data) {
    throw new Error(payload?.message || `请求失败：${response.status}`);
  }

  return payload.data;
}
