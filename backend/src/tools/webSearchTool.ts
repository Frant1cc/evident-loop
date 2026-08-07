const DEFAULT_TAVILY_BASE_URL = 'https://api.tavily.com';
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;
const MAX_SNIPPET_CHARS = 600;

export type WebSearchOptions = {
  searchDepth?: 'basic' | 'advanced';
  timeRange?: 'day' | 'week' | 'month' | 'year';
  includeDomains?: string[];
  excludeDomains?: string[];
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  score?: number;
};

type TavilyResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
};

export async function webSearch(
  args: unknown,
  signal?: AbortSignal,
  options: WebSearchOptions = {}
): Promise<{ query: string; results: WebSearchResult[] }> {
  const { query, limit } = parseArgs(args);
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    throw new Error('web_search is not configured: set TAVILY_API_KEY in backend/.env (free tier: https://tavily.com)');
  }

  const baseUrl = process.env.TAVILY_BASE_URL ?? DEFAULT_TAVILY_BASE_URL;
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;

  try {
    response = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query,
        max_results: limit,
        search_depth: options.searchDepth ?? 'basic',
        ...(options.searchDepth === 'advanced' ? { chunks_per_source: 3 } : {}),
        ...(options.timeRange ? { time_range: options.timeRange } : {}),
        ...(options.includeDomains?.length ? { include_domains: options.includeDomains } : {}),
        ...(options.excludeDomains?.length ? { exclude_domains: options.excludeDomains } : {})
      }),
      signal: requestSignal
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeoutSignal.aborted) throw new Error(`web_search timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw new Error(error instanceof Error ? `web_search request failed: ${error.message}` : 'web_search request failed');
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`web_search failed with status ${response.status}${errorText ? `: ${errorText.slice(0, 300)}` : ''}`);
  }

  const payload = (await response.json()) as TavilyResponse;
  const results: WebSearchResult[] = (payload.results ?? [])
    .filter((item) => typeof item.url === 'string' && item.url)
    .slice(0, limit)
    .map((item) => ({
      title: item.title?.trim() || item.url!,
      url: item.url!,
      snippet: (item.content ?? '').trim().slice(0, MAX_SNIPPET_CHARS),
      ...(typeof item.score === 'number' ? { score: item.score } : {})
    }));

  return { query, results };
}

function parseArgs(args: unknown): { query: string; limit: number } {
  if (!args || typeof args !== 'object') {
    throw new Error('web_search requires a query string');
  }

  const { query, limit } = args as { query?: unknown; limit?: unknown };

  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('web_search requires a query string');
  }

  return {
    query: query.trim(),
    limit: typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  };
}
