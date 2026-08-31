import { fetchPage, type FetchPageResult } from '../../tools/fetchPageTool.js';
import { webSearch, type WebSearchResult } from '../../tools/webSearchTool.js';
import { ProviderHttpError, type FetchProvider, type SearchProvider } from './contracts.js';

const DEFAULT_TIMEOUT_MS = 20_000;

export const tavilySearchProvider: SearchProvider = {
  id: 'tavily',
  capability: 'web_search',
  configured: () => Boolean(process.env.TAVILY_API_KEY),
  search: async ({ query, limit, options, signal }) =>
    (await webSearch({ query, limit }, signal, options)).results.map((result) => ({ ...result, provider: 'tavily' }))
};

export const zhipuSearchProvider: SearchProvider = {
  id: 'zhipu',
  capability: 'web_search',
  configured: () => Boolean(process.env.ZHIPU_API_KEY),
  async search({ query, limit, options, signal }) {
    const baseUrl = (process.env.ZHIPU_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
    const payload = await requestJson('zhipu', `${baseUrl}/web_search`, {
      method: 'POST',
      headers: authHeaders(process.env.ZHIPU_API_KEY),
      body: JSON.stringify({
        search_query: query,
        search_engine: process.env.ZHIPU_SEARCH_ENGINE ?? 'search_std',
        count: Math.min(limit, 50),
        search_intent: true,
        content_size: options.searchDepth === 'advanced' ? 'high' : 'medium',
        search_recency_filter: zhipuRecency(options.timeRange),
        ...(options.includeDomains?.length === 1 ? { search_domain_filter: options.includeDomains[0] } : {})
      }),
      signal
    }) as { search_result?: Array<{ title?: string; link?: string; content?: string; publish_date?: string }> };
    return (payload.search_result ?? []).flatMap((item) => item.link ? [{
      title: item.title?.trim() || item.link,
      url: item.link,
      snippet: item.content?.trim().slice(0, 1_200) ?? '',
      ...(item.publish_date?.trim() ? { publishedAt: item.publish_date.trim() } : {}),
      provider: 'zhipu'
    }] : []);
  }
};

export const firecrawlSearchProvider: SearchProvider = {
  id: 'firecrawl-search',
  capability: 'web_search',
  configured: () => Boolean(process.env.FIRECRAWL_API_KEY),
  async search({ query, limit, options, signal }) {
    const baseUrl = (process.env.FIRECRAWL_BASE_URL ?? 'https://api.firecrawl.dev/v2').replace(/\/$/, '');
    const payload = await requestJson('firecrawl-search', `${baseUrl}/search`, {
      method: 'POST',
      headers: authHeaders(process.env.FIRECRAWL_API_KEY),
      body: JSON.stringify({
        query,
        limit,
        sources: ['web'],
        ...(options.includeDomains?.length ? { includeDomains: options.includeDomains } : {}),
        ...(options.excludeDomains?.length ? { excludeDomains: options.excludeDomains } : {}),
        ...(options.timeRange ? { tbs: firecrawlTimeRange(options.timeRange) } : {})
      }),
      signal
    }) as { data?: { web?: Array<{ title?: string; url?: string; description?: string; markdown?: string; publishedDate?: string }> } };
    return (payload.data?.web ?? []).flatMap((item) => item.url ? [{
      title: item.title?.trim() || item.url,
      url: item.url,
      snippet: (item.description ?? item.markdown ?? '').trim().slice(0, 1_200),
      ...(item.markdown ? { content: item.markdown.slice(0, 50_000) } : {}),
      ...(item.publishedDate?.trim() ? { publishedAt: item.publishedDate.trim() } : {}),
      provider: 'firecrawl-search'
    }] : []);
  }
};

export const exaDocsProvider: SearchProvider = {
  id: 'exa',
  capability: 'docs_search',
  configured: () => Boolean(process.env.EXA_API_KEY),
  async search({ query, limit, options, signal }) {
    const baseUrl = (process.env.EXA_BASE_URL ?? 'https://api.exa.ai').replace(/\/$/, '');
    const payload = await requestJson('exa', `${baseUrl}/search`, {
      method: 'POST',
      headers: { 'x-api-key': process.env.EXA_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        numResults: limit,
        type: 'auto',
        ...(options.includeDomains?.length ? { includeDomains: options.includeDomains } : {}),
        ...(options.excludeDomains?.length ? { excludeDomains: options.excludeDomains } : {}),
        contents: { highlights: { maxCharacters: 1_200 } }
      }),
      signal
    }) as { results?: Array<{ title?: string; url?: string; highlights?: string[]; text?: string; score?: number; publishedDate?: string }> };
    return (payload.results ?? []).flatMap((item) => item.url ? [{
      title: item.title?.trim() || item.url,
      url: item.url,
      snippet: (item.highlights?.join('\n') ?? item.text ?? '').trim().slice(0, 1_200),
      ...(item.highlights?.length || item.text ? { content: (item.highlights?.join('\n\n') ?? item.text ?? '').slice(0, 50_000) } : {}),
      ...(typeof item.score === 'number' ? { score: item.score } : {}),
      ...(item.publishedDate?.trim() ? { publishedAt: item.publishedDate.trim() } : {}),
      provider: 'exa'
    }] : []);
  }
};

