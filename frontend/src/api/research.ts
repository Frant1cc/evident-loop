import type {
  ResearchConversation,
  ResearchConversationDetail,
  ResearchMessage,
  ResearchNote,
  ResearchPromptPreview,
  ResearchRun,
  ResearchSource,
  ResearchStep
} from '../types/research';
import { consumeSse, parseSseJson } from './sse';

type ApiResponse<T> = {
  code: 0 | 1;
  message: string;
  data: T | null;
};

export type ResearchStreamEvent =
  | { type: 'snapshot'; run: ResearchRun; detail: ResearchConversationDetail }
  | { type: 'research_step'; step: ResearchStep }
  | { type: 'tool_call_started'; step: ResearchStep }
  | { type: 'tool_call_completed'; step: ResearchStep }
  | { type: 'research_source_found'; messageId: string; source: ResearchSource }
  | { type: 'assistant_delta'; messageId: string; content: string }
  | { type: 'research_message_completed'; message: ResearchMessage; sources: ResearchSource[]; promptPreview: ResearchPromptPreview; run: ResearchRun }
  | { type: 'run_updated'; run: ResearchRun }
  | { type: 'error'; message: string; assistantMessage?: ResearchMessage; run: ResearchRun }
  | { type: 'done'; run: ResearchRun };

export type ResearchToolInfo = {
  name: string;
  label: string;
  description: string;
};

export function listResearchTools() {
  return request<{ tools: ResearchToolInfo[] }>('/api/research/tools');
}

export function listResearchConversations() {
  return request<{ conversations: ResearchConversation[] }>('/api/research/conversations');
}

export function createResearchConversation() {
  return request<{ conversation: ResearchConversation }>('/api/research/conversations', { method: 'POST' });
}

export function getResearchConversation(id: string) {
  return request<ResearchConversationDetail>(`/api/research/conversations/${encodeURIComponent(id)}`);
}

export function deleteResearchConversation(id: string) {
  return request<{ deleted: boolean }>(`/api/research/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function createResearchNote(conversationId: string, content: string) {
  return request<{ note: ResearchNote }>(`/api/research/conversations/${encodeURIComponent(conversationId)}/notes`, {
    method: 'POST',
    body: { content }
  });
}

export function updateResearchNote(noteId: string, content: string) {
  return request<{ note: ResearchNote }>(`/api/research/notes/${encodeURIComponent(noteId)}`, {
    method: 'PUT',
    body: { content }
  });
}

export function deleteResearchNote(noteId: string) {
  return request<{ deleted: boolean }>(`/api/research/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
}

export function startResearchMessage(
  conversationId: string,
  content: string,
  allowedTools?: string[]
) {
  return request<{
    run: ResearchRun;
    userMessage: ResearchMessage;
    assistantMessage: ResearchMessage;
    promptPreview: ResearchPromptPreview;
  }>(`/api/research/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: { content, ...(allowedTools ? { allowedTools } : {}) }
  });
}

export function cancelResearchRun(runId: string) {
  return request<{ run: ResearchRun }>(`/api/research/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST'
  });
}

export async function streamResearchRun(
  runId: string,
  onEvent: (event: ResearchStreamEvent) => void,
  signal: AbortSignal
) {
  let reachedTerminalEvent = false;

  await consumeSse({
    url: `/api/research/runs/${encodeURIComponent(runId)}/events`,
    signal,
    onMessage(message) {
      const event = toResearchStreamEvent(message.event, parseSseJson<Record<string, unknown>>(message));
      if (!event) return;
      if (isTerminalEvent(event)) reachedTerminalEvent = true;
      onEvent(event);
    }
  });

  if (!reachedTerminalEvent && !signal.aborted) {
    throw new Error('研究流意外结束，未收到最终结果。');
  }
}

function toResearchStreamEvent(eventName: string, parsed: Record<string, unknown>): ResearchStreamEvent | undefined {
  if (eventName === 'snapshot') {
    return {
      type: eventName,
      run: parsed.run as ResearchRun,
      detail: parsed.detail as ResearchConversationDetail
    };
  }
  if (eventName === 'research_step') return { type: eventName, step: parsed.step as ResearchStep };
  if (eventName === 'tool_call_started') return { type: eventName, step: parsed.step as ResearchStep };
  if (eventName === 'tool_call_completed') return { type: eventName, step: parsed.step as ResearchStep };
  if (eventName === 'research_source_found') return { type: eventName, messageId: String(parsed.messageId), source: parsed.source as ResearchSource };
  if (eventName === 'assistant_delta') return { type: eventName, messageId: String(parsed.messageId), content: String(parsed.content ?? '') };
  if (eventName === 'research_message_completed') {
    return {
      type: eventName,
      message: parsed.message as ResearchMessage,
      sources: parsed.sources as ResearchSource[],
      promptPreview: parsed.promptPreview as ResearchPromptPreview,
      run: parsed.run as ResearchRun
    };
  }
  if (eventName === 'run_updated') return { type: eventName, run: parsed.run as ResearchRun };
  if (eventName === 'error') {
    return {
      type: eventName,
      message: String(parsed.message ?? '请求失败'),
      assistantMessage: parsed.assistantMessage as ResearchMessage | undefined,
      run: parsed.run as ResearchRun
    };
  }
  if (eventName === 'done') return { type: 'done', run: parsed.run as ResearchRun };
  return undefined;
}

function isTerminalEvent(event: ResearchStreamEvent) {
  if (event.type === 'done' || event.type === 'error') return true;
  return event.type === 'snapshot'
    && (event.run.status === 'completed' || event.run.status === 'failed' || event.run.status === 'cancelled');
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
