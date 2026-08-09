import type { LlmProvider } from './contracts.js';
import { createDeepSeekProvider } from './deepseekProvider.js';

export type LlmProviderSelection = {
  llm?: LlmProvider;
  /** Compatibility path for callers that have not moved provider construction to the composition root. */
  apiKey?: string;
};

export function resolveLlmProvider(selection: LlmProviderSelection): LlmProvider {
  if (selection.llm) return selection.llm;
  if (selection.apiKey) return createDeepSeekProvider({ apiKey: selection.apiKey });
  throw new Error('An LLM provider is required');
}
