import { Router } from 'express';

import { createSseStream, parseSseChunk, type SseStream } from '../sse.js';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';

type ChatRole = 'system' | 'user' | 'assistant';

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type DeepSeekChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
};

export const deepseekRouter = Router();

deepseekRouter.post('/deepseek/chat/stream', async (req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    res.status(500).json({ code: 0, message: 'DEEPSEEK_API_KEY is not configured', data: null });
    return;
  }

  const messages = parseMessages(req.body);
  const thinkingEnabled = parseThinkingEnabled(req.body);

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
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        thinking: {
          type: thinkingEnabled ? 'enabled' : 'disabled'
        }
      }),
      signal: abortController.signal
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      stream.send('error', {
        message: errorText || `DeepSeek request failed with status ${response.status}`
      });
      stream.close();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = processDeepSeekBuffer(buffer, stream);
    }

    buffer += decoder.decode();
    processDeepSeekBuffer(`${buffer}\n\n`, stream);
    stream.send('done', {});
    stream.close();
  } catch (error) {
    if (abortController.signal.aborted) return;

    stream.send('error', {
      message: error instanceof Error ? error.message : 'DeepSeek stream failed'
    });
    stream.close();
  }
});

function parseMessages(body: unknown): ChatMessage[] {
  if (!body || typeof body !== 'object') return [];

  const payload = body as { message?: unknown; messages?: unknown };

  if (Array.isArray(payload.messages)) {
    return payload.messages.filter(isChatMessage);
  }

  if (typeof payload.message === 'string' && payload.message.trim()) {
    return [{ role: 'user', content: payload.message.trim() }];
  }

  return [];
}

function parseThinkingEnabled(body: unknown) {
  if (!body || typeof body !== 'object') return process.env.DEEPSEEK_THINKING === 'enabled';

  const payload = body as { thinking?: unknown };

  if (typeof payload.thinking === 'boolean') return payload.thinking;

  return process.env.DEEPSEEK_THINKING === 'enabled';
}

function isChatMessage(message: unknown): message is ChatMessage {
  if (!message || typeof message !== 'object') return false;

  const candidate = message as Partial<ChatMessage>;
  return (
    (candidate.role === 'system' || candidate.role === 'user' || candidate.role === 'assistant') &&
    typeof candidate.content === 'string' &&
    candidate.content.trim().length > 0
  );
}

function processDeepSeekBuffer(buffer: string, stream: SseStream) {
  return parseSseChunk(buffer, ({ data }) => {
    if (data === '[DONE]') return;

    try {
      const chunk = JSON.parse(data) as DeepSeekChunk;
      const delta = chunk.choices?.[0]?.delta;

      if (delta?.reasoning_content) {
        stream.send('reasoning', { content: delta.reasoning_content });
      }

      if (delta?.content) {
        stream.send('message', { content: delta.content });
      }
    } catch {
      stream.send('error', { message: 'Failed to parse DeepSeek stream chunk' });
    }
  });
}
