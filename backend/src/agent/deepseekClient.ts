import type { ChatMessage, DeepSeekChatResponse } from './types.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

export class DeepSeekApiError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'DeepSeekApiError';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export type CreateChatCompletionOptions = {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  toolChoice?: 'auto';
  temperature?: number;
  signal?: AbortSignal;
  /** Per-attempt timeout in milliseconds. Defaults to 60s. */
  timeoutMs?: number;
  /** Max retries for retryable failures (429/5xx/timeout/network error). Defaults to 3. */
  maxRetries?: number;
  /** Overrides the API base URL. Defaults to DEEPSEEK_BASE_URL env var or the official endpoint. */
  baseUrl?: string;
};

export async function createDeepSeekChatCompletion(
  options: CreateChatCompletionOptions
): Promise<DeepSeekChatResponse> {
  const { signal, maxRetries = DEFAULT_MAX_RETRIES } = options;

  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);

    try {
      return await requestChatCompletion(options);
    } catch (error) {
      // External cancellation always wins over retry logic.
      if (signal?.aborted) throw abortReason(signal);

      const apiError = toDeepSeekApiError(error);
      if (!apiError.retryable || attempt >= maxRetries) throw apiError;

      await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt, signal);
    }
  }
}

async function requestChatCompletion({
  apiKey,
  model,
  messages,
  tools,
  toolChoice,
  temperature,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baseUrl
}: CreateChatCompletionOptions): Promise<DeepSeekChatResponse> {
  const resolvedBaseUrl = baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;

  try {
    response = await fetch(`${resolvedBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(temperature !== undefined ? { temperature } : {})
      }),
      signal: requestSignal
    });
  } catch (error) {
    // Rethrow external aborts untouched so callers can tell cancellation from failure.
    if (signal?.aborted) throw error;

    if (timeoutSignal.aborted) {
      throw new DeepSeekApiError(`DeepSeek request timed out after ${timeoutMs}ms`, { retryable: true });
    }

    throw new DeepSeekApiError(
      error instanceof Error ? `DeepSeek request failed: ${error.message}` : 'DeepSeek request failed',
      { retryable: true }
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new DeepSeekApiError(errorText || `DeepSeek request failed with status ${response.status}`, {
      status: response.status,
      retryable: RETRYABLE_STATUS_CODES.has(response.status)
    });
  }

  try {
    return (await response.json()) as DeepSeekChatResponse;
  } catch {
    throw new DeepSeekApiError('DeepSeek returned an invalid JSON response', {
      status: response.status,
      retryable: true
    });
  }
}

function toDeepSeekApiError(error: unknown): DeepSeekApiError {
  if (error instanceof DeepSeekApiError) return error;
  return new DeepSeekApiError(error instanceof Error ? error.message : 'DeepSeek request failed', {
    retryable: false
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error('DeepSeek request was aborted');
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortReason(signal);
}
