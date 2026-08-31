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
import {
  assessClaimCoverage,
  type ClaimAssessment,
  type ClaimEvidence,
  type ClaimEvidenceReference,
  type WebClaim
} from './claims.js';
import { judgeWebEvidence, type EvidenceJudgment } from './evidenceJudge.js';
import {
  extractPageEntityEvidence,
  mergeEvidenceEntities,
  type EvidenceEntity
} from './evidenceEntities.js';
import { planWebEvidence, type WebEvidencePlan } from './evidencePlanner.js';
import { resolveSourceFreshness } from './freshness.js';
import { detectRetrievalIntent } from './intent.js';
import { buildRetrievalQueryRoute } from './routing.js';
import { enforceOfficialSourcePolicy, sourceAuthorityForClaims } from './sourcePolicy.js';
import type { LlmProvider } from '../llm/contracts.js';
import type { ToolProgress } from '../tools/contracts.js';
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
  maxQueries: z.number().int().min(1).max(12).optional(),
  maxPages: z.number().int().min(1).max(24).optional(),
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
  planner?: typeof planWebEvidence;
  judge?: typeof judgeWebEvidence;
  llm?: LlmProvider;
  now?: () => number;
};

export async function retrieveWebEvidence(
  args: unknown,
  options: {
    signal?: AbortSignal;
    dependencies?: WebRetrievalDependencies;
    onProgress?: (progress: ToolProgress) => void | Promise<void>;
    onSource?: (source: RagSource) => void | Promise<void>;
  } = {}
): Promise<WebRetrievalResult> {
  const input = inputSchema.parse(args);
  const now = options.dependencies?.now ?? Date.now;
  const startedAt = now();
  const currentDate = new Date(startedAt).toISOString().slice(0, 10);
  const intent = detectRetrievalIntent(input.question);
  const planner = options.dependencies?.planner ?? planWebEvidence;
  await reportProgress({
    stage: 'planning',
    kind: 'phase',
    status: 'running',
    message: '正在生成结构化证据计划'
  });
  const rawEvidencePlan = input.requiredEvidence?.length
    ? requiredEvidencePlan(input.question, input.requiredEvidence)
    : await planner(input.question, {
        signal: options.signal,
        llm: options.dependencies?.llm,
        currentDate
      });
  const evidencePlan = enforceOfficialSourcePolicy(rawEvidencePlan, input.question);
  await reportProgress({
    stage: 'planning',
    kind: 'phase',
    status: evidencePlan.planningFailure ? 'warning' : 'completed',
    message: evidencePlan.planningFailure
      ? `证据规划失败并已安全降级：${evidencePlan.planningFailure.message}；生成 ${evidencePlan.claims.length} 个待核查 Claim`
      : `证据计划已生成，共 ${evidencePlan.claims.length} 个待核查 Claim`,
    current: evidencePlan.claims.length,
    total: evidencePlan.claims.length,
    coveredClaims: 0,
    totalClaims: evidencePlan.claims.length
  });
  const queryRoute = buildRetrievalQueryRoute(intent, {
    question: input.question,
    explicitTimeRange: input.timeRange,
    includeDomains: input.includeDomains,
    plannedPreferredDomains: evidencePlan.preferredDomains
  });
  const isSingleDomainSearch = input.includeDomains?.length === 1;
  const claims: WebClaim[] = evidencePlan.claims;
  const isBroadMultiClaimQuestion = claims.length >= 5;
  const plannedQueryCount = new Set(evidencePlan.claims.flatMap((claim) => claim.searchQueries.map(normalizeQuery))).size;
  const canExpandForUncoveredClaims = input.maxPages === undefined
    && isBroadMultiClaimQuestion;
  // A domain-constrained request cannot gain confidence through cross-domain corroboration,
  // so give it more room to locate the exact page within that authority. Broad
  // multi-part questions also need more than the three-query single-fact budget.
  const queryBudget = input.maxQueries ?? (evidencePlan.planningMethod === 'llm'
    ? Math.min(12, Math.max(4, plannedQueryCount + 1))
    : isBroadMultiClaimQuestion ? 8 : isSingleDomainSearch ? 5 : 4);
  let pageBudget = input.maxPages ?? (evidencePlan.planningMethod === 'llm'
    ? Math.min(20, Math.max(isSingleDomainSearch ? 8 : 6, claims.length * 2 + 2))
    : isBroadMultiClaimQuestion ? 12 : isSingleDomainSearch ? 8 : 6);
  const maximumPageBudget = canExpandForUncoveredClaims ? Math.min(24, pageBudget + 4) : pageBudget;
  const recoveryEligibleClaims = claims.filter(isCompanyAnnouncementClaim);
  const recoveryQueryBudget = input.maxQueries === undefined && recoveryEligibleClaims.length >= 2
    ? Math.min(4, recoveryEligibleClaims.length)
    : 0;
  const baseFetchAttemptBudget = Math.min(48, Math.max(pageBudget, pageBudget * 2));
  const fetchAttemptBudget = Math.min(56, baseFetchAttemptBudget + recoveryQueryBudget * 2);
  const injectedSearch = options.dependencies?.search;
  const injectedFetch = options.dependencies?.fetch;
  const rewrite = options.dependencies?.rewrite ?? rewriteWebQuery;
  const judge = options.dependencies?.judge ?? judgeWebEvidence;
  // The first official-docs query is domain constrained. Preserve one broad
  // overview query before gap-focused rewrites so comprehensive implementation
  // guides can still be discovered across the open web.
  const pendingQueries = [
    ...queryRoute.initialQueries,
    ...evidencePlan.claims.flatMap((claim) => claim.searchQueries),
    ...(input.maxQueries === undefined && isBroadMultiClaimQuestion && queryRoute.preferredDomains?.length
      ? [buildBroadOverviewQuery(input.question)]
      : [])
  ];
  const plannedQueryOwners = new Map(evidencePlan.claims.flatMap((claim) =>
    claim.searchQueries.map((query) => [normalizeQuery(query), claim.id] as const)
  ));
  const seenQueries = new Set<string>();
  const fetchedUrls = new Set<string>();
  const evidenceDomains = new Set<string>();
  const queryAttempts: QueryAttempt[] = [];
  const pageAttempts: PageAttempt[] = [];
  const sources: RagSource[] = [];
  const pageScores: number[] = [];
  const evidence: ClaimEvidence[] = [];
  const evidenceEntities: EvidenceEntity[] = [];
  const providerAttempts: ProviderAttempt[] = [];
  let recoveryTriggered = false;
  let recoveryQueriesUsed = 0;
  let budgetExhaustedBy: WebRetrievalResult['diagnostics']['budgetExhaustedBy'];
  let stopReason = 'No usable web evidence was found';

  for (const url of queryRoute.directFetchUrls.slice(0, pageBudget)) {
    throwIfAborted(options.signal);
    const candidate = directUrlCandidate(url);
    fetchedUrls.add(candidate.canonicalUrl);
    await reportProgress({
      stage: 'fetching',
      kind: 'page',
      status: 'running',
      message: `正在抓取页面 ${fetchedUrls.size}/${pageBudget}`,
      url: candidate.canonicalUrl,
      title: candidate.title,
      current: fetchedUrls.size,
      total: pageBudget,
      coveredClaims: supportedClaimCount(),
      totalClaims: claims.length
    });
    await fetchCandidate(candidate, true);
    const pageAttempt = pageAttempts.at(-1);
    const accepted = pageAttempt?.url === candidate.canonicalUrl
      && pageAttempt.verdict !== 'irrelevant'
      && pageAttempt.verdict !== 'unreadable';
    await reportProgress({
      stage: 'judging',
      kind: 'evidence',
      status: accepted ? 'completed' : 'warning',
      message: accepted ? '页面已通过证据核验并加入来源' : '页面未能提供可用证据',
      detail: pageAttempt?.error,
      url: candidate.canonicalUrl,
      title: pageAttempt?.title || candidate.title,
      coveredClaims: supportedClaimCount(),
      totalClaims: claims.length
    });
    await reportCoverage('页面抓取与证据判断已完成');
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
    if (hasOptionalClaims() && blockingClaimsSupported() && sources.length) {
      stopReason = 'All blocking claims were supported; optional evidence gaps do not block answer generation';
      return buildResult('sufficient');
    }
    let query: string | undefined;
    while (pendingQueries.length && !query) {
      const candidate = pendingQueries.shift();
      if (!candidate) continue;
      const owner = plannedQueryOwners.get(normalizeQuery(candidate));
      const ownerIsCovered = owner && assessClaimCoverage(claims, evidence).claims
        .some((claim) => claim.id === owner && claim.supported);
      if (!ownerIsCovered) query = candidate;
    }
    if (!query) {
      const uncoveredClaims = assessClaimCoverage(claims, evidence).uncoveredBlockingClaims;
      await reportProgress({
        stage: 'rewriting',
        kind: 'rewrite',
        status: 'running',
        message: `现有证据仍有 ${uncoveredClaims.length} 个缺口，正在调整检索方向`,
        detail: getRewriteReason(queryAttempts, pageAttempts),
        coveredClaims: supportedClaimCount(),
        totalClaims: claims.length
      });
      query = await rewrite({
        question: input.question,
        previousQueries: queryAttempts.map((attempt) => attempt.query),
        reason: getRewriteReason(queryAttempts, pageAttempts),
        uncoveredClaims,
        signal: options.signal,
        llm: options.dependencies?.llm,
        currentDate
      });
      if (query) {
        await reportProgress({
          stage: 'rewriting',
          kind: 'rewrite',
          status: 'completed',
          message: '已生成新的聚焦检索词',
          query,
          coveredClaims: supportedClaimCount(),
          totalClaims: claims.length
        });
      }
    }
    if (!query || seenQueries.has(normalizeQuery(query))) {
      stopReason = 'No distinct query rewrite was available';
      break;
    }

    await executeSearchQuery(query);

    const coverage = assessClaimCoverage(claims, evidence);
    // Evaluation supplies explicit facts. Once every one is supported, do not
    // spend the remaining generic confidence budget on redundant pages.
    if (input.requiredEvidence?.length && coverage.supportedClaimRatio === 1) {
      stopReason = 'All required evidence points were supported; stopped before budget exhaustion';
      return buildResult('sufficient');
    }
    if (hasOptionalClaims() && coverage.supportedBlockingClaimRatio === 1 && sources.length) {
      stopReason = 'All blocking claims were supported; optional evidence gaps do not block answer generation';
      return buildResult('sufficient');
    }
    // A deliberately unanswerable, domain-constrained question should not burn
    // the full four-query budget after two precise searches found no usable page.
    if (input.expectNoAnswer && queryAttempts.length >= 2 && sources.length === 0) {
      stopReason = 'Two precise searches found no usable official evidence for an expected-unanswerable question';
      return buildResult('empty');
    }
    if (hasSufficientEvidence(coverage)) {
      stopReason = evidenceDomains.size >= 2
        ? 'Relevant evidence was confirmed across independent domains'
        : 'A high-confidence relevant source was found';
      return buildResult('sufficient');
    }
    if (sources.length >= pageBudget) {
      if (pageBudget < maximumPageBudget && coverage.uncoveredBlockingClaims.length) {
        pageBudget = maximumPageBudget;
        stopReason = 'Expanded page budget for uncovered claims in a broad question';
        continue;
      }
      stopReason = coverage.uncoveredBlockingClaims.length
        ? 'Accepted-evidence page budget exhausted before all question claims were supported'
        : 'Accepted-evidence page budget exhausted before evidence became sufficient';
      break;
    }
    if (fetchedUrls.size >= baseFetchAttemptBudget) {
      stopReason = 'Primary fetch-attempt budget exhausted; preparing focused recovery searches';
      break;
    }
  }

  const primaryQueriesUsed = seenQueries.size;
  const primaryBudgetExhausted = primaryQueriesUsed >= queryBudget
    || fetchedUrls.size >= baseFetchAttemptBudget
    || sources.length >= pageBudget;
  const recoveryClaims = uncoveredRecoveryClaims();
  if (recoveryQueryBudget > 0 && recoveryClaims.length && !hasSufficientEvidence()) {
    recoveryTriggered = true;
    await reportProgress({
      stage: 'searching',
      message: `常规检索未覆盖全部公司，开始官网逐家公司恢复检索（最多 ${recoveryQueryBudget} 次）`,
      current: 0,
      total: recoveryQueryBudget,
      coveredClaims: supportedClaimCount(),
      totalClaims: claims.length
    });
    for (const claim of recoveryClaims.slice(0, recoveryQueryBudget)) {
      if (fetchedUrls.size >= fetchAttemptBudget) break;
      const query = buildCompanyRecoveryQuery(claim, currentDate, seenQueries);
      if (!query) continue;
      recoveryQueriesUsed += 1;
      await executeSearchQuery(query, claim.preferredDomains, true);
      if (hasSufficientEvidence()) {
        stopReason = 'Focused official-company recovery searches supplied sufficient evidence';
        return buildResult('sufficient');
      }
    }
    stopReason = assessClaimCoverage(claims, evidence).uncoveredBlockingClaims.length
      ? 'Focused official-company recovery completed with unresolved claims'
      : 'Focused official-company recovery completed but confidence remained below the sufficiency threshold';
  }

  const queryBudgetExhausted = primaryQueriesUsed >= queryBudget;
  const pageBudgetExhausted = sources.length >= pageBudget;
  const fetchAttemptBudgetExhausted = fetchedUrls.size >= (recoveryTriggered ? fetchAttemptBudget : baseFetchAttemptBudget);
  const budgetExhausted = primaryBudgetExhausted || queryBudgetExhausted || pageBudgetExhausted || fetchAttemptBudgetExhausted;
  budgetExhaustedBy = queryBudgetExhausted && fetchAttemptBudgetExhausted
    ? 'queries-and-page-attempts'
    : queryBudgetExhausted && pageBudgetExhausted
      ? 'queries-and-pages'
      : queryBudgetExhausted
      ? 'queries'
      : pageBudgetExhausted
        ? 'pages'
        : fetchAttemptBudgetExhausted
          ? 'page-attempts'
        : undefined;
  if (recoveryTriggered) {
    // Keep the more actionable recovery outcome set above; the structured
    // budget field still records which primary limit was reached.
  } else if (budgetExhaustedBy === 'queries-and-pages') {
    stopReason = 'Combined query and page budget exhausted before evidence became sufficient';
  } else if (budgetExhaustedBy === 'queries') {
    stopReason = 'Query budget exhausted before evidence became sufficient';
  } else if (budgetExhaustedBy === 'pages') {
    stopReason = 'Accepted-evidence page budget exhausted before evidence became sufficient';
  } else if (budgetExhaustedBy === 'page-attempts') {
    stopReason = 'Fetch-attempt budget exhausted before evidence became sufficient';
  } else if (budgetExhaustedBy === 'queries-and-page-attempts') {
    stopReason = 'Combined query and fetch-attempt budget exhausted before evidence became sufficient';
  }
  const discoveredCandidates = queryAttempts.some((attempt) => attempt.resultCount > 0);
  const rejectedCandidates = pageAttempts.length > sources.length;
  return buildResult(sources.length
    ? (budgetExhausted || recoveryTriggered ? 'exhausted' : 'weak')
    : (budgetExhausted || recoveryTriggered || discoveredCandidates || rejectedCandidates ? 'exhausted' : 'empty'));

  function buildResult(verdict: WebRetrievalResult['verdict']): WebRetrievalResult {
    const coverage = assessClaimCoverage(claims, evidence);
    const mergedEntities = mergeEvidenceEntities(evidenceEntities);
    const answerClaims = coverage.claims.map((claim) => enrichClaimAnswerEvidence(claim, sources, pageAttempts));
    const supportedClaimIds = new Set(answerClaims.filter((claim) => claim.supported).map((claim) => claim.id));
    return {
      question: input.question,
      evidencePlan,
      intent,
      queryRoute,
      verdict,
      score: Math.max(0, ...pageScores),
      retrievalQueries: queryAttempts.map((attempt) => attempt.query),
      queryAttempts,
      pageAttempts,
      sources,
      claims: answerClaims,
      conflicts: coverage.conflicts,
      coverageScore: coverage.coverageScore,
      coveredClaimCount: coverage.claims.filter((claim) => claim.supported).length,
      totalClaimCount: coverage.claims.length,
      uncoveredClaims: coverage.uncoveredClaims,
      uncoveredBlockingClaims: coverage.uncoveredBlockingClaims,
      evidenceEntities: mergedEntities,
      requiredMentions: mergedEntities.filter((entity) =>
        entity.requiredMention && entity.claimIds.some((claimId) => supportedClaimIds.has(claimId))
      ),
      diagnostics: {
        queriesUsed: queryAttempts.length,
        pagesFetched: fetchedUrls.size,
        queryBudget,
        pageBudget,
        fetchAttemptBudget,
        acceptedPages: sources.length,
        rejectedPages: Math.max(0, pageAttempts.length - sources.length),
        recoveryTriggered,
        recoveryQueriesUsed,
        ...(evidencePlan.planningFailure ? { planningFailure: evidencePlan.planningFailure } : {}),
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
        ])],
        authorityRejectedUrls: pageAttempts
          .filter((attempt) => attempt.authority === 'third_party' && attempt.error?.includes('official publisher'))
          .map((attempt) => attempt.url),
        freshnessRejectedUrls: pageAttempts
          .filter((attempt) => attempt.freshnessStatus === 'outside_window' || attempt.freshnessStatus === 'future_date')
          .map((attempt) => attempt.url),
        undatedThirdPartyUrls: pageAttempts
          .filter((attempt) => attempt.freshnessStatus === 'unknown' && attempt.authority !== 'official')
          .map((attempt) => attempt.url)
      }
    };
  }

  async function executeSearchQuery(
    query: string,
    overrideDomains?: string[],
    recovery = false
  ) {
    seenQueries.add(normalizeQuery(query));
    const queryTotal = queryBudget + (recoveryTriggered ? recoveryQueryBudget : 0);
    await reportProgress({
      stage: 'searching',
      kind: 'search',
      status: 'running',
      message: recovery
        ? `正在执行官网恢复检索 ${recoveryQueriesUsed}/${recoveryQueryBudget}`
        : `正在执行检索 ${Math.min(seenQueries.size, queryBudget)}/${queryBudget}`,
      query,
      current: seenQueries.size,
      total: queryTotal,
      coveredClaims: supportedClaimCount(),
      totalClaims: claims.length
    });
    const searchDepth = recovery || (seenQueries.size > 1 && seenQueries.size >= queryBudget) ? 'advanced' : 'basic';
    const searchOptions: WebSearchOptions = {
      searchDepth,
      timeRange: input.timeRange ?? queryRoute.inferredTimeRange,
      includeDomains: input.includeDomains
        ?? overrideDomains
        ?? (seenQueries.size === 1
          ? queryRoute.preferredDomains
          : preferredDomainsForQuery(query, claims, assessClaimCoverage(claims, evidence).uncoveredBlockingClaims)),
      excludeDomains: input.excludeDomains
    };
    const response = injectedSearch
      ? await injectedSearch({ query, limit: 8 }, options.signal, searchOptions)
      : await executeRoutedSearch(query, searchOptions, !recovery && seenQueries.size === 1 && intent.officialDocs.matched);
    const scoreDomains = overrideDomains ?? queryRoute.preferredDomains;
    const scoredForQuestion = scoreSearchResults(input.question, response.results, scoreDomains);
    const scoredForQuery = normalizeQuery(query) === normalizeQuery(input.question)
      ? scoredForQuestion
      : scoreSearchResults(query, response.results, scoreDomains);
    const scored = mergeSearchScores(scoredForQuestion, scoredForQuery);
    const assessment = assessSearchQuality(scored);
    const attemptLimit = recovery ? fetchAttemptBudget : baseFetchAttemptBudget;
    const remainingAttempts = attemptLimit - fetchedUrls.size;
    const selected = remainingAttempts > 0
      ? selectDiverseSearchResults(scored, fetchedUrls, Math.min(2, remainingAttempts))
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
    await reportProgress({
      stage: 'searching',
      kind: 'search',
      status: assessment.verdict === 'empty' ? 'warning' : 'completed',
      message: selected.length
        ? `检索完成，找到 ${scored.length} 条候选结果，选择 ${selected.length} 页继续核验`
        : `检索完成，${scored.length ? '没有候选页面通过质量筛选' : '没有返回可用结果'}`,
      query,
      detail: response.provider ? `检索服务：${response.provider}` : undefined,
      current: seenQueries.size,
      total: queryTotal,
      coveredClaims: supportedClaimCount(),
      totalClaims: claims.length
    });

    for (const candidate of selected) {
      throwIfAborted(options.signal);
      fetchedUrls.add(candidate.canonicalUrl);
      await reportProgress({
        stage: 'fetching',
        kind: 'page',
        status: 'running',
        message: `正在抓取候选页面 ${fetchedUrls.size}/${attemptLimit}（已接纳 ${sources.length}/${pageBudget}）`,
        url: candidate.canonicalUrl,
        title: candidate.title,
        current: fetchedUrls.size,
        total: attemptLimit,
        coveredClaims: supportedClaimCount(),
        totalClaims: claims.length
      });
      await fetchCandidate(candidate, false, query);
      const pageAttempt = pageAttempts.at(-1);
      const accepted = pageAttempt?.url === candidate.canonicalUrl
        && pageAttempt.verdict !== 'irrelevant'
        && pageAttempt.verdict !== 'unreadable'
        && !pageAttempt.subjectMismatch;
      await reportProgress({
        stage: 'judging',
        kind: 'evidence',
        status: accepted ? 'completed' : 'warning',
        message: accepted ? '页面已通过证据核验并加入来源' : '页面未通过证据核验',
        detail: pageAttempt?.error ?? (pageAttempt ? `判定：${pageAttempt.verdict}` : undefined),
        url: candidate.canonicalUrl,
        title: pageAttempt?.title || candidate.title,
        coveredClaims: supportedClaimCount(),
        totalClaims: claims.length
      });
      await reportCoverage('页面抓取与证据判断已完成');
    }
  }

  function hasSufficientEvidence(coverage = assessClaimCoverage(claims, evidence)) {
    return isEvidenceSufficient(pageScores, evidenceDomains)
      && coverage.supportedBlockingClaimRatio >= webQualityThresholds.claimCoverageSufficient
      && coverage.blockingCoverageScore >= webQualityThresholds.claimSupportScore
      && coverage.subjectConsistencyRate >= webQualityThresholds.subjectConsistencySufficient
      && coverage.subjectMismatchUrls.length === 0;
  }

  function uncoveredRecoveryClaims() {
    const uncovered = new Set(assessClaimCoverage(claims, evidence).uncoveredBlockingClaims);
    return recoveryEligibleClaims.filter((claim) => uncovered.has(claim.text));
  }

  async function fetchCandidate(
    candidate: ScoredWebSearchResult,
    userProvided = false,
    searchQuery = input.question
  ) {
    try {
      const currentCoverage = assessClaimCoverage(claims, evidence);
      const uncovered = claims.filter((claim) => currentCoverage.uncoveredBlockingClaims.includes(claim.text));
      const pageQuestion = [
        candidate.title,
        candidate.snippet,
        searchQuery,
        ...uncovered.flatMap((claim) => [claim.text, ...claim.searchQueries])
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
      const relevantClaims = uncovered.length ? uncovered : claims;
      const authority = sourceAuthorityForClaims(relevantClaims, candidate.canonicalUrl);
      const freshness = resolveSourceFreshness({
        candidate,
        page,
        timeRange: input.timeRange ?? queryRoute.inferredTimeRange,
        nowMs: startedAt
      });
      const authorityRejected = !userProvided
        && relevantClaims.length > 0
        && relevantClaims.every((claim) => claim.requiredAuthority === 'official')
        && authority !== 'official';
      const freshnessRejected = !userProvided && (
        freshness.status === 'outside_window'
        || freshness.status === 'future_date'
        || (freshness.status === 'unknown' && authority !== 'official')
      );
      if (authorityRejected || freshnessRejected) {
        pageAttempts.push({
          url: candidate.canonicalUrl,
          title: page.title || candidate.title,
          domain: candidate.domain,
          verdict: 'irrelevant',
          score: 0,
          selectedChunkCount: quality.chunks.length,
          ...(fetched.provider ? { provider: fetched.provider } : {}),
          authority,
          ...(freshness.publishedAt ? { publishedAt: freshness.publishedAt } : {}),
          freshnessStatus: freshness.status,
          error: authorityRejected
            ? 'Source is not an approved official publisher for the planned announcement Claim'
            : freshness.status === 'unknown'
              ? 'Third-party source has no verifiable publication date for the requested freshness window'
              : `Source publication date does not satisfy the requested ${input.timeRange ?? queryRoute.inferredTimeRange} window`
        });
        return;
      }
      const judgments = quality.chunks.length && !input.requiredEvidence?.length
        ? await judgeAfterProgress({
            question: input.question,
            url: candidate.canonicalUrl,
            title: page.title || candidate.title,
            claims: relevantClaims,
            chunks: quality.chunks.map((chunk) => ({
              index: chunk.index,
              content: chunk.content,
              pageTitle: chunk.pageTitle,
              canonicalUrl: chunk.canonicalUrl,
              domain: chunk.domain,
              publishedAt: chunk.publishedAt,
              pageEntityCandidates: chunk.pageEntityCandidates
            })),
            signal: options.signal,
            llm: options.dependencies?.llm
          })
        : [];
      const pageEntities = extractPageEntityEvidence({
        url: candidate.canonicalUrl,
        title: page.title || candidate.title,
        content: [page.title || candidate.title, ...quality.chunks.map((chunk) => chunk.content)].join('\n'),
        claims: relevantClaims,
        publishedAt: freshness.publishedAt
      });
      const exactEntityMatch = pageEntities.some((entity) => entity.exactEntityMatch);
      const effectiveJudgments = exactEntityMatch
        ? judgments.map((judgment) => ({
            ...judgment,
            subjectMatched: true,
            reason: `${judgment.reason} Exact official release entity matched the page title and canonical URL.`.trim()
          }))
        : judgments;
      const subjectConsistencyScore = assessJudgmentSubjectConsistency(relevantClaims, effectiveJudgments);
      const subjectMismatch = !userProvided
        && effectiveJudgments.length > 0
        && !exactEntityMatch
        && subjectConsistencyScore < webQualityThresholds.pageSubjectConsistency;
      pageAttempts.push({
        url: candidate.canonicalUrl,
        title: page.title || candidate.title,
        domain: candidate.domain,
        verdict: quality.verdict,
        score: quality.score,
        selectedChunkCount: quality.chunks.length,
        ...(fetched.provider ? { provider: fetched.provider } : {}),
        subjectConsistencyScore,
        subjectMismatch,
        authority,
        ...(freshness.publishedAt ? { publishedAt: freshness.publishedAt } : {}),
        freshnessStatus: freshness.status,
        ...(exactEntityMatch ? { exactEntityMatch: true, evidenceStrength: 'direct' as const } : {}),
        ...(pageEntities.length ? { entityCandidates: pageEntities.map((entity) => entity.entity) } : {})
      });

      if (quality.verdict === 'irrelevant' || quality.verdict === 'unreadable' || subjectMismatch) return;
      if (!userProvided && !input.requiredEvidence?.length
        && effectiveJudgments.every((judgment) => judgment.relation === 'irrelevant')
        && !pageEntities.length) return;
      pageScores.push(quality.score);
      // Keep chunks independent. Joining them here would allow a subject mention
      // in one section to validate an unrelated fact from another section.
      evidence.push(...quality.chunks.map((chunk) => ({
        url: candidate.canonicalUrl,
        content: chunk.content,
        chunkIndex: chunk.index,
        judgments: effectiveJudgments.filter((judgment) => judgment.chunkIndex === chunk.index),
        authority,
        ...(freshness.publishedAt ? { publishedAt: freshness.publishedAt } : {}),
        freshnessStatus: freshness.status
      })));
      evidenceDomains.add(candidate.domain);
      evidenceEntities.push(...pageEntities);
      const acceptedSource = toRagSource(candidate.canonicalUrl, page.title || candidate.title, candidate.domain, quality);
      sources.push(acceptedSource);
      await options.onSource?.(acceptedSource);
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

  async function judgeAfterProgress(input: Parameters<typeof judge>[0]) {
    await reportProgress({
      stage: 'judging',
      kind: 'evidence',
      status: 'running',
      message: `正在判断页面证据 ${fetchedUrls.size}/${pageBudget}`,
      url: input.url,
      title: input.title,
      current: fetchedUrls.size,
      total: pageBudget,
      coveredClaims: supportedClaimCount(),
      totalClaims: claims.length
    });
    return judge(input);
  }

  async function reportCoverage(message: string) {
    const coveredClaims = supportedClaimCount();
    await reportProgress({
      stage: 'coverage',
      kind: 'coverage',
      status: coveredClaims >= claims.length ? 'completed' : 'running',
      message: `${message}，当前覆盖 ${coveredClaims}/${claims.length}`,
      current: fetchedUrls.size,
      total: pageBudget,
      coveredClaims,
      totalClaims: claims.length
    });
  }

  function supportedClaimCount() {
    return assessClaimCoverage(claims, evidence).claims.filter((claim) => claim.supported).length;
  }

  function blockingClaimsSupported() {
    return assessClaimCoverage(claims, evidence).supportedBlockingClaimRatio === 1;
  }

  function hasOptionalClaims() {
    return claims.some((claim) => claim.blocking === false);
  }

  async function reportProgress(progress: ToolProgress) {
    throwIfAborted(options.signal);
    await options.onProgress?.(progress);
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
    const uncovered = claims.filter((claim) => currentCoverage.uncoveredBlockingClaims.includes(claim.text));
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
    ...claims.flatMap((claim) => [
      claim.text,
      ...claim.searchQueries,
      ...(claim.evidenceGroups?.flat() ?? [])
    ])
  ];
  return queries
    .map((query) => assessPageQuality(query, candidate, page))
    .sort((left, right) => right.score - left.score)[0]
    ?? { verdict: 'irrelevant', score: 0, chunks: [] };
}

function assessJudgmentSubjectConsistency(claims: WebClaim[], judgments: EvidenceJudgment[]) {
  if (!claims.some((claim) => claim.subjectTerms.length)) return 1;
  const relevant = judgments.filter((judgment) => judgment.relation !== 'irrelevant');
  if (!relevant.length) return judgments.length && judgments.every((judgment) => !judgment.subjectMatched) ? 0 : 1;
  return relevant.filter((judgment) => judgment.subjectMatched).length / relevant.length;
}

function buildBroadOverviewQuery(question: string) {
  return question
    .replace(/\s*(?:官方文档|官方资料|official documentation|official docs)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function isCompanyAnnouncementClaim(claim: WebClaim) {
  return claim.preferredDomains.length > 0
    && claim.sourceTypes.some((type) => type === 'official_announcement');
}

function buildCompanyRecoveryQuery(claim: WebClaim, currentDate: string, seenQueries: Set<string>) {
  const subject = claim.subjectTerms[0] ?? claim.text;
  const year = currentDate.slice(0, 4);
  const candidates = [
    `${subject} ${year} official newsroom new model announced released`,
    `${subject} ${year} official model release notes latest`,
    ...claim.searchQueries.map((query) => `${query} ${year}`)
  ];
  return candidates.find((query) => !seenQueries.has(normalizeQuery(query)));
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

function requiredEvidencePlan(question: string, needs: RequiredEvidenceNeed[]): WebEvidencePlan {
  return {
    subject: question.slice(0, 160),
    claims: needs.map((need) => ({
      id: need.id,
      text: need.label,
      evidenceGroups: need.groups,
      searchQueries: [need.label],
      preferredDomains: [],
      sourceTypes: [],
      subjectTerms: []
    })),
    preferredDomains: [],
    planningMethod: 'caller-required-evidence'
  };
}

function preferredDomainsForQuery(query: string, claims: WebClaim[], uncoveredClaims: string[]) {
  const uncovered = new Set(uncoveredClaims);
  const matched = claims.filter((claim) =>
    uncovered.has(claim.text)
    && claim.searchQueries.some((planned) => normalizeQuery(planned) === normalizeQuery(query))
  );
  const domains = [...new Set(matched.flatMap((claim) => claim.preferredDomains))];
  return domains.length ? domains : undefined;
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

function enrichClaimAnswerEvidence(
  claim: ClaimAssessment,
  sources: RagSource[],
  pageAttempts: PageAttempt[]
): ClaimAssessment {
  if (!claim.supported || !isPricingClaim(claim.text)) return claim;
  const additions: ClaimEvidenceReference[] = [];
  for (const source of sources) {
    if (!claim.sourceUrls.includes(source.file)) continue;
    const attempt = pageAttempts.find((item) => item.url === source.file);
    for (const quote of extractPricingSegments(source.content)) {
      additions.push({
        url: source.file,
        relation: 'supports',
        confidence: Math.max(0.65, claim.score),
        evidenceQuote: quote,
        authority: attempt?.authority ?? 'unverified',
        ...(attempt?.publishedAt ? { publishedAt: attempt.publishedAt } : {}),
        ...(attempt?.freshnessStatus ? { freshnessStatus: attempt.freshnessStatus } : {})
      });
    }
  }
  if (!additions.length) return claim;
  const byQuote = new Map<string, ClaimEvidenceReference>();
  for (const item of [...claim.supportingEvidence, ...additions]) {
    const key = `${item.url}:${item.evidenceQuote.replace(/\s+/g, ' ').trim()}`;
    if (!byQuote.has(key)) byQuote.set(key, item);
  }
  return { ...claim, supportingEvidence: [...byQuote.values()].slice(0, 12) };
}

function isPricingClaim(value: string) {
  return /价格|价钱|定价|费用|成本|收费|多少钱|\bpric(?:e|ing)\b|\bcosts?\b/iu.test(value);
}

/** Extracts exact, entity-labelled pricing blocks from an already accepted source. */
function extractPricingSegments(content: string) {
  const lines = content.split('\n');
  const modelIndexes = lines.flatMap((line, index) => isModelHeading(line) ? [index] : []);
  const segments: string[] = [];
  for (let position = 0; position < modelIndexes.length; position += 1) {
    const start = modelIndexes[position]!;
    const next = modelIndexes[position + 1] ?? Math.min(lines.length, start + 36);
    const end = Math.min(next, start + 36);
    const block = lines.slice(start, end).join('\n').trim();
    if (!containsPriceValue(block)) continue;
    segments.push(block.slice(0, 1_000));
  }
  if (!segments.length) {
    for (let index = 0; index < lines.length && segments.length < 8; index += 1) {
      if (!containsPriceValue(lines[index] ?? '')) continue;
      const block = lines.slice(Math.max(0, index - 10), Math.min(lines.length, index + 12)).join('\n').trim();
      if (block) segments.push(block.slice(0, 1_000));
    }
  }
  const normalized = new Set<string>();
  return segments.filter((segment) => {
    const key = segment.replace(/\s+/g, ' ').trim();
    if (normalized.has(key)) return false;
    normalized.add(key);
    return true;
  }).slice(0, 8);
}

function isModelHeading(raw: string) {
  const value = raw.replace(/^#{1,6}\s*/, '').trim();
  if (value.length < 3 || value.length > 100 || /[$€£¥￥]/u.test(value)) return false;
  return /(?:\d|mini|nano|opus|sonnet|haiku|realtime|image)/iu.test(value)
    && /^[\p{L}\p{N}][\p{L}\p{N} ._+:/()-]+$/u.test(value)
    && !/^(?:input|output|cached|context|window|max|tier|price|pricing|rate|tokens?|输入|输出|价格|定价)/iu.test(value);
}

function containsPriceValue(value: string) {
  return /[$€£¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:USD|CNY|RMB|美元|元)\b/iu.test(value);
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
