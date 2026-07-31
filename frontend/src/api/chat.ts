import type { ChatConversation, ChatConversationDetail, ChatMessage } from '../types/chat';

type ApiResponse<T> = {
  code: 0 | 1;
  message: string;
  data: T | null;
};

export type ChatStreamEvent =
  | { type: 'chat_message_started'; message: ChatMessage; userMessage: ChatMessage }
  | { type: 'ready' }
  | { type: 'reasoning'; content: string }
  | { type: 'message'; content: string }
  | { type: 'error'; message: string; assistantMessage?: ChatMessage }
  | { type: 'done'; message: ChatMessage };

export function listChatConversations() {
  return request<{ conversations: ChatConversation[] }>('/api/chat/conversations');
}

export function createChatConversation() {
  return request<{ conversation: ChatConversation }>('/api/chat/conversations', { method: 'POST' });
}

export function getChatConversation(id: string) {
  return request<ChatConversationDetail>(`/api/chat/conversations/${encodeURIComponent(id)}`);
}

export function deleteChatConversation(id: string) {
  return request<{ deleted: boolean }>(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function streamChatMessage(
  conversationId: string,
  content: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal
) {
  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/messages/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
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
      if (event.type === 'done' || event.type === 'error') reachedTerminalEvent = true;
      onEvent(event);
    });
  }

  buffer += decoder.decode();
  processSseBuffer(`${buffer}\n\n`, (event) => {
    if (event.type === 'done' || event.type === 'error') reachedTerminalEvent = true;
    onEvent(event);
  });

  if (!reachedTerminalEvent && !signal.aborted) throw new Error('对话流意外结束，未收到最终结果。');
}

function processSseBuffer(buffer: string, onEvent: (event: ChatStreamEvent) => void) {
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

    if (eventName === 'chat_message_started') {
      onEvent({
        type: eventName,
        message: parsed.message as ChatMessage,
        userMessage: parsed.userMessage as ChatMessage
      });
    }
    if (eventName === 'ready') onEvent({ type: 'ready' });
    if (eventName === 'reasoning') onEvent({ type: 'reasoning', content: String(parsed.content ?? '') });
    if (eventName === 'message') onEvent({ type: 'message', content: String(parsed.content ?? '') });
    if (eventName === 'error') {
      onEvent({
        type: eventName,
        message: String(parsed.message ?? '请求失败'),
        assistantMessage: parsed.assistantMessage as ChatMessage | undefined
      });
    }
    if (eventName === 'done') onEvent({ type: 'done', message: parsed.message as ChatMessage });
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
