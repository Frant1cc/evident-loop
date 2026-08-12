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
import { assessClaimCoverage, extractWebClaims, type ClaimEvidence, type WebClaim } from './claims.js';
import type { PageAttempt, QueryAttempt, RequiredEvidenceNeed, WebRetrievalResult } from './types.js';

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
) => Promise<{ query: string; results: WebSearchResult[] }>;

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
  const isSingleDomainSearch = input.includeDomains?.length === 1;
  // A domain-constrained request cannot gain confidence through cross-domain corroboration,
  // so give it more room to locate the exact page within that authority.
  const queryBudget = input.maxQueries ?? (isSingleDomainSearch ? 4 : 3);
  const pageBudget = input.maxPages ?? (isSingleDomainSearch ? 8 : 5);
  const search = options.dependencies?.search ?? webSearch;
  const fetch = options.dependencies?.fetch ?? fetchPage;
  const rewrite = options.dependencies?.rewrite ?? rewriteWebQuery;
  const now = options.dependencies?.now ?? Date.now;
  const startedAt = now();
  const claims: WebClaim[] = input.requiredEvidence?.length
    ? input.requiredEvidence.map(toRequiredClaim)
    : extractWebClaims(input.question);
  const pendingQueries = [input.question];
  const seenQueries = new Set<string>();
  const fetchedUrls = new Set<string>();
  const evidenceDomains = new Set<string>();
  const queryAttempts: QueryAttempt[] = [];
  const pageAttempts: PageAttempt[] = [];
  const sources: RagSource[] = [];
  const pageScores: number[] = [];
  const evidence: ClaimEvidence[] = [];
  let budgetExhaustedBy: WebRetrievalResult['diagnostics']['budgetExhaustedBy'];
  let stopReason = 'No usable web evidence was found';

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
    const response = await search(
      { query, limit: 8 },
      options.signal,
      {
        searchDepth,
        timeRange: input.timeRange,
        includeDomains: input.includeDomains,
        excludeDomains: input.excludeDomains
      }
    );
    const scored = scoreSearchResults(input.question, response.results);
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
      selectedUrls: selected.map((result) => result.canonicalUrl)
    });

    for (const candidate of selected) {
      throwIfAborted(options.signal);
      fetchedUrls.add(candidate.canonicalUrl);
      try {
        const currentCoverage = assessClaimCoverage(claims, evidence);
        const pageQuestion = [input.question, ...currentCoverage.uncoveredClaims].join('\n');
        const page = await fetch(
          { url: candidate.canonicalUrl, query: pageQuestion, maxChunks: 6 },
          options.signal
        );
        const quality = assessPageQuality(pageQuestion, candidate, page);
        pageAttempts.push({
          url: candidate.canonicalUrl,
          title: page.title || candidate.title,
          domain: candidate.domain,
          verdict: quality.verdict,
          score: quality.score,
          selectedChunkCount: quality.chunks.length
        });

        if (quality.verdict === 'irrelevant' || quality.verdict === 'unreadable') continue;
        pageScores.push(quality.score);
        evidence.push({ url: candidate.canonicalUrl, content: quality.chunks.map((chunk) => chunk.content).join('\n\n') });
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
      coverage.coverageScore >= webQualityThresholds.claimSupportScore
    ) {
      stopReason = evidenceDomains.size >= 2
        ? 'Relevant evidence was confirmed across independent domains'
        : 'A high-confidence relevant source was found';
      return buildResult('sufficient');
    }
    if (fetchedUrls.size >= pageBudget) {
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
        stopReason
      }
    };
  }
}

function toRequiredClaim(need: RequiredEvidenceNeed): WebClaim {
  return { id: need.id, text: need.label, evidenceGroups: need.groups };
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
