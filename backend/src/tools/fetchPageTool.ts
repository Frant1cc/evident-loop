const REQUEST_TIMEOUT_MS = 15_000;
const MAX_HTML_CHARS = 1_500_000;
const FULL_CONTENT_THRESHOLD = 3_500;
const CHUNK_TARGET_CHARS = 1_200;
const DEFAULT_MAX_CHUNKS = 3;
const MAX_MAX_CHUNKS = 6;

export type FetchPageResult = {
  url: string;
  title: string;
  totalChars: number;
  /** Full text for short pages; otherwise the selected chunks joined for convenience. */
  content: string;
  truncated: boolean;
  chunks?: Array<{ index: number; chars: number; content: string }>;
  note?: string;
};

export async function fetchPage(args: unknown, signal?: AbortSignal): Promise<FetchPageResult> {
  const { url, query, maxChunks } = parseArgs(args);

  assertPublicHttpUrl(url);

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'User-Agent': 'evident-loop-research-bot/1.0'
      },
      redirect: 'follow',
      signal: requestSignal
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeoutSignal.aborted) throw new Error(`fetch_page timed out after ${REQUEST_TIMEOUT_MS}ms for ${url}`);
    throw new Error(error instanceof Error ? `fetch_page failed: ${error.message}` : 'fetch_page failed');
  }

  if (!response.ok) {
    throw new Error(`fetch_page got HTTP ${response.status} for ${url}`);
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType && !/text\/html|application\/xhtml|text\/plain|text\/markdown/i.test(contentType)) {
    throw new Error(`fetch_page only supports HTML/text pages, got content-type "${contentType}" for ${url}`);
  }

  const raw = (await response.text()).slice(0, MAX_HTML_CHARS);
  const isHtml = /text\/html|application\/xhtml/i.test(contentType) || /<html[\s>]/i.test(raw.slice(0, 2_000));
  const title = isHtml ? extractTitle(raw) : url;
  const text = isHtml ? extractReadableText(raw) : normalizeWhitespace(raw);

  if (!text) {
    throw new Error(`fetch_page extracted no readable text from ${url}`);
  }

  if (text.length <= FULL_CONTENT_THRESHOLD) {
    return { url, title, totalChars: text.length, content: text, truncated: false };
  }

  // Long page: chunk in memory and return only the most relevant parts (just-in-time retrieval).
  const chunks = chunkText(text, CHUNK_TARGET_CHARS);
  const selected = query
    ? rankChunksByQuery(chunks, query).slice(0, maxChunks)
    : chunks.slice(0, maxChunks).map((chunk, index) => ({ chunk, index }));

  const ordered = [...selected].sort((left, right) => left.index - right.index);

  return {
    url,
    title,
    totalChars: text.length,
    content: ordered.map((item) => item.chunk).join('\n\n[...]\n\n'),
    truncated: true,
    chunks: ordered.map((item) => ({ index: item.index, chars: item.chunk.length, content: item.chunk })),
    note: query
      ? `Page has ${text.length} chars in ${chunks.length} chunks; returning the ${ordered.length} most relevant to "${query}". Call again with a different query to see other parts.`
      : `Page has ${text.length} chars in ${chunks.length} chunks; returning the first ${ordered.length}. Pass a query to retrieve the most relevant parts instead.`
  };
}

function parseArgs(args: unknown): { url: string; query?: string; maxChunks: number } {
  if (!args || typeof args !== 'object') {
    throw new Error('fetch_page requires a url string');
  }

  const { url, query, maxChunks } = args as { url?: unknown; query?: unknown; maxChunks?: unknown };

  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('fetch_page requires a url string');
  }

  return {
    url: url.trim(),
    query: typeof query === 'string' && query.trim() ? query.trim() : undefined,
    maxChunks:
      typeof maxChunks === 'number' && Number.isInteger(maxChunks) && maxChunks > 0
        ? Math.min(maxChunks, MAX_MAX_CHUNKS)
        : DEFAULT_MAX_CHUNKS
  };
}

/** Basic SSRF guard: public http(s) hosts only. Set WEB_TOOLS_ALLOW_PRIVATE_HOSTS=true to bypass in local dev/tests. */
function assertPublicHttpUrl(rawUrl: string) {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`fetch_page got an invalid url: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`fetch_page only supports http(s) urls, got ${parsed.protocol}`);
  }

  if (process.env.WEB_TOOLS_ALLOW_PRIVATE_HOSTS === 'true') return;

  const hostname = parsed.hostname.toLowerCase();
  const isPrivate =
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^169\.254\./.test(hostname);

  if (isPrivate) {
    throw new Error(`fetch_page refuses to fetch private/internal hosts: ${hostname}`);
  }
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? normalizeWhitespace(decodeEntities(match[1])).slice(0, 200) : '';
}

function extractReadableText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|canvas|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');

  text = text
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return normalizeWhitespace(decodeEntities(text));
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&copy;': '©'
  };

  return text
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp|mdash|ndash|hellip|copy);/g, (entity) => named[entity] ?? entity)
    .replace(/&#(\d+);/g, (_all, code: string) => safeFromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_all, code: string) => safeFromCodePoint(Number.parseInt(code, 16)));
}

function safeFromCodePoint(code: number): string {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
  } catch {
    return ' ';
  }
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chunkText(text: string, targetChars: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > targetChars) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }

    // A single oversized paragraph is split hard so one blob can't blow the budget.
    while (current.length > targetChars * 2) {
      chunks.push(current.slice(0, targetChars));
      current = current.slice(targetChars);
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/** Lightweight keyword scoring that works for both latin words and CJK text (bigrams). */
function rankChunksByQuery(chunks: string[], query: string): Array<{ chunk: string; index: number }> {
  const terms = extractTerms(query);

  const scored = chunks.map((chunk, index) => {
    const haystack = chunk.toLowerCase();
    let score = 0;

    for (const term of terms) {
      let position = haystack.indexOf(term);

      while (position !== -1) {
        score += term.length;
        position = haystack.indexOf(term, position + term.length);
      }
    }

    return { chunk, index, score: score / Math.sqrt(chunk.length || 1) };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .concat(scored.filter((item) => item.score === 0))
    .map(({ chunk, index }) => ({ chunk, index }));
}

function extractTerms(query: string): string[] {
  const lower = query.toLowerCase();
  const latinWords = lower.match(/[a-z0-9_.-]{2,}/g) ?? [];
  const cjkRuns = lower.match(/[一-鿿぀-ヿ가-힯]+/g) ?? [];
  const cjkBigrams: string[] = [];

  for (const run of cjkRuns) {
    if (run.length === 1) {
      cjkBigrams.push(run);
      continue;
    }

    for (let index = 0; index < run.length - 1; index += 1) {
      cjkBigrams.push(run.slice(index, index + 2));
    }
  }

  return [...new Set([...latinWords, ...cjkBigrams])];
}
