import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { RagSource } from '../rag/types.js';
import { fetchPage, type FetchPageResult } from '../tools/fetchPageTool.js';
import { webSearch, type WebSearchResult, type WebSearchOptions } from '../tools/webSearchTool.js';
import {
  assessPageQuality,
  assessSearchQuality,
  isEvidenceSufficient,
  normalizeQuery,
  scoreSearchResults,
  selectDiverseSearchResults,
  webQualityThresholds
} from './quality.js';
import { rewriteWebQuery, type RewriteWebQueryOptions } from './queryRewrite.js';
import { assessClaimCoverage, contentMatchesClaimSubject, extractWebClaims, type ClaimEvidence, type WebClaim } from './claims.js';
import { detectRetrievalIntent } from './intent.js';
import { buildRetrievalQueryRoute, inferPreferredOfficialDomains } from './routing.js';
import {
  fetchWithProviderFallback,
  routeCandidates,
  searchWithProviderFallback
} from './providers/registry.js';
import type {
  PageAttempt,
  QueryAttempt,
  RequiredEvidenceNeed,
  ScoredWebSearchResult,
  ProviderAttempt,
  WebRetrievalResult
} from './types.js';

const inputSchema = z.object({
  question: z.string().trim().min(1).max(1_000),
  maxQueries: z.number().int().min(1).max(5).optional(),
  maxPages: z.number().int().min(1).max(10).optional(),
  timeRange: z.enum(['day', 'week', 'month', 'year']).optional(),
  includeDomains: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
  excludeDomains: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
  requiredEvidence: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(240),
    groups: z.array(z.array(z.string().trim().min(1).max(120)).min(1)).min(1).max(12)
  })).max(12).optional(),
  expectNoAnswer: z.boolean().optional()
});

type SearchFunction = (
  args: { query: string; limit: number },
  signal?: AbortSignal,
  options?: WebSearchOptions
) => Promise<{ query: string; results: WebSearchResult[]; provider?: string }>;

export type WebRetrievalDependencies = {
  search?: SearchFunction;
  fetch?: (args: unknown, signal?: AbortSignal) => Promise<FetchPageResult>;
  rewrite?: (options: RewriteWebQueryOptions) => Promise<string | undefined>;
  now?: () => number;
};

