import type { FetchPageResult } from '../../tools/fetchPageTool.js';
import type { WebSearchOptions, WebSearchResult } from '../../tools/webSearchTool.js';
import type { ProviderAttempt, RetrievalCapability } from '../types.js';

export type SearchProviderRequest = {
  query: string;
  limit: number;
  options: WebSearchOptions;
  signal?: AbortSignal;
};

export type FetchProviderRequest = {
  url: string;
  query?: string;
  maxChunks: number;
  signal?: AbortSignal;
};

export type SearchProvider = {
  id: string;
  capability: 'web_search' | 'docs_search';
  configured(): boolean;
  search(request: SearchProviderRequest): Promise<WebSearchResult[]>;
};

export type FetchProvider = {
  id: string;
  capability: 'web_fetch';
  configured(): boolean;
  fetch(request: FetchProviderRequest): Promise<FetchPageResult>;
};

export type ProviderExecution<T> = {
  value?: T;
  provider?: string;
  attempts: ProviderAttempt[];
};

export class ProviderHttpError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function classifyProviderError(error: unknown): ProviderAttempt['status'] {
  if (error instanceof ProviderHttpError) {
    if (error.status === 401 || error.status === 403) return 'auth_error';
    if (error.status === 429) return 'rate_limited';
    if (error.status >= 500) return 'provider_error';
  }
  if (error instanceof Error) {
    if (/timeout|timed out|abort/i.test(error.message)) return 'timeout';
    if (/\b429\b|rate.?limit/i.test(error.message)) return 'rate_limited';
    if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid api key/i.test(error.message)) return 'auth_error';
  }
  return 'provider_error';
}

export function attempt(
  capability: RetrievalCapability,
  provider: string,
  status: ProviderAttempt['status'],
  durationMs: number,
  resultCount = 0,
  reason?: string
): ProviderAttempt {
  return {
    capability,
    provider,
    status,
    durationMs,
    resultCount,
    ...(reason ? { reason: reason.slice(0, 500) } : {})
  };
}
