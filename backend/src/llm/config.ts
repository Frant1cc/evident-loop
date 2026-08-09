import type { LlmProvider } from './contracts.js';
import { createDeepSeekProvider } from './deepseekProvider.js';
import { createMiniMaxProvider } from './minimaxProvider.js';

export type LlmProviderName = 'deepseek' | 'minimax';

export type ConfiguredLlm = {
  providerName: LlmProviderName;
  model: string;
  llm?: LlmProvider;
};

export function createConfiguredLlm(env: NodeJS.ProcessEnv = process.env): ConfiguredLlm {
  const providerName = getProviderName(env);
  const genericModel = env.LLM_MODEL?.trim();

  if (providerName === 'minimax') {
    const apiKey = env.MINIMAX_API_KEY?.trim();
    return {
      providerName,
      model: genericModel || env.MINIMAX_MODEL?.trim() || 'MiniMax-M3',
      llm: apiKey ? createMiniMaxProvider({
        apiKey,
        baseUrl: env.MINIMAX_BASE_URL?.trim() || undefined,
        timeoutMs: parseTimeout(env.MINIMAX_REQUEST_TIMEOUT_MS)
      }) : undefined
    };
  }

  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  return {
    providerName,
    model: genericModel || env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash',
    llm: apiKey ? createDeepSeekProvider({
      apiKey,
      baseUrl: env.DEEPSEEK_BASE_URL?.trim() || undefined,
      timeoutMs: parseTimeout(env.DEEPSEEK_REQUEST_TIMEOUT_MS)
    }) : undefined
  };
}

function getProviderName(env: NodeJS.ProcessEnv): LlmProviderName {
  const configured = env.LLM_PROVIDER?.trim().toLowerCase();
  if (!configured) return env.MINIMAX_API_KEY && !env.DEEPSEEK_API_KEY ? 'minimax' : 'deepseek';
  if (configured === 'deepseek' || configured === 'minimax') return configured;
  throw new Error(`Unsupported LLM_PROVIDER: ${configured}`);
}

function parseTimeout(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 5_000 ? parsed : undefined;
}
