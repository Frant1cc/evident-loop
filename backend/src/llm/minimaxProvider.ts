import type { ChatCompletionRequest, ChatStreamDelta, LlmProvider } from './contracts.js';
import {
  createOpenAiCompatibleClient,
  LlmProviderApiError
} from './openAiCompatibleClient.js';

const DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1';
const DEFAULT_TIMEOUT_MS = 90_000;

export class MiniMaxApiError extends LlmProviderApiError {
  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super('MiniMax', message, options);
    this.name = 'MiniMaxApiError';
  }
}

export type CreateMiniMaxProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export function createMiniMaxProvider(options: CreateMiniMaxProviderOptions): LlmProvider {
  return createOpenAiCompatibleClient({
    providerName: 'MiniMax',
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? process.env.MINIMAX_BASE_URL ?? DEFAULT_BASE_URL,
    timeoutMs: options.timeoutMs ?? getDefaultTimeoutMs(),
    maxRetries: options.maxRetries,
    // Keep reasoning separate from answer content while preserving reasoning_details in assistant history.
    buildExtraBody: (request) => ({
      reasoning_split: true,
      ...(request.reasoning === undefined
        ? {}
        : { thinking: { type: request.reasoning ? 'adaptive' : 'disabled' } })
    }),
    normalizeStreamChunk: normalizeMiniMaxChunk,
    createError: (message, details) => new MiniMaxApiError(message, details)
  });
}

function normalizeMiniMaxChunk(chunk: unknown, state: Record<string, string>): ChatStreamDelta {
  const delta = getDelta(chunk);
  if (!delta) return {};
  const reasoningDetails = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : [];
  const reasoningText = reasoningDetails
    .map((detail) => detail && typeof detail === 'object' && typeof detail.text === 'string' ? detail.text : '')
    .join('');
  const rawReasoning = reasoningText || (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '');
  const rawContent = typeof delta.content === 'string' ? delta.content : '';
  const reasoning = takeNewText(rawReasoning, state, 'reasoning');
  const content = takeNewText(rawContent, state, 'content');
  return {
    ...(content ? { content } : {}),
    ...(reasoning ? { reasoning } : {})
  };
}

function getDelta(chunk: unknown): Record<string, unknown> | undefined {
  if (!chunk || typeof chunk !== 'object') return undefined;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return undefined;
  const delta = (choices[0] as { delta?: unknown }).delta;
  return delta && typeof delta === 'object' ? delta as Record<string, unknown> : undefined;
}

/** MiniMax streaming fields may be cumulative; accept delta-style fields as a compatibility fallback. */
function takeNewText(current: string, state: Record<string, string>, key: string) {
  if (!current) return '';
  const previous = state[key] ?? '';
  if (current.startsWith(previous)) {
    state[key] = current;
    return current.slice(previous.length);
  }
  state[key] = previous + current;
  return current;
}

function getDefaultTimeoutMs() {
  const configured = Number(process.env.MINIMAX_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 5_000 ? configured : DEFAULT_TIMEOUT_MS;
}
