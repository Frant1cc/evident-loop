import type { FetchPageResult } from '../tools/fetchPageTool.js';
import type {
  PageQualityVerdict,
  ScoredPageChunk,
  ScoredWebSearchResult,
  SearchQualityVerdict
} from './types.js';
import type { WebSearchResult } from '../tools/webSearchTool.js';

export const webQualityThresholds = {
  searchSufficient: 0.68,
  searchWeak: 0.42,
  pageSufficient: 0.64,
  pageWeak: 0.42,
  minimumReadableChars: 160,
  highConfidenceSingleSource: 0.76,
  multiSourceSufficient: 0.62,
  claimCoverageSufficient: 0.8,
  claimSupportScore: 0.55,
  subjectConsistencySufficient: 0.8,
  pageSubjectConsistency: 0.5
} as const;

const trackingParameters = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'source',
  'utm_campaign',
  'utm_content',
  'utm_medium',
  'utm_source',
  'utm_term'
]);

export function canonicalizeWebUrl(rawUrl: string) {
  const parsed = new URL(rawUrl);
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();

  for (const key of [...parsed.searchParams.keys()]) {
    if (trackingParameters.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }

  parsed.searchParams.sort();
  if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

export function scoreSearchResults(
  question: string,
  results: WebSearchResult[],
  preferredDomains: string[] = []
): ScoredWebSearchResult[] {
  const byUrl = new Map<string, ScoredWebSearchResult>();

  for (const result of results) {
    let canonicalUrl: string;
    let domain: string;
    try {
      canonicalUrl = canonicalizeWebUrl(result.url);
      domain = new URL(canonicalUrl).hostname;
    } catch {
      continue;
    }

    const providerScore = clamp01(result.score ?? 0.45);
    const lexicalScore = lexicalRelevance(question, `${result.title}\n${result.snippet}`);
    const completenessScore = [result.title.trim(), result.url.trim(), result.snippet.trim()]
      .filter(Boolean).length / 3;
    const authorityBoost = preferredDomains.some((preferred) =>
      domain === preferred || domain.endsWith(`.${preferred}`)
    ) ? 0.12 : 0;
    const officialCandidate = authorityBoost > 0;
    const titleEntity = releaseTitleEntity(result.title);
    const releaseIntent = isReleaseIntent(question);
    const latestIntent = isLatestIntent(question);
    const titleExactMatch = releaseIntent && Boolean(titleEntity);
    const urlEntityMatch = Boolean(titleEntity && urlContainsEntity(canonicalUrl, titleEntity));
    const directReleaseMatch = officialCandidate && titleExactMatch && urlEntityMatch;
    const officialCurrentIndex = officialCandidate && isCurrentModelIndex(result.title, canonicalUrl);
    const datedDirectRelease = directReleaseMatch && Boolean(result.publishedAt);
    const releaseTier = releaseIntent
      ? latestIntent && officialCurrentIndex ? 0
        : directReleaseMatch && (!latestIntent || datedDirectRelease) ? 0
          : latestIntent && directReleaseMatch ? 1
            : officialCandidate && titleExactMatch ? 1
              : officialCandidate && hasReleaseSnippet(result.snippet) ? 2
          : officialCandidate && /docs|models?|release-notes/i.test(canonicalUrl) ? 2
            : officialCandidate ? 3
              : 4
      : undefined;
    let finalScore = clamp01(
      providerScore * 0.55 + lexicalScore * 0.35 + completenessScore * 0.10 + authorityBoost
    );
    if (releaseTier === 0) finalScore = Math.max(finalScore, 0.96);
    else if (releaseTier === 1) finalScore = Math.max(finalScore, 0.86);
    const scored: ScoredWebSearchResult = {
      ...result,
      canonicalUrl,
      domain,
      providerScore,
      lexicalScore,
      completenessScore,
      finalScore,
      ...(releaseTier === undefined ? {} : { releaseTier }),
      ...(titleExactMatch ? { titleExactMatch } : {}),
      ...(urlEntityMatch ? { urlEntityMatch } : {}),
      ...(directReleaseMatch ? { directReleaseMatch } : {})
    };
    const existing = byUrl.get(canonicalUrl);
    if (!existing || scored.finalScore > existing.finalScore) byUrl.set(canonicalUrl, scored);
  }

  return [...byUrl.values()].sort((left, right) =>
    (left.releaseTier ?? 5) - (right.releaseTier ?? 5)
    || right.finalScore - left.finalScore
  );
}

export function assessSearchQuality(results: ScoredWebSearchResult[]): {
  verdict: SearchQualityVerdict;
  topScore?: number;
} {
  const topScore = results[0]?.finalScore;
  if (topScore === undefined || topScore < webQualityThresholds.searchWeak) {
    return { verdict: 'empty', ...(topScore === undefined ? {} : { topScore }) };
  }
  return {
    verdict: topScore >= webQualityThresholds.searchSufficient ? 'sufficient' : 'weak',
    topScore
  };
}

export function selectDiverseSearchResults(
  results: ScoredWebSearchResult[],
  fetchedUrls: Set<string>,
  limit: number
) {
  const selected: ScoredWebSearchResult[] = [];
  const selectedDomains = new Set<string>();
  const eligible = results.filter((result) =>
    result.finalScore >= webQualityThresholds.searchWeak && !fetchedUrls.has(result.canonicalUrl)
  );

  for (const result of eligible) {
    if (selectedDomains.has(result.domain)) continue;
    selected.push(result);
    selectedDomains.add(result.domain);
    if (selected.length >= limit) return selected;
  }

  for (const result of eligible) {
    if (selected.some((item) => item.canonicalUrl === result.canonicalUrl)) continue;
    selected.push(result);
    if (selected.length >= limit) break;
  }

  return selected;
}

export function assessPageQuality(
  question: string,
  searchResult: ScoredWebSearchResult,
  page: FetchPageResult
): {
  verdict: PageQualityVerdict;
  score: number;
  chunks: ScoredPageChunk[];
} {
  if (page.totalChars < webQualityThresholds.minimumReadableChars || !page.content.trim()) {
    return { verdict: 'unreadable', score: 0, chunks: [] };
  }

  const rawChunks = page.chunks?.length
    ? page.chunks.map((chunk) => ({ index: chunk.index, content: chunk.content }))
    : [{ index: 0, content: page.content }];
  const titleEntity = releaseTitleEntity(page.title || searchResult.title);
  const chunks = rawChunks
    .map((chunk) => {
      const lexicalScore = lexicalRelevance(question, chunk.content);
      return {
        ...chunk,
        lexicalScore,
        finalScore: clamp01(lexicalScore * 0.60 + searchResult.finalScore * 0.40),
        pageTitle: page.title || searchResult.title,
        canonicalUrl: searchResult.canonicalUrl,
        domain: searchResult.domain,
        ...(searchResult.publishedAt ? { publishedAt: searchResult.publishedAt } : {}),
        ...(titleEntity ? { pageEntityCandidates: [titleEntity] } : {})
      };
    })
    .filter((chunk) => chunk.lexicalScore > 0)
    .sort((left, right) => right.finalScore - left.finalScore)
    .slice(0, 4);
  let score = chunks[0]?.finalScore ?? 0;
  if (searchResult.directReleaseMatch && chunks.length) score = Math.max(score, 0.82);

  if (score < webQualityThresholds.pageWeak) return { verdict: 'irrelevant', score, chunks: [] };
  return {
    verdict: score >= webQualityThresholds.pageSufficient ? 'sufficient' : 'weak',
    score,
    chunks
  };
}

function isReleaseIntent(value: string) {
  return /(?:models?|模型).{0,80}(?:latest|current|announce|announcement|release|launch|最新|当前|发布|推出|上线)|(?:latest|current|announce|announcement|release|launch|最新|当前|发布|推出|上线).{0,80}(?:models?|模型)/iu.test(value);
}

function isLatestIntent(value: string) {
  return /\b(?:latest|current|newest|recent)\b|最新|当前|现行|近期/iu.test(value);
}

function isCurrentModelIndex(title: string, canonicalUrl: string) {
  return /(?:model\s+(?:overview|catalog|list)|models?\s+overview|release\s+notes?|模型概述|模型列表|发布说明)/iu.test(title)
    || /\/(?:release-notes?|models?)(?:\/overview)?(?:$|[/?#])/iu.test(canonicalUrl)
    || /\/about-claude\/models(?:$|[/?#])/iu.test(canonicalUrl);
}

function releaseTitleEntity(value: string) {
  const title = value.replace(/\s+[|\\]\s+[^|\\]{2,80}$/u, '').trim();
  const match = title.match(/^(?:introducing|announcing)\s+(.+?)$/iu)
    ?? title.match(/^(.+?)\s+(?:launch|release)$/iu);
  return match?.[1]?.replace(/[.。,:：;；]+$/, '').trim();
}

function urlContainsEntity(rawUrl: string, entity: string) {
  try {
    const urlTokens = normalizeEntityTokens(decodeURIComponent(new URL(rawUrl).pathname));
    const entityTokens = normalizeEntityTokens(entity);
    return entityTokens.length > 0 && entityTokens.every((term) => urlTokens.includes(term));
  } catch {
    return false;
  }
}

function normalizeEntityTokens(value: string) {
  return value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function hasReleaseSnippet(value: string) {
  return /\b(?:introducing|announcing|launched|released)\b|发布|推出|上线/iu.test(value);
}

export function isEvidenceSufficient(pageScores: number[], domains: Set<string>) {
  const topScore = Math.max(0, ...pageScores);
  return topScore >= webQualityThresholds.highConfidenceSingleSource
    || (domains.size >= 2 && topScore >= webQualityThresholds.multiSourceSufficient);
}

export function lexicalRelevance(query: string, text: string) {
  const terms = extractTerms(query);
  if (!terms.length) return 0;
  const haystack = text.toLowerCase();
  const matchedWeight = terms.reduce((total, term) => total + (haystack.includes(term) ? term.length : 0), 0);
  const totalWeight = terms.reduce((total, term) => total + term.length, 0);
  return clamp01(matchedWeight / Math.max(totalWeight, 1));
}

export function normalizeQuery(query: string) {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

function extractTerms(query: string) {
  const lower = query.toLowerCase();
  const latinWords = lower.match(/[a-z0-9_.-]{2,}/g) ?? [];
  const cjkRuns = lower.match(/[一-鿿぀-ヿ가-힯]+/g) ?? [];
  const cjkBigrams: string[] = [];

  for (const run of cjkRuns) {
    if (run.length === 1) cjkBigrams.push(run);
    else for (let index = 0; index < run.length - 1; index += 1) cjkBigrams.push(run.slice(index, index + 2));
  }

  return [...new Set([...latinWords, ...cjkBigrams])];
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
