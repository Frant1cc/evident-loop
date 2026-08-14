import type { FetchPageResult } from '../../tools/fetchPageTool.js';
import type { WebSearchOptions, WebSearchResult } from '../../tools/webSearchTool.js';
import type { ProviderCandidate, ProviderAttempt, RetrievalCapability, RetrievalIntent } from '../types.js';
import { assessSearchQuality, scoreSearchResults } from '../quality.js';
import {
  context7DocsProvider,
  exaDocsProvider,
  firecrawlFetchProvider,
  firecrawlSearchProvider,
  jinaFetchProvider,
  nativeFetchProvider,
  tavilySearchProvider,
  zhipuSearchProvider
} from './adapters.js';
import { attempt, classifyProviderError, type FetchProvider, type ProviderExecution, type SearchProvider } from './contracts.js';

const searchProviders: SearchProvider[] = [
  zhipuSearchProvider,
  tavilySearchProvider,
  firecrawlSearchProvider,
  context7DocsProvider,
  exaDocsProvider
];
const fetchProviders: FetchProvider[] = [nativeFetchProvider, jinaFetchProvider, firecrawlFetchProvider];

export async function searchWithProviderFallback(input: {
  capability: 'web_search' | 'docs_search';
  candidates: ProviderCandidate[];
  query: string;
  limit: number;
  options: WebSearchOptions;
  signal?: AbortSignal;
}): Promise<ProviderExecution<WebSearchResult[]>> {
  return executeFallback(
    input.capability,
    input.candidates,
    searchProviders.filter((provider) => provider.capability === input.capability),
    (provider) => provider.search(input),
    (results) => ({
      count: results.length,
      accepted: results.length > 0
        && assessSearchQuality(scoreSearchResults(input.query, results)).verdict !== 'empty'
    })
  );
}

export async function fetchWithProviderFallback(input: {
  candidates: ProviderCandidate[];
  intent: RetrievalIntent;
  url: string;
  query?: string;
  maxChunks: number;
  signal?: AbortSignal;
  accept?: (page: FetchPageResult) => boolean;
}): Promise<ProviderExecution<FetchPageResult>> {
  const candidates = preferFetchCandidates(input.candidates, input.intent, input.url);
  return executeFallback(
    'web_fetch',
    candidates,
    fetchProviders,
    (provider) => provider.fetch(input),
    (page) => ({
      count: page.totalChars >= 160 && page.content.trim() ? 1 : 0,
      accepted: page.totalChars >= 160 && Boolean(page.content.trim()) && (input.accept?.(page) ?? true)
    })
  );
}

async function executeFallback<P extends { id: string; configured(): boolean }, T>(
  capability: RetrievalCapability,
  candidates: ProviderCandidate[],
  providers: P[],
  execute: (provider: P) => Promise<T>,
  assess: (value: T) => { count: number; accepted: boolean }
): Promise<ProviderExecution<T>> {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const attempts: ProviderAttempt[] = [];
  let bestRejected: { value: T; provider: string } | undefined;

  for (const candidate of candidates) {
    const provider = byId.get(candidate.provider);
    if (!provider || !provider.configured()) {
      attempts.push(attempt(capability, candidate.provider, 'skipped', 0, 0, 'Provider is not configured'));
      continue;
    }
    const startedAt = Date.now();
    try {
      const value = await execute(provider);
      const assessment = assess(value);
      if (!assessment.count) {
        attempts.push(attempt(capability, provider.id, 'empty', Date.now() - startedAt, 0, 'Provider returned no usable result'));
        continue;
      }
      if (!assessment.accepted) {
        bestRejected ??= { value, provider: provider.id };
        attempts.push(attempt(capability, provider.id, 'low_quality', Date.now() - startedAt, assessment.count, 'Provider result did not pass the quality gate'));
        continue;
      }
      attempts.push(attempt(capability, provider.id, 'success', Date.now() - startedAt, assessment.count));
      return { value, provider: provider.id, attempts };
    } catch (error) {
      attempts.push(attempt(
        capability,
        provider.id,
        classifyProviderError(error),
        Date.now() - startedAt,
        0,
        error instanceof Error ? error.message : 'Provider request failed'
      ));
    }
  }
  return bestRejected ? { ...bestRejected, attempts } : { attempts };
}

function preferFetchCandidates(candidates: ProviderCandidate[], intent: RetrievalIntent, url: string) {
  const preferred = intent.dynamicPage.matched
    ? ['firecrawl-fetch', 'jina', 'native-fetch']
    : intent.pdf.matched || /\.pdf(?:$|[?#])/i.test(url)
      ? ['jina', 'firecrawl-fetch', 'native-fetch']
      : ['native-fetch', 'jina', 'firecrawl-fetch'];
  const rank = new Map(preferred.map((id, index) => [id, index]));
  return [...candidates].sort((left, right) => (rank.get(left.provider) ?? 99) - (rank.get(right.provider) ?? 99));
}

export function routeCandidates(
  routes: Array<{ capability: RetrievalCapability; candidates: ProviderCandidate[] }>,
  capability: RetrievalCapability
) {
  return routes.find((route) => route.capability === capability)?.candidates ?? [];
}
