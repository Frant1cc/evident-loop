import { Router } from 'express';

import { createConfiguredLlm } from '../llm/config.js';
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
import { createSseStream } from '../sse.js';

const CHAT_TIMEOUT_MS = 90_000;

type ProviderMessage = {
  role: 'user' | 'assistant';
  content: string;
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
  const configuredLlm = createConfiguredLlm();
  if (!configuredLlm.llm) {
    res.status(500).json(failure(`${configuredLlm.providerName} API key is not configured`));
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

  const contextMessages = toProviderMessages(listChatMessages(conversationId));
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
    await configuredLlm.llm.stream({
      model: configuredLlm.model,
      messages: [...contextMessages, { role: 'user', content }],
      reasoning: getReasoningEnabled(),
      signal: abortController.signal
    }, (delta) => {
      if (delta.reasoning) stream.send('reasoning', { content: delta.reasoning });
      if (delta.content) {
        reply += delta.content;
        stream.send('message', { content: delta.content });
      }
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

function toProviderMessages(messages: ChatMessage[]): ProviderMessage[] {
  return messages
    .filter((message) => message.status === 'complete' && message.content.trim())
    .map((message) => ({ role: message.role, content: message.content }));
}

function getFailureMessage(error: unknown, signal: AbortSignal) {
  const reason = signal.reason instanceof Error ? signal.reason.message : '';
  if (reason.includes('timed out')) return '对话请求超时，请稍后重试。';
  if (signal.aborted) return '对话请求已取消。';
  return error instanceof Error ? error.message : 'LLM stream failed';
}

function getReasoningEnabled() {
  const configured = process.env.LLM_REASONING?.trim().toLowerCase();
  if (configured) return ['1', 'true', 'on', 'yes', 'enabled'].includes(configured);
  return process.env.DEEPSEEK_THINKING === 'enabled';
}
