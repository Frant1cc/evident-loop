import type { AgentEvent, AgentTask, AgentTaskDetail } from '../types/tasks';

type ApiResponse<T> = {
  code: 0 | 1;
  message: string;
  data: T | null;
};

export function listAgentTasks() {
  return request<{ tasks: AgentTask[] }>('/api/tasks');
}

export function createAgentTask(input: {
  goal: string;
  maxSteps: number;
  maxTokens: number;
  allowedTools: string[];
}) {
  return request<AgentTaskDetail>('/api/tasks', { method: 'POST', body: input });
}

export function getAgentTask(id: string) {
  return request<AgentTaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);
}

export function getAgentTaskEvents(id: string) {
  return request<{ events: AgentEvent[] }>(`/api/tasks/${encodeURIComponent(id)}/events`);
}

export function deleteAgentTask(id: string) {
  return request<{ id: string }>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function planAgentTask(id: string) {
  return request<AgentTaskDetail>(`/api/tasks/${encodeURIComponent(id)}/plan`, { method: 'POST' });
}

export function approveAgentTask(id: string) {
  return request<AgentTaskDetail>(`/api/tasks/${encodeURIComponent(id)}/approve`, { method: 'POST' });
}

export function runAgentTask(id: string, signal?: AbortSignal) {
  return request<AgentTaskDetail>(`/api/tasks/${encodeURIComponent(id)}/run`, { method: 'POST', signal });
}

export function finalizeAgentTask(id: string) {
  return request<AgentTaskDetail>(`/api/tasks/${encodeURIComponent(id)}/finalize`, { method: 'POST' });
}

export function retryAgentTaskStep(taskId: string, stepId: string) {
  return request<AgentTaskDetail>(
    `/api/tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}/retry`,
    { method: 'POST' }
  );
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
  const response = await fetch(path, {
    method: init.method,
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal
  });
  const payload = await response.json().catch(() => null) as ApiResponse<T> | null;
  if (!response.ok || payload?.code !== 1 || !payload.data) {
    throw new Error(payload?.message || `请求失败：${response.status}`);
  }
  return payload.data;
}