export async function retrieveWebEvidence(
  args: unknown,
  options: { signal?: AbortSignal; dependencies?: WebRetrievalDependencies } = {}
): Promise<WebRetrievalResult> {
  const input = inputSchema.parse(args);
  const intent = detectRetrievalIntent(input.question);
  const queryRoute = buildRetrievalQueryRoute(intent, {
    question: input.question,
    explicitTimeRange: input.timeRange,
    includeDomains: input.includeDomains
  });
  const isSingleDomainSearch = input.includeDomains?.length === 1;
  const claims: WebClaim[] = input.requiredEvidence?.length
    ? input.requiredEvidence.map(toRequiredClaim)
    : extractWebClaims(input.question);
  const isBroadMultiClaimQuestion = claims.length >= 5;
  const canExpandForUncoveredTechnicalClaims = input.maxPages === undefined
    && isBroadMultiClaimQuestion
    && intent.officialDocs.matched;
  // A domain-constrained request cannot gain confidence through cross-domain corroboration,
  // so give it more room to locate the exact page within that authority. Broad
  // multi-part questions also need more than the three-query single-fact budget.
  const queryBudget = input.maxQueries ?? (isBroadMultiClaimQuestion ? 5 : isSingleDomainSearch ? 4 : 3);
  let pageBudget = input.maxPages ?? (isBroadMultiClaimQuestion || isSingleDomainSearch ? 8 : 5);
  const maximumPageBudget = canExpandForUncoveredTechnicalClaims ? 10 : pageBudget;
  const injectedSearch = options.dependencies?.search;
  const injectedFetch = options.dependencies?.fetch;
  const rewrite = options.dependencies?.rewrite ?? rewriteWebQuery;
  const now = options.dependencies?.now ?? Date.now;
  const startedAt = now();
  // The first official-docs query is domain constrained. Preserve one broad
  // overview query before gap-focused rewrites so comprehensive implementation
  // guides can still be discovered across the open web.
  const pendingQueries = [
    ...queryRoute.initialQueries,
    ...(input.maxQueries === undefined && isBroadMultiClaimQuestion && queryRoute.preferredDomains?.length
      ? [buildBroadOverviewQuery(input.question)]
      : [])
  ];
  const seenQueries = new Set<string>();
  const fetchedUrls = new Set<string>();
  const evidenceDomains = new Set<string>();
  const queryAttempts: QueryAttempt[] = [];
  const pageAttempts: PageAttempt[] = [];
  const sources: RagSource[] = [];
  const pageScores: number[] = [];
  const evidence: ClaimEvidence[] = [];
  const providerAttempts: ProviderAttempt[] = [];
  let budgetExhaustedBy: WebRetrievalResult['diagnostics']['budgetExhaustedBy'];
  let stopReason = 'No usable web evidence was found';

  for (const url of queryRoute.directFetchUrls.slice(0, pageBudget)) {
    throwIfAborted(options.signal);
    const candidate = directUrlCandidate(url);
    fetchedUrls.add(candidate.canonicalUrl);
    await fetchCandidate(candidate, true);
  }

  if (!queryRoute.searchRequired) {
    if (sources.length) {
      stopReason = 'Explicit URL provided sufficient directly fetched evidence';
      return buildResult('sufficient');
    }
    stopReason = sources.length
      ? 'Explicit URL was fetched but did not cover enough of the question'
      : 'Explicit URL did not produce usable evidence';
    return buildResult(sources.length ? 'weak' : 'empty');
  }

  while (seenQueries.size < queryBudget) {
    throwIfAborted(options.signal);
    let query = pendingQueries.shift();
    if (!query) {
      query = await rewrite({
        question: input.question,
        previousQueries: queryAttempts.map((attempt) => attempt.query),
        reason: getRewriteReason(queryAttempts, pageAttempts),
        uncoveredClaims: assessClaimCoverage(claims, evidence).uncoveredClaims,
        signal: options.signal
      });
    }
    if (!query || seenQueries.has(normalizeQuery(query))) {
      stopReason = 'No distinct query rewrite was available';
      break;
    }

    seenQueries.add(normalizeQuery(query));
    const searchDepth = seenQueries.size > 1 && seenQueries.size >= queryBudget ? 'advanced' : 'basic';
    const searchOptions: WebSearchOptions = {
      searchDepth,
      timeRange: input.timeRange ?? queryRoute.inferredTimeRange,
      includeDomains: input.includeDomains
        ?? (seenQueries.size === 1
          ? queryRoute.preferredDomains
          : inferPreferredOfficialDomains(query).length
            ? inferPreferredOfficialDomains(query)
            : undefined),
      excludeDomains: input.excludeDomains
    };
    const response = injectedSearch
      ? await injectedSearch({ query, limit: 8 }, options.signal, searchOptions)
      : await executeRoutedSearch(query, searchOptions, seenQueries.size === 1 && intent.officialDocs.matched);
    // Rewrites deliberately focus on an uncovered subtopic. Score each result
    // against that focused query as well as the original question, otherwise a
    // strong heartbeat/backpressure page can be rejected for not repeating all
    // nine topics from a broad initial request.
    const scoredForQuestion = scoreSearchResults(
      input.question,
      response.results,
      queryRoute.preferredDomains
    );
    const scoredForQuery = normalizeQuery(query) === normalizeQuery(input.question)
      ? scoredForQuestion
      : scoreSearchResults(query, response.results, queryRoute.preferredDomains);
    const scored = mergeSearchScores(scoredForQuestion, scoredForQuery);
    const assessment = assessSearchQuality(scored);
    const remainingPages = pageBudget - fetchedUrls.size;
    const selected = remainingPages > 0
      ? selectDiverseSearchResults(scored, fetchedUrls, Math.min(2, remainingPages))
      : [];
    queryAttempts.push({
      query,
      searchDepth,
      verdict: assessment.verdict,
      ...(assessment.topScore === undefined ? {} : { topScore: assessment.topScore }),
      resultCount: scored.length,
      selectedUrls: selected.map((result) => result.canonicalUrl),
      ...(response.provider ? { provider: response.provider } : {})
    });

    for (const candidate of selected) {
      throwIfAborted(options.signal);
      fetchedUrls.add(candidate.canonicalUrl);
      await fetchCandidate(candidate, false, query);
    }

    const coverage = assessClaimCoverage(claims, evidence);
    // Evaluation supplies explicit facts. Once every one is supported, do not
    // spend the remaining generic confidence budget on redundant pages.
    if (input.requiredEvidence?.length && coverage.supportedClaimRatio === 1) {
      stopReason = 'All required evidence points were supported; stopped before budget exhaustion';
      return buildResult('sufficient');
    }
    // A deliberately unanswerable, domain-constrained question should not burn
    // the full four-query budget after two precise searches found no usable page.
    if (input.expectNoAnswer && queryAttempts.length >= 2 && sources.length === 0) {
      stopReason = 'Two precise searches found no usable official evidence for an expected-unanswerable question';
      return buildResult('empty');
    }
    if (
      isEvidenceSufficient(pageScores, evidenceDomains) &&
      coverage.supportedClaimRatio >= webQualityThresholds.claimCoverageSufficient &&
      coverage.coverageScore >= webQualityThresholds.claimSupportScore &&
      coverage.subjectConsistencyRate >= webQualityThresholds.subjectConsistencySufficient &&
      coverage.subjectMismatchUrls.length === 0
    ) {
      stopReason = evidenceDomains.size >= 2
        ? 'Relevant evidence was confirmed across independent domains'
        : 'A high-confidence relevant source was found';
      return buildResult('sufficient');
    }
    if (fetchedUrls.size >= pageBudget) {
      if (pageBudget < maximumPageBudget && coverage.uncoveredClaims.length) {
        pageBudget = maximumPageBudget;
        stopReason = 'Expanded page budget for uncovered technical claims';
        continue;
      }
      stopReason = coverage.uncoveredClaims.length
        ? 'Page budget exhausted before all question claims were supported'
        : 'Page budget exhausted before evidence became sufficient';
      break;
    }
  }

  const queryBudgetExhausted = seenQueries.size >= queryBudget;
  const pageBudgetExhausted = fetchedUrls.size >= pageBudget;
  const budgetExhausted = queryBudgetExhausted || pageBudgetExhausted;
  budgetExhaustedBy = queryBudgetExhausted && pageBudgetExhausted
    ? 'queries-and-pages'
    : queryBudgetExhausted
      ? 'queries'
      : pageBudgetExhausted
        ? 'pages'
        : undefined;
  if (budgetExhaustedBy === 'queries-and-pages') {
    stopReason = 'Combined query and page budget exhausted before evidence became sufficient';
  } else if (budgetExhaustedBy === 'queries') {
    stopReason = 'Query budget exhausted before evidence became sufficient';
  } else if (budgetExhaustedBy === 'pages') {
    stopReason = 'Page budget exhausted before evidence became sufficient';
  }
  return buildResult(sources.length ? (budgetExhausted ? 'exhausted' : 'weak') : 'empty');

  function buildResult(verdict: WebRetrievalResult['verdict']): WebRetrievalResult {
    const coverage = assessClaimCoverage(claims, evidence);
    return {
      question: input.question,
      intent,
      queryRoute,
      verdict,
      score: Math.max(0, ...pageScores),
      retrievalQueries: queryAttempts.map((attempt) => attempt.query),
      queryAttempts,
      pageAttempts,
      sources,
      claims: coverage.claims,
      coverageScore: coverage.coverageScore,
      coveredClaimCount: coverage.claims.filter((claim) => claim.supported).length,
      totalClaimCount: coverage.claims.length,
      uncoveredClaims: coverage.uncoveredClaims,
      diagnostics: {
        queriesUsed: queryAttempts.length,
        pagesFetched: fetchedUrls.size,
        queryBudget,
        pageBudget,
        ...(budgetExhaustedBy ? { budgetExhaustedBy } : {}),
        independentDomains: evidenceDomains.size,
        durationMs: Math.max(0, now() - startedAt),
        stopReason,
        providerAttempts,
        providersUsed: [...new Set([
          ...queryAttempts.flatMap((attempt) => attempt.provider ? [attempt.provider] : []),
          ...pageAttempts.flatMap((attempt) => attempt.provider ? [attempt.provider] : [])
        ])],
        fallbackUsed: providerAttempts.some((attempt, index) =>
          attempt.status === 'success'
          && providerAttempts.slice(0, index).some((previous) =>
            previous.capability === attempt.capability
            && previous.status !== 'success'
            && previous.status !== 'skipped'
          )
        ),
        subjectConsistencyRate: pageAttempts.length
          ? pageAttempts.filter((attempt) => !attempt.subjectMismatch).length / pageAttempts.length
          : coverage.subjectConsistencyRate,
        subjectMismatchUrls: [...new Set([
          ...coverage.subjectMismatchUrls,
          ...pageAttempts.filter((attempt) => attempt.subjectMismatch).map((attempt) => attempt.url)
        ])]
      }
    };
  }

  async function fetchCandidate(
    candidate: ScoredWebSearchResult,
    userProvided = false,
    searchQuery = input.question
  ) {
    try {
      const currentCoverage = assessClaimCoverage(claims, evidence);
      const uncovered = claims.filter((claim) => currentCoverage.uncoveredClaims.includes(claim.text));
      const pageQuestion = [
        candidate.title,
        candidate.snippet,
        searchQuery,
        ...uncovered.flatMap((claim) => [claim.text, ...claim.evidenceGroups.flat()])
      ].join('\n');
      const fetched = candidate.content
        ? { page: providerContentPage(candidate), provider: candidate.provider }
        : injectedFetch
          ? { page: await injectedFetch(
              { url: candidate.canonicalUrl, query: pageQuestion, maxChunks: 6 },
              options.signal
            ), provider: undefined }
          : await executeRoutedFetch(candidate, pageQuestion);
      if (!fetched.page) throw new Error('No configured fetch provider returned readable content');
      const page = fetched.page;
      // An explicit URL is itself the user's relevance selection. Requiring the
      // page to repeat generic verbs such as "summarize" would reject readable
      // source material, so direct fetches are gated by readability only.
      const quality = userProvided
        ? assessUserProvidedPage(page)
        : assessPageAgainstClaims(candidate, page, searchQuery, uncovered.length ? uncovered : claims);
      const subjectConsistencyScore = assessSubjectConsistency(
        uncovered.length ? uncovered : claims,
        quality.chunks.map((chunk) => chunk.content)
      );
      const subjectMismatch = !userProvided && quality.chunks.length > 0 && subjectConsistencyScore < webQualityThresholds.pageSubjectConsistency;
      pageAttempts.push({
        url: candidate.canonicalUrl,
        title: page.title || candidate.title,
        domain: candidate.domain,
        verdict: quality.verdict,
        score: quality.score,
        selectedChunkCount: quality.chunks.length,
        ...(fetched.provider ? { provider: fetched.provider } : {}),
        subjectConsistencyScore,
        subjectMismatch
      });

      if (quality.verdict === 'irrelevant' || quality.verdict === 'unreadable' || subjectMismatch) return;
      pageScores.push(quality.score);
      // Keep chunks independent. Joining them here would allow a subject mention
      // in one section to validate an unrelated fact from another section.
      evidence.push(...quality.chunks.map((chunk) => ({ url: candidate.canonicalUrl, content: chunk.content })));
      evidenceDomains.add(candidate.domain);
      sources.push(toRagSource(candidate.canonicalUrl, page.title || candidate.title, candidate.domain, quality));
    } catch (error) {
      pageAttempts.push({
        url: candidate.canonicalUrl,
        title: candidate.title,
        domain: candidate.domain,
        verdict: 'unreadable',
        score: 0,
        selectedChunkCount: 0,
        error: error instanceof Error ? error.message : 'Page fetch failed'
      });
    }
  }

  async function executeRoutedSearch(
    query: string,
    searchOptions: WebSearchOptions,
    preferDocs: boolean
  ) {
    const capability = preferDocs ? 'docs_search' as const : 'web_search' as const;
    let execution = await searchWithProviderFallback({
      capability,
      candidates: routeCandidates(queryRoute.providerRoutes, capability),
      query,
      limit: 8,
      options: searchOptions,
      signal: options.signal
    });
    providerAttempts.push(...execution.attempts);
    // Capability orchestration may use general web discovery after every docs
    // provider is unavailable or fails quality. This is separate from provider
    // fallback: each registry chain still contains only same-capability members.
    if (preferDocs && !execution.value) {
      const webExecution = await searchWithProviderFallback({
        capability: 'web_search',
        candidates: routeCandidates(queryRoute.providerRoutes, 'web_search'),
        query,
        limit: 8,
        options: searchOptions,
        signal: options.signal
      });
      providerAttempts.push(...webExecution.attempts);
      execution = webExecution;
    }
    return { query, results: execution.value ?? [], ...(execution.provider ? { provider: execution.provider } : {}) };
  }

  async function executeRoutedFetch(candidate: ScoredWebSearchResult, query: string) {
    const currentCoverage = assessClaimCoverage(claims, evidence);
    const uncovered = claims.filter((claim) => currentCoverage.uncoveredClaims.includes(claim.text));
    const execution = await fetchWithProviderFallback({
      candidates: routeCandidates(queryRoute.providerRoutes, 'web_fetch'),
      intent,
      url: candidate.canonicalUrl,
      query,
      maxChunks: 6,
      signal: options.signal,
      accept: (page) => assessPageAgainstClaims(
        candidate,
        page,
        query,
        uncovered.length ? uncovered : claims
      ).verdict !== 'irrelevant'
    });
    providerAttempts.push(...execution.attempts);
    return { page: execution.value, provider: execution.provider };
  }
}

