import { parseSseChunk } from '../sse.js';
import type {
  ChatCompletion,
  ChatCompletionRequest,
  ChatStreamDelta,
  LlmProvider
} from './contracts.js';

const DEFAULT_MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

export class LlmProviderApiError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(provider: string, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'LlmProviderApiError';
    this.provider = provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export type OpenAiCompatibleClientOptions = {
  providerName: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries?: number;
  buildExtraBody?: (request: ChatCompletionRequest, stream: boolean) => Record<string, unknown>;
  normalizeStreamChunk?: (chunk: unknown, state: Record<string, string>) => ChatStreamDelta;
  createError?: (message: string, options?: { status?: number; retryable?: boolean }) => LlmProviderApiError;
};

export function createOpenAiCompatibleClient(options: OpenAiCompatibleClientOptions): LlmProvider {
  const createError = options.createError
    ?? ((message: string, details?: { status?: number; retryable?: boolean }) =>
      new LlmProviderApiError(options.providerName, message, details));

  return {
    complete: async (request) => {
      const response = await requestWithRetries(options, request, false, createError);
      const rawBody = await response.text();
      try {
        return JSON.parse(rawBody) as ChatCompletion;
      } catch {
        throw createError(invalidJsonMessage(options.providerName, response, rawBody), {
          status: response.status,
          retryable: true
        });
      }
    },
    stream: async (request, onDelta) => {
      const response = await requestWithRetries(options, request, true, createError);
      if (!response.body) throw createError(`${options.providerName} returned an empty stream`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const state: Record<string, string> = {};
      let buffer = '';

      const process = (input: string) => parseSseChunk(input, ({ data }) => {
        if (!data || data === '[DONE]') return;
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          throw createError(`Failed to parse ${options.providerName} stream chunk`);
        }
        const delta = options.normalizeStreamChunk
          ? options.normalizeStreamChunk(chunk, state)
          : normalizeOpenAiDelta(chunk);
        if (delta.content || delta.reasoning) onDelta(delta);
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = process(buffer);
      }
      buffer += decoder.decode();
      process(`${buffer}\n\n`);
    }
  };
}

async function requestWithRetries(
  options: OpenAiCompatibleClientOptions,
  request: ChatCompletionRequest,
  stream: boolean,
  createError: NonNullable<OpenAiCompatibleClientOptions['createError']>
) {
  const maxRetries = request.maxRetries ?? options.maxRetries ?? DEFAULT_MAX_RETRIES;
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(request.signal, options.providerName);
    try {
      return await requestOnce(options, request, stream, createError);
    } catch (error) {
      if (request.signal?.aborted) throw abortReason(request.signal, options.providerName);
      const apiError = error instanceof LlmProviderApiError
        ? error
        : createError(error instanceof Error ? error.message : `${options.providerName} request failed`);
      if (!apiError.retryable || attempt >= maxRetries) throw apiError;
      await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt, request.signal, options.providerName);
    }
  }
}

async function requestOnce(
  options: OpenAiCompatibleClientOptions,
  request: ChatCompletionRequest,
  stream: boolean,
  createError: NonNullable<OpenAiCompatibleClientOptions['createError']>
) {
  const timeoutMs = request.timeoutMs ?? options.timeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;

  try {
    response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        ...(options.buildExtraBody?.(request, stream) ?? {})
      }),
      signal: requestSignal
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    if (timeoutSignal.aborted) {
      throw createError(`${options.providerName} request timed out after ${timeoutMs}ms`, { retryable: true });
    }
    throw createError(
      error instanceof Error ? `${options.providerName} request failed: ${error.message}` : `${options.providerName} request failed`,
      { retryable: true }
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw createError(errorText || `${options.providerName} request failed with status ${response.status}`, {
      status: response.status,
      retryable: RETRYABLE_STATUS_CODES.has(response.status)
    });
  }
  return response;
}

function normalizeOpenAiDelta(chunk: unknown): ChatStreamDelta {
  if (!chunk || typeof chunk !== 'object') return {};
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return {};
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (!delta || typeof delta !== 'object') return {};
  const value = delta as { content?: unknown; reasoning_content?: unknown };
  return {
    ...(typeof value.content === 'string' ? { content: value.content } : {}),
    ...(typeof value.reasoning_content === 'string' ? { reasoning: value.reasoning_content } : {})
  };
}

function invalidJsonMessage(providerName: string, response: Response, rawBody: string) {
  const contentType = response.headers.get('content-type') ?? 'unknown';
  const preview = rawBody.slice(0, 500);
  return `${providerName} returned invalid JSON (status ${response.status}, content-type ${contentType}, ${rawBody.length} bytes): ${preview || '<empty body>'}`;
}

function sleep(ms: number, signal: AbortSignal | undefined, providerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal, providerName));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal, providerName));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal | undefined, providerName: string) {
  return signal?.reason instanceof Error ? signal.reason : new Error(`${providerName} request was aborted`);
}

function throwIfAborted(signal: AbortSignal | undefined, providerName: string) {
  if (signal?.aborted) throw abortReason(signal, providerName);
}
