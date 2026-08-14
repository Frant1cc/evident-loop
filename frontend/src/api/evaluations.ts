import type { RagEvaluation, RagEvaluationStreamEvent, WebEvaluation, WebEvaluationCase, WebEvaluationStreamEvent } from '../types/evaluations';
import { consumeSse, parseSseJson } from './sse';

type ApiResponse<T> = { code: 0 | 1; message: string; data: T | null };

export function listRagEvaluations() {
  return request<{ evaluations: RagEvaluation[] }>('/api/rag/evaluations');
}

export function getRagEvaluation(id: string) {
  return request<{ evaluation: RagEvaluation }>(`/api/rag/evaluations/${encodeURIComponent(id)}`);
}

export function createRagEvaluation(input: {
  name?: string;
  k: number;
  thresholds: { recallAtK: number; mrrAtK: number };
  retrieval?: 'dense' | 'hybrid';
  queryRewrite?: boolean;
}) {
  return request<{ evaluation: RagEvaluation }>('/api/rag/evaluations', { method: 'POST', body: input });
}

export function deleteRagEvaluation(id: string) {
  return request<{ id: string }>(`/api/rag/evaluations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function subscribeToRagEvaluation(
  id: string,
  onEvent: (event: RagEvaluationStreamEvent) => void,
  onError: () => void
) {
  const controller = new AbortController();
  const eventNames = new Set<RagEvaluationStreamEvent['type']>(['snapshot', 'progress', 'completed', 'failed']);
  let reachedTerminalEvent = false;

  void consumeSse({
    url: `/api/rag/evaluations/${encodeURIComponent(id)}/events`,
    signal: controller.signal,
    onMessage(message) {
      if (!eventNames.has(message.event as RagEvaluationStreamEvent['type'])) return;
      const parsed = parseSseJson<RagEvaluationStreamEvent>(message);
      const event = { ...parsed, type: message.event } as RagEvaluationStreamEvent;
      if (event.type === 'completed' || event.type === 'failed') reachedTerminalEvent = true;
      onEvent(event);
    }
  }).then(() => {
    if (!reachedTerminalEvent && !controller.signal.aborted) onError();
  }).catch((error: unknown) => {
    if ((error as Error).name !== 'AbortError' && !controller.signal.aborted) onError();
  });

  return () => controller.abort();
}

export function listWebEvaluationCases() {
  return request<{ cases: WebEvaluationCase[]; benchmarkVersion: number; suites: { smoke: string[]; regression: string[] } }>('/api/web/evaluation-cases');
}

export function exportWebEvaluationCases() {
  return request<{ library: WebEvaluationLibraryExport }>('/api/web/evaluation-cases/export');
}

export function importWebEvaluationCases(library: WebEvaluationLibraryExport) {
  return request<{ importedCount: number; cases: WebEvaluationCase[] }>('/api/web/evaluation-cases/import', { method: 'POST', body: library });
}

export function createWebEvaluationCase(input: {
  title: string;
  question: string;
  answerable: boolean;
  includeDomains?: string[];
  expectedDomains?: string[];
  evidenceNeeds?: string[];
}) {
  return request<{ case: WebEvaluationCase }>('/api/web/evaluation-cases', { method: 'POST', body: input });
}

export function deleteWebEvaluationCase(id: string) {
  return request<{ id: string }>(`/api/web/evaluation-cases/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listWebEvaluations() {
  return request<{ evaluations: WebEvaluation[] }>('/api/web/evaluations');
}

export function createWebEvaluation(input: { name?: string; caseIds: string[]; k?: number }) {
  return request<{ evaluation: WebEvaluation }>('/api/web/evaluations', { method: 'POST', body: input });
}

export function deleteWebEvaluation(id: string) {
  return request<{ id: string }>(`/api/web/evaluations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function subscribeToWebEvaluation(
  id: string,
  onEvent: (event: WebEvaluationStreamEvent) => void,
  onError: () => void
) {
  const controller = new AbortController();
  const eventNames = new Set<WebEvaluationStreamEvent['type']>(['snapshot', 'progress', 'completed', 'failed']);
  let reachedTerminalEvent = false;
  void consumeSse({
    url: `/api/web/evaluations/${encodeURIComponent(id)}/events`, signal: controller.signal,
    onMessage(message) {
      if (!eventNames.has(message.event as WebEvaluationStreamEvent['type'])) return;
      const parsed = parseSseJson<WebEvaluationStreamEvent>(message);
      const event = { ...parsed, type: message.event } as WebEvaluationStreamEvent;
      if (event.type === 'completed' || event.type === 'failed') reachedTerminalEvent = true;
      onEvent(event);
    }
  }).then(() => {
    if (!reachedTerminalEvent && !controller.signal.aborted) onError();
  }).catch((error: unknown) => {
    if ((error as Error).name !== 'AbortError' && !controller.signal.aborted) onError();
  });
  return () => controller.abort();
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(path, {
    method: init.method,
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const payload = await response.json().catch(() => null) as ApiResponse<T> | null;
  if (!response.ok || payload?.code !== 1 || !payload.data) {
    throw new Error(payload?.message || `请求失败：${response.status}`);
  }
  return payload.data;
}

export type WebEvaluationLibraryExport = {
  schemaVersion: 1;
  exportedAt: string;
  benchmark: { version: number; caseCount: number };
  localCases: Array<WebEvaluationCase & { createdAt: string; updatedAt: string }>;
};
