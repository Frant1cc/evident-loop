import type { RagEvaluation, RagEvaluationStreamEvent } from '../types/evaluations';
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
