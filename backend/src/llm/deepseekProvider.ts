import type { ChatCompletionRequest, LlmProvider } from './contracts.js';
import {
  createOpenAiCompatibleClient,
  LlmProviderApiError
} from './openAiCompatibleClient.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 60_000;

export class DeepSeekApiError extends LlmProviderApiError {
  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super('DeepSeek', message, options);
    this.name = 'DeepSeekApiError';
  }
}

export type CreateDeepSeekProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export function createDeepSeekProvider(options: CreateDeepSeekProviderOptions): LlmProvider {
  return createOpenAiCompatibleClient({
    providerName: 'DeepSeek',
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
    timeoutMs: options.timeoutMs ?? getDefaultTimeoutMs(),
    maxRetries: options.maxRetries,
    buildExtraBody: (request) => request.reasoning === undefined
      ? {}
      : { thinking: { type: request.reasoning ? 'enabled' : 'disabled' } },
    createError: (message, details) => new DeepSeekApiError(message, details)
  });
}

function getDefaultTimeoutMs() {
  const configured = Number(process.env.DEEPSEEK_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 5_000 ? configured : DEFAULT_TIMEOUT_MS;
}
