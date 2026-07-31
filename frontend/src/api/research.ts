import type {
  ResearchConversation,
  ResearchConversationDetail,
  ResearchMessage,
  ResearchNote,
  ResearchPromptPreview,
  ResearchSource,
  ResearchStep
} from '../types/research';

type ApiResponse<T> = {
  code: 0 | 1;
  message: string;
  data: T | null;
};

export type ResearchStreamEvent =
  | { type: 'research_message_started'; message: ResearchMessage; userMessage?: ResearchMessage }
  | { type: 'research_step'; step: ResearchStep }
  | { type: 'tool_call_started'; step: ResearchStep }
  | { type: 'tool_call_completed'; step: ResearchStep }
  | { type: 'research_source_found'; messageId: string; source: ResearchSource }
  | { type: 'assistant_delta'; messageId: string; content: string }
  | { type: 'research_message_completed'; message: ResearchMessage; sources: ResearchSource[]; promptPreview: ResearchPromptPreview }
  | { type: 'error'; message: string; assistantMessage?: ResearchMessage }
  | { type: 'done' };

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

export async function streamResearchMessage(
  conversationId: string,
  content: string,
  onEvent: (event: ResearchStreamEvent) => void,
  signal: AbortSignal,
  allowedTools?: string[]
) {
  const response = await fetch(`/api/research/conversations/${encodeURIComponent(conversationId)}/messages/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, ...(allowedTools ? { allowedTools } : {}) }),
    signal
  });

  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null) as ApiResponse<never> | null;
    throw new Error(payload?.message ?? `请求失败：${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reachedTerminalEvent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = processSseBuffer(buffer, (event) => {
      if (event.type === 'done' || event.type === 'error' || event.type === 'research_message_completed') reachedTerminalEvent = true;
      onEvent(event);
    });
  }

  buffer += decoder.decode();
  processSseBuffer(`${buffer}\n\n`, (event) => {
    if (event.type === 'done' || event.type === 'error' || event.type === 'research_message_completed') reachedTerminalEvent = true;
    onEvent(event);
  });

  if (!reachedTerminalEvent && !signal.aborted) {
    throw new Error('研究流意外结束，未收到最终结果。');
  }
}

function processSseBuffer(buffer: string, onEvent: (event: ResearchStreamEvent) => void) {
  const events = buffer.split('\n\n');
  const rest = events.pop() ?? '';

  for (const event of events) {
    const eventName = event
      .split('\n')
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');

    if (!eventName || !data) continue;
    const parsed = JSON.parse(data) as Record<string, unknown>;

    if (eventName === 'research_message_started') {
      onEvent({
        type: eventName,
        message: parsed.message as ResearchMessage,
        userMessage: parsed.userMessage as ResearchMessage | undefined
      });
    }
    if (eventName === 'research_step') onEvent({ type: eventName, step: parsed.step as ResearchStep });
    if (eventName === 'tool_call_started') onEvent({ type: eventName, step: parsed.step as ResearchStep });
    if (eventName === 'tool_call_completed') onEvent({ type: eventName, step: parsed.step as ResearchStep });
    if (eventName === 'research_source_found') onEvent({ type: eventName, messageId: String(parsed.messageId), source: parsed.source as ResearchSource });
    if (eventName === 'assistant_delta') onEvent({ type: eventName, messageId: String(parsed.messageId), content: String(parsed.content ?? '') });
    if (eventName === 'research_message_completed') {
      onEvent({
        type: eventName,
        message: parsed.message as ResearchMessage,
        sources: parsed.sources as ResearchSource[],
        promptPreview: parsed.promptPreview as ResearchPromptPreview
      });
    }
    if (eventName === 'error') {
      onEvent({
        type: eventName,
        message: String(parsed.message ?? '请求失败'),
        assistantMessage: parsed.assistantMessage as ResearchMessage | undefined
      });
    }
    if (eventName === 'done') onEvent({ type: 'done' });
  }

  return rest;
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