function providerContentPage(candidate: ScoredWebSearchResult): FetchPageResult {
  const content = candidate.content?.trim() ?? '';
  const chunks: FetchPageResult['chunks'] = [];
  for (let index = 0; index < content.length && chunks.length < 12; index += 1_200) {
    const value = content.slice(index, index + 1_200);
    chunks.push({ index: chunks.length, chars: value.length, content: value });
  }
  return {
    url: candidate.canonicalUrl,
    title: candidate.title,
    totalChars: content.length,
    content,
    truncated: false,
    chunks
  };
}

function assessPageAgainstClaims(
  candidate: ScoredWebSearchResult,
  page: FetchPageResult,
  searchQuery: string,
  claims: WebClaim[]
): ReturnType<typeof assessPageQuality> {
  const queries = [
    searchQuery,
    ...claims.flatMap((claim) => [claim.text, ...claim.evidenceGroups.flat()])
  ];
  return queries
    .map((query) => assessPageQuality(query, candidate, page))
    .sort((left, right) => right.score - left.score)[0]
    ?? { verdict: 'irrelevant', score: 0, chunks: [] };
}

function assessSubjectConsistency(claims: WebClaim[], chunks: string[]) {
  if (!claims.some((claim) => claim.subjectTerms.length)) return 1;
  if (!chunks.length) return 0;
  return chunks.filter((content) => claims.some((claim) => contentMatchesClaimSubject(claim, content))).length / chunks.length;
}