export const context7DocsProvider: SearchProvider = {
  id: 'context7',
  capability: 'docs_search',
  configured: () => Boolean(process.env.CONTEXT7_API_KEY),
  async search({ query, limit, signal }) {
    const libraryName = inferLibraryName(query);
    if (!libraryName) return [];
    const baseUrl = (process.env.CONTEXT7_BASE_URL ?? 'https://context7.com/api/v2').replace(/\/$/, '');
    const headers = authHeaders(process.env.CONTEXT7_API_KEY);
    const libraries = await requestJson('context7', `${baseUrl}/libs/search?${new URLSearchParams({ libraryName, query })}`, {
      headers,
      signal
    }) as { results?: Array<{ id?: string; title?: string; description?: string }> };
    const selected = (libraries.results ?? []).slice(0, Math.min(2, limit));
    const results: WebSearchResult[] = [];
    for (const library of selected) {
      if (!library.id) continue;
      const context = await requestJson('context7', `${baseUrl}/context?${new URLSearchParams({ libraryId: library.id, query, type: 'json' })}`, {
        headers,
        signal
      }) as { infoSnippets?: Array<{ content?: string }>; codeSnippets?: Array<{ codeTitle?: string; codeList?: Array<{ code?: string }> }> };
      const content = [
        ...(context.infoSnippets ?? []).map((item) => item.content ?? ''),
        ...(context.codeSnippets ?? []).flatMap((item) => [item.codeTitle ?? '', ...(item.codeList ?? []).map((code) => code.code ?? '')])
      ].filter(Boolean).join('\n\n').slice(0, 50_000);
      if (!content) continue;
      results.push({
        title: library.title ?? library.id,
        url: `https://context7.com${library.id}`,
        snippet: (library.description ?? content).slice(0, 1_200),
        content,
        provider: 'context7'
      });
    }
    return results;
  }
};

export const nativeFetchProvider: FetchProvider = {
  id: 'native-fetch',
  capability: 'web_fetch',
  configured: () => true,
  fetch: ({ url, query, maxChunks, signal }) => fetchPage({ url, query, maxChunks }, signal)
};

export const jinaFetchProvider: FetchProvider = {
  id: 'jina',
  capability: 'web_fetch',
  configured: () => Boolean(process.env.JINA_API_KEY),
  async fetch({ url, signal }) {
    const baseUrl = (process.env.JINA_READER_BASE_URL ?? 'https://r.jina.ai').replace(/\/$/, '');
    const response = await requestText('jina', `${baseUrl}/${url}`, {
      headers: { Authorization: `Bearer ${process.env.JINA_API_KEY}`, Accept: 'text/plain' },
      signal
    });
    return externalPage(url, url, response);
  }
};

export const firecrawlFetchProvider: FetchProvider = {
  id: 'firecrawl-fetch',
  capability: 'web_fetch',
  configured: () => Boolean(process.env.FIRECRAWL_API_KEY),
  async fetch({ url, signal }) {
    const baseUrl = (process.env.FIRECRAWL_BASE_URL ?? 'https://api.firecrawl.dev/v2').replace(/\/$/, '');
    const payload = await requestJson('firecrawl-fetch', `${baseUrl}/scrape`, {
      method: 'POST',
      headers: authHeaders(process.env.FIRECRAWL_API_KEY),
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal
    }) as { data?: { markdown?: string; metadata?: { title?: string } } };
    const content = payload.data?.markdown?.trim() ?? '';
    if (!content) throw new Error('Firecrawl returned no readable content');
    return externalPage(url, payload.data?.metadata?.title ?? url, content);
  }
};

function authHeaders(key: string | undefined) {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function requestJson(provider: string, url: string, init: RequestInit) {
  const response = await providerFetch(provider, url, init);
  return response.json();
}

async function requestText(provider: string, url: string, init: RequestInit) {
  const response = await providerFetch(provider, url, init);
  return response.text();
}

async function providerFetch(provider: string, url: string, init: RequestInit) {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    if (timeoutSignal.aborted) throw new Error(`${provider} timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    throw error;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderHttpError(provider, response.status, `${provider} HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
  return response;
}

function externalPage(url: string, title: string, rawContent: string): FetchPageResult {
  const content = rawContent.trim().slice(0, 60_000);
  const chunks = chunk(content, 1_200).slice(0, 12);
  return {
    url,
    title,
    totalChars: content.length,
    content,
    truncated: rawContent.length > content.length,
    chunks: chunks.map((item, index) => ({ index, chars: item.length, content: item }))
  };
}

function chunk(content: string, size: number) {
  const result: string[] = [];
  for (let index = 0; index < content.length; index += size) result.push(content.slice(index, index + size));
  return result;
}

function inferLibraryName(query: string) {
  const known = query.match(/\b(?:spring(?: webflux)?|react|vue|next\.js|node\.js|express|fastapi|django|flask|angular|svelte|nestjs)\b/i)?.[0];
  return known?.replace(/\s+/g, '-') ?? undefined;
}

function zhipuRecency(value: 'day' | 'week' | 'month' | 'year' | undefined) {
  return value === 'day' ? 'oneDay' : value === 'week' ? 'oneWeek' : value === 'month' ? 'oneMonth' : value === 'year' ? 'oneYear' : 'noLimit';
}

function firecrawlTimeRange(value: 'day' | 'week' | 'month' | 'year') {
  return value === 'day' ? 'qdr:d' : value === 'week' ? 'qdr:w' : value === 'month' ? 'qdr:m' : 'qdr:y';
}
