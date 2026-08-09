import { Router } from 'express';

import { failure, success } from '../response.js';
import {
  createChatConversation,
  createChatMessage,
  createConversationTitle,
  deleteChatConversation,
  getChatConversation,
  getChatConversationDetail,
  listChatConversations,
  listChatMessages,
  updateChatConversationTitle,
  updateChatMessage
} from '../chat/store.js';
import type { ChatMessage } from '../chat/types.js';
import { createSseStream, parseSseChunk, type SseStream } from '../sse.js';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const CHAT_TIMEOUT_MS = 90_000;

type DeepSeekMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type DeepSeekChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
};

export const chatRouter = Router();

chatRouter.post('/chat', (req, res) => {
  const message = String(req.body?.message ?? '').trim();

  if (!message) {
    res.status(400).json(failure('message is required'));
    return;
  }

  res.json(
    success({
      reply: `Agent received: ${message}`,
      createdAt: new Date().toISOString()
    })
  );
});

chatRouter.get('/chat/conversations', (_req, res) => {
  res.json(success({ conversations: listChatConversations() }));
});

chatRouter.post('/chat/conversations', (_req, res) => {
  res.status(201).json(success({ conversation: createChatConversation() }));
});

chatRouter.get('/chat/conversations/:conversationId', (req, res) => {
  const detail = getChatConversationDetail(req.params.conversationId);
  if (!detail) {
    res.status(404).json(failure('Chat conversation not found'));
    return;
  }

  res.json(success(detail));
});

chatRouter.delete('/chat/conversations/:conversationId', (req, res) => {
  if (!deleteChatConversation(req.params.conversationId)) {
    res.status(404).json(failure('Chat conversation not found'));
    return;
  }

  res.json(success({ deleted: true }));
});

chatRouter.post('/chat/conversations/:conversationId/messages/stream', async (req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(500).json(failure('DEEPSEEK_API_KEY is not configured'));
    return;
  }

  const conversationId = req.params.conversationId;
  let conversation = getChatConversation(conversationId);
  if (!conversation) {
    res.status(404).json(failure('Chat conversation not found'));
    return;
  }

  const content = String(req.body?.content ?? '').trim();
  if (!content) {
    res.status(400).json(failure('content is required'));
    return;
  }

  if (conversation.title === '新会话') {
    conversation = updateChatConversationTitle(conversationId, createConversationTitle(content)) ?? conversation;
  }

  const contextMessages = toDeepSeekMessages(listChatMessages(conversationId));
  const userMessage = createChatMessage({ conversationId, role: 'user', content, status: 'complete' });
  const assistantMessage = createChatMessage({ conversationId, role: 'assistant', content: '', status: 'streaming' });

  const stream = createSseStream(res);
  stream.send('chat_message_started', { userMessage, message: assistantMessage });
  stream.send('ready', {});

  const abortController = new AbortController();
  let finished = false;
  let reply = '';
  const abortRequest = () => abortController.abort(new Error('Chat request was cancelled'));
  req.once('aborted', abortRequest);
  stream.onClose(() => {
    if (!finished) abortRequest();
  });
  const timeout = setTimeout(() => abortController.abort(new Error('Chat request timed out')), CHAT_TIMEOUT_MS);

  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
        messages: [...contextMessages, { role: 'user', content }],
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: process.env.DEEPSEEK_THINKING === 'enabled' ? 'enabled' : 'disabled' }
      }),
      signal: abortController.signal
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      throw new Error(errorText || `DeepSeek request failed with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = processDeepSeekBuffer(buffer, stream, (delta) => {
        reply += delta;
      });
    }

    buffer += decoder.decode();
    processDeepSeekBuffer(`${buffer}\n\n`, stream, (delta) => {
      reply += delta;
    });

    const completedMessage = updateChatMessage(assistantMessage.id, { content: reply, status: 'complete' });
    if (!completedMessage) throw new Error('Chat assistant message could not be completed');
    stream.send('done', { message: completedMessage });
    finished = true;
    stream.close();
  } catch (error) {
    const message = getFailureMessage(error, abortController.signal);
    const failedMessage = updateChatMessage(assistantMessage.id, {
      content: reply || message,
      status: 'error'
    });

    if (!stream.closed) {
      stream.send('error', { message, assistantMessage: failedMessage });
      finished = true;
      stream.close();
    }
  } finally {
    clearTimeout(timeout);
    req.off('aborted', abortRequest);
  }
});

function toDeepSeekMessages(messages: ChatMessage[]): DeepSeekMessage[] {
  return messages
    .filter((message) => message.status === 'complete' && message.content.trim())
    .map((message) => ({ role: message.role, content: message.content }));
}

function processDeepSeekBuffer(buffer: string, stream: SseStream, onMessage: (content: string) => void) {
  return parseSseChunk(buffer, ({ data }) => {
    if (!data || data === '[DONE]') return;

    let chunk: DeepSeekChunk;
    try {
      chunk = JSON.parse(data) as DeepSeekChunk;
    } catch {
      throw new Error('Failed to parse DeepSeek stream chunk');
    }

    const delta = chunk.choices?.[0]?.delta;
    if (delta?.reasoning_content) stream.send('reasoning', { content: delta.reasoning_content });
    if (delta?.content) {
      onMessage(delta.content);
      stream.send('message', { content: delta.content });
    }
  });
}

function getFailureMessage(error: unknown, signal: AbortSignal) {
  const reason = signal.reason instanceof Error ? signal.reason.message : '';
  if (reason.includes('timed out')) return '对话请求超时，请稍后重试。';
  if (signal.aborted) return '对话请求已取消。';
  return error instanceof Error ? error.message : 'DeepSeek stream failed';
}
