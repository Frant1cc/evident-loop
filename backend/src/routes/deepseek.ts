import { Router } from 'express';

import { createConfiguredLlm } from '../llm/config.js';
import type { ChatMessage } from '../llm/contracts.js';
import { createSseStream } from '../sse.js';

export const deepseekRouter = Router();

// Keep the legacy DeepSeek path for frontend compatibility while exposing a provider-neutral alias.
deepseekRouter.post(['/llm/chat/stream', '/deepseek/chat/stream'], async (req, res) => {
  const configuredLlm = createConfiguredLlm();
  if (!configuredLlm.llm) {
    res.status(500).json({
      code: 0,
      message: `${configuredLlm.providerName} API key is not configured`,
      data: null
    });
    return;
  }

  const messages = parseMessages(req.body);
  if (!messages.length) {
    res.status(400).json({ code: 0, message: 'message or messages is required', data: null });
    return;
  }

  const stream = createSseStream(res);
  const abortController = new AbortController();
  req.on('aborted', () => abortController.abort());
  stream.onClose(() => abortController.abort());
  stream.send('ready', {});

  try {
    await configuredLlm.llm.stream({
      model: configuredLlm.model,
      messages,
      reasoning: parseReasoningEnabled(req.body),
      signal: abortController.signal
    }, (delta) => {
      if (delta.reasoning) stream.send('reasoning', { content: delta.reasoning });
      if (delta.content) stream.send('message', { content: delta.content });
    });
    stream.send('done', {});
    stream.close();
  } catch (error) {
    if (abortController.signal.aborted) return;
    stream.send('error', { message: error instanceof Error ? error.message : 'LLM stream failed' });
    stream.close();
  }
});

function parseMessages(body: unknown): ChatMessage[] {
  if (!body || typeof body !== 'object') return [];
  const payload = body as { message?: unknown; messages?: unknown };
  if (Array.isArray(payload.messages)) return payload.messages.filter(isChatMessage);
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return [{ role: 'user', content: payload.message.trim() }];
  }
  return [];
}

function parseReasoningEnabled(body: unknown) {
  if (body && typeof body === 'object' && typeof (body as { thinking?: unknown }).thinking === 'boolean') {
    return (body as { thinking: boolean }).thinking;
  }
  const configured = process.env.LLM_REASONING?.trim().toLowerCase();
  if (configured) return ['1', 'true', 'on', 'yes', 'enabled'].includes(configured);
  return process.env.DEEPSEEK_THINKING === 'enabled';
}

function isChatMessage(message: unknown): message is ChatMessage {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as Partial<ChatMessage>;
  return (
    (candidate.role === 'system' || candidate.role === 'user' || candidate.role === 'assistant')
    && typeof candidate.content === 'string'
    && candidate.content.trim().length > 0
  );
}
