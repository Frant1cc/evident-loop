import type { ChatConversation, ChatConversationDetail, ChatMessage } from '../types/chat';
import { consumeSse, parseSseJson } from './sse';

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
  let reachedTerminalEvent = false;

  await consumeSse({
    url: `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
    method: 'POST',
    body: { content },
    signal,
    onMessage(message) {
      const event = toChatStreamEvent(message.event, parseSseJson<Record<string, unknown>>(message));
      if (!event) return;
      if (event.type === 'done' || event.type === 'error') reachedTerminalEvent = true;
      onEvent(event);
    }
  });

  if (!reachedTerminalEvent && !signal.aborted) throw new Error('对话流意外结束，未收到最终结果。');
}

function toChatStreamEvent(eventName: string, parsed: Record<string, unknown>): ChatStreamEvent | undefined {
  if (eventName === 'chat_message_started') {
    return {
      type: eventName,
      message: parsed.message as ChatMessage,
      userMessage: parsed.userMessage as ChatMessage
    };
  }
  if (eventName === 'ready') return { type: 'ready' };
  if (eventName === 'reasoning') return { type: 'reasoning', content: String(parsed.content ?? '') };
  if (eventName === 'message') return { type: 'message', content: String(parsed.content ?? '') };
  if (eventName === 'error') {
    return {
      type: eventName,
      message: String(parsed.message ?? '请求失败'),
      assistantMessage: parsed.assistantMessage as ChatMessage | undefined
    };
  }
  if (eventName === 'done') return { type: 'done', message: parsed.message as ChatMessage };
  return undefined;
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
