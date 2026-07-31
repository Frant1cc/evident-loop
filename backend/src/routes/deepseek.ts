import { Router } from 'express';

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

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const abortController = new AbortController();
  req.on('aborted', () => abortController.abort());
  sendEvent(res, 'ready', {});

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
      sendEvent(res, 'error', {
        message: errorText || `DeepSeek request failed with status ${response.status}`
      });
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = processSseBuffer(buffer, res);
    }

    buffer += decoder.decode();
    processSseBuffer(`${buffer}\n\n`, res);
    sendEvent(res, 'done', {});
    res.end();
  } catch (error) {
    if (abortController.signal.aborted) return;

    sendEvent(res, 'error', {
      message: error instanceof Error ? error.message : 'DeepSeek stream failed'
    });
    res.end();
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

function processSseBuffer(buffer: string, res: Parameters<typeof sendEvent>[0]) {
  const events = buffer.split('\n\n');
  const rest = events.pop() ?? '';

  for (const event of events) {
    const dataLines = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());

    if (!dataLines.length) continue;

    const data = dataLines.join('\n');

    if (data === '[DONE]') continue;

    try {
      const chunk = JSON.parse(data) as DeepSeekChunk;
      const delta = chunk.choices?.[0]?.delta;

      if (delta?.reasoning_content) {
        sendEvent(res, 'reasoning', { content: delta.reasoning_content });
      }

      if (delta?.content) {
        sendEvent(res, 'message', { content: delta.content });
      }
    } catch {
      sendEvent(res, 'error', { message: 'Failed to parse DeepSeek stream chunk' });
    }
  }

  return rest;
}

function sendEvent(res: { write: (chunk: string) => void }, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