function buildBroadOverviewQuery(question: string) {
  return question
    .replace(/\s*(?:官方文档|官方资料|official documentation|official docs)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function mergeSearchScores(
  broad: ScoredWebSearchResult[],
  focused: ScoredWebSearchResult[]
): ScoredWebSearchResult[] {
  const broadByUrl = new Map(broad.map((result) => [result.canonicalUrl, result]));
  return focused
    .map((result) => {
      const broadResult = broadByUrl.get(result.canonicalUrl);
      if (!broadResult || broadResult.finalScore >= result.finalScore) return broadResult ?? result;
      return result;
    })
    .sort((left, right) => right.finalScore - left.finalScore);
}

function assessUserProvidedPage(page: FetchPageResult): ReturnType<typeof assessPageQuality> {
  if (page.totalChars < webQualityThresholds.minimumReadableChars || !page.content.trim()) {
    return { verdict: 'unreadable', score: 0, chunks: [] };
  }
  const chunks = (page.chunks?.length
    ? page.chunks
    : [{ index: 0, chars: page.content.length, content: page.content }])
    .slice(0, 4)
    .map((chunk) => ({ index: chunk.index, content: chunk.content, lexicalScore: 1, finalScore: 1 }));
  return { verdict: 'sufficient', score: 1, chunks };
}

function directUrlCandidate(rawUrl: string): ScoredWebSearchResult {
  const canonicalUrl = new URL(rawUrl).toString();
  const domain = new URL(canonicalUrl).hostname.toLowerCase();
  return {
    title: canonicalUrl,
    url: canonicalUrl,
    snippet: 'User-provided URL',
    score: 1,
    canonicalUrl,
    domain,
    providerScore: 1,
    lexicalScore: 1,
    completenessScore: 1,
    finalScore: 1
  };
}

function toRequiredClaim(need: RequiredEvidenceNeed): WebClaim {
  return { id: need.id, text: need.label, evidenceGroups: need.groups, subjectTerms: [] };
}

function toRagSource(
  url: string,
  title: string,
  domain: string,
  quality: ReturnType<typeof assessPageQuality>
): RagSource {
  const content = quality.chunks.map((chunk) => chunk.content).join('\n\n[...]\n\n');
  return {
    id: createHash('sha256').update(`${url}\n${content}`).digest('hex').slice(0, 32),
    file: url,
    title,
    heading: domain,
    content,
    startLine: 1,
    endLine: Math.max(1, content.split('\n').length),
    score: quality.score,
    contentType: 'text'
  };
}

function getRewriteReason(queryAttempts: QueryAttempt[], pageAttempts: PageAttempt[]) {
  const latestPages = pageAttempts.slice(-2);
  if (latestPages.some((page) => page.verdict === 'irrelevant')) {
    return 'The selected pages were not relevant enough to the original question.';
  }
  if (latestPages.some((page) => page.verdict === 'unreadable')) {
    return 'The selected pages could not provide readable evidence; search for another authoritative source.';
  }
  const latestSearch = queryAttempts.at(-1);
  if (latestSearch?.verdict === 'empty') return 'The search results were unrelated or empty.';
  return 'The available web evidence was related but not strong enough to answer confidently.';
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Web retrieval was cancelled');
  }
}
