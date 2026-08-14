import type { WebRetrievalResult } from '../types.js';
import type { WebEvalCase, WebEvalEvidenceNeed } from './fixtures.js';

export type WebEvalCaseResult = {
  id: string;
  title: string;
  question: string;
  category: WebEvalCase['category'];
  answerable: boolean;
  verdict: WebRetrievalResult['verdict'];
  score: number;
  hitAtK: number;
  reciprocalRank: number;
  evidencePrecision: number;
  evidenceRecall: number;
  falseSufficient: boolean;
  passed: boolean;
  supportedNeeds: Array<{ id: string; label: string; supported: boolean }>;
  retrieved: Array<{ rank: number; title: string; url: string; domain: string; score: number; relevant: boolean; supportedNeedIds: string[] }>;
  queryCount: number;
  pageCount: number;
  durationMs: number;
  coverageScore: number;
  retrievalQueries: string[];
  stopReason: string;
  firstQueryHit: boolean;
  rewriteTriggered: boolean;
  rewriteRecovered: boolean;
  budgetExhausted: boolean;
  officialSourceRate: number;
  pageExtractionSuccessRate: number;
  subjectConsistencyRate: number;
  subjectMismatchUrls: string[];
  failureReason: WebEvalFailureReason;
  uncoveredNeedLabels: string[];
};

export type WebEvalFailureReason = 'passed' | 'false_sufficient' | 'subject_mismatch' | 'budget_exhausted' | 'no_sources' | 'official_source_missing' | 'evidence_gap' | 'low_rank';

export type WebEvalMetrics = {
  caseCount: number;
  passRate: number;
  hitAtK: number;
  mrr: number;
  evidencePrecision: number;
  evidenceRecall: number;
  falseSufficientCount: number;
  falseSufficientRate: number;
  avgQueryCount: number;
  avgPageCount: number;
  avgDurationMs: number;
  budgetExhaustedCount: number;
  budgetExhaustedRate: number;
  firstQueryHitRate: number;
  rewriteTriggeredCount: number;
  rewriteTriggeredRate: number;
  rewriteRecoveryRate: number;
  officialSourceRate: number;
  pageExtractionSuccessRate: number;
  p95QueryCount: number;
  subjectConsistencyRate: number;
  subjectMismatchCount: number;
  failureReasons: Array<{ code: Exclude<WebEvalFailureReason, 'passed'>; count: number; caseIds: string[] }>;
};

export type WebEvalReport = {
  schemaVersion: 1 | 2;
  suiteVersion: number;
  evaluatedAt: string;
  durationMs: number;
  k: number;
  metrics: WebEvalMetrics;
  cases: WebEvalCaseResult[];
};

export type WebEvalProgress = { completed: number; total: number; currentCase?: { id: string; title: string } };

export async function runWebEvaluation(options: {
  cases: WebEvalCase[];
  suiteVersion: number;
  k?: number;
  retrieve: (testCase: WebEvalCase) => Promise<WebRetrievalResult>;
  onProgress?: (progress: WebEvalProgress) => void | Promise<void>;
}) {
  const startedAt = Date.now();
  const k = options.k ?? 3;
  const results: WebEvalCaseResult[] = [];

  for (const testCase of options.cases) {
    await options.onProgress?.({ completed: results.length, total: options.cases.length, currentCase: { id: testCase.id, title: testCase.title } });
    const retrieval = await options.retrieve(testCase);
    results.push(evaluateCase(testCase, retrieval, k));
  }
  await options.onProgress?.({ completed: results.length, total: options.cases.length });

  return {
    schemaVersion: 2 as const,
    suiteVersion: options.suiteVersion,
    evaluatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    k,
    metrics: aggregate(results),
    cases: results
  } satisfies WebEvalReport;
}

export function evaluateCase(testCase: WebEvalCase, result: WebRetrievalResult, k = 3): WebEvalCaseResult {
  const supportedNeeds = testCase.expectedEvidence.map((need) => ({ ...need, supported: result.sources.some((source) => supportsNeed(source.content, need)) }));
  const retrieved = result.sources.map((source, index) => {
    const domain = domainOf(source.file);
    const supportedNeedIds = testCase.expectedEvidence.filter((need) => supportsNeed(source.content, need)).map((need) => need.id);
    const relevant = domainMatches(domain, testCase.expectedDomains) && supportedNeedIds.length > 0;
    return { rank: index + 1, title: source.title, url: source.file, domain, score: source.score, relevant, supportedNeedIds };
  });
  const firstRelevant = retrieved.find((item) => item.relevant)?.rank;
  const evidenceRecall = testCase.expectedEvidence.length
    ? supportedNeeds.filter((need) => need.supported).length / testCase.expectedEvidence.length
    : 0;
  const evidencePrecision = retrieved.length ? retrieved.filter((item) => item.relevant).length / retrieved.length : 0;
  const falseSufficient = result.verdict === 'sufficient' && (!testCase.answerable || evidenceRecall < 1);
  const passed = testCase.answerable
    ? Boolean(firstRelevant && firstRelevant <= k && evidenceRecall === 1 && !falseSufficient)
    : result.verdict !== 'sufficient';
  const firstQueryHit = result.queryAttempts[0]?.verdict !== 'empty';
  const rewriteTriggered = result.queryAttempts.length > 1;
  const rewriteRecovered = rewriteTriggered && result.queryAttempts[0]?.verdict !== 'sufficient' && passed;
  const budgetExhausted = result.verdict === 'exhausted' || Boolean(result.diagnostics.budgetExhaustedBy);
  const officialSourceRate = retrieved.length ? retrieved.filter((item) => domainMatches(item.domain, testCase.expectedDomains)).length / retrieved.length : 0;
  const pageExtractionSuccessRate = result.pageAttempts.length
    ? result.pageAttempts.filter((attempt) => attempt.selectedChunkCount > 0 && attempt.verdict !== 'unreadable').length / result.pageAttempts.length
    : 0;
  const subjectConsistencyRate = result.diagnostics.subjectConsistencyRate ?? 1;
  const subjectMismatchUrls = result.diagnostics.subjectMismatchUrls ?? [];
  const uncoveredNeedLabels = supportedNeeds.filter((need) => !need.supported).map((need) => need.label);
  const failureReason = classifyFailure({ passed, falseSufficient, subjectMismatch: subjectMismatchUrls.length > 0, budgetExhausted, retrieved, expectedDomains: testCase.expectedDomains, evidenceRecall, hitAtK: Boolean(firstRelevant && firstRelevant <= k) });

  return {
    id: testCase.id,
    title: testCase.title,
    question: testCase.question,
    category: testCase.category,
    answerable: testCase.answerable,
    verdict: result.verdict,
    score: result.score,
    hitAtK: firstRelevant && firstRelevant <= k ? 1 : 0,
    reciprocalRank: firstRelevant ? 1 / firstRelevant : 0,
    evidencePrecision,
    evidenceRecall,
    falseSufficient,
    passed,
    supportedNeeds: supportedNeeds.map(({ id, label, supported }) => ({ id, label, supported })),
    retrieved,
    queryCount: result.diagnostics.queriesUsed,
    pageCount: result.diagnostics.pagesFetched,
    durationMs: result.diagnostics.durationMs,
    coverageScore: result.coverageScore,
    retrievalQueries: result.retrievalQueries,
    stopReason: result.diagnostics.stopReason,
    firstQueryHit, rewriteTriggered, rewriteRecovered, budgetExhausted,
    officialSourceRate, pageExtractionSuccessRate, subjectConsistencyRate, subjectMismatchUrls, failureReason, uncoveredNeedLabels
  };
}

function aggregate(cases: WebEvalCaseResult[]): WebEvalMetrics {
  const count = cases.length || 1;
  const rewrites = cases.filter((item) => item.rewriteTriggered);
  const failureCodes: Array<Exclude<WebEvalFailureReason, 'passed'>> = ['false_sufficient', 'subject_mismatch', 'budget_exhausted', 'no_sources', 'official_source_missing', 'evidence_gap', 'low_rank'];
  return {
    caseCount: cases.length,
    passRate: average(cases.map((item) => Number(item.passed)), count),
    hitAtK: average(cases.filter((item) => item.answerable).map((item) => item.hitAtK)),
    mrr: average(cases.filter((item) => item.answerable).map((item) => item.reciprocalRank)),
    evidencePrecision: average(cases.filter((item) => item.answerable).map((item) => item.evidencePrecision)),
    evidenceRecall: average(cases.filter((item) => item.answerable).map((item) => item.evidenceRecall)),
    falseSufficientCount: cases.filter((item) => item.falseSufficient).length,
    falseSufficientRate: average(cases.map((item) => Number(item.falseSufficient)), count),
    avgQueryCount: average(cases.map((item) => item.queryCount), count),
    avgPageCount: average(cases.map((item) => item.pageCount), count),
    avgDurationMs: average(cases.map((item) => item.durationMs), count),
    budgetExhaustedCount: cases.filter((item) => item.budgetExhausted).length,
    budgetExhaustedRate: average(cases.map((item) => Number(item.budgetExhausted)), count),
    firstQueryHitRate: average(cases.map((item) => Number(item.firstQueryHit)), count),
    rewriteTriggeredCount: rewrites.length,
    rewriteTriggeredRate: average(cases.map((item) => Number(item.rewriteTriggered)), count),
    rewriteRecoveryRate: average(rewrites.map((item) => Number(item.rewriteRecovered))),
    officialSourceRate: average(cases.filter((item) => item.answerable).map((item) => item.officialSourceRate)),
    pageExtractionSuccessRate: average(cases.map((item) => item.pageExtractionSuccessRate), count),
    p95QueryCount: percentile(cases.map((item) => item.queryCount), 0.95),
    subjectConsistencyRate: average(cases.map((item) => item.subjectConsistencyRate), count),
    subjectMismatchCount: cases.filter((item) => item.subjectMismatchUrls.length > 0).length,
    failureReasons: failureCodes.map((code) => ({ code, caseIds: cases.filter((item) => item.failureReason === code).map((item) => item.id) }))
      .map((item) => ({ ...item, count: item.caseIds.length })).filter((item) => item.count > 0)
  };
}

function classifyFailure(input: { passed: boolean; falseSufficient: boolean; subjectMismatch: boolean; budgetExhausted: boolean; retrieved: WebEvalCaseResult['retrieved']; expectedDomains: string[]; evidenceRecall: number; hitAtK: boolean }): WebEvalFailureReason {
  if (input.passed) return 'passed';
  if (input.falseSufficient) return 'false_sufficient';
  if (input.subjectMismatch) return 'subject_mismatch';
  if (input.budgetExhausted) return 'budget_exhausted';
  if (!input.retrieved.length) return 'no_sources';
  if (!input.retrieved.some((item) => domainMatches(item.domain, input.expectedDomains))) return 'official_source_missing';
  if (input.evidenceRecall < 1) return 'evidence_gap';
  return input.hitAtK ? 'evidence_gap' : 'low_rank';
}

function average(values: number[], denominator = values.length || 1) {
  return values.reduce((sum, value) => sum + value, 0) / denominator;
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function supportsNeed(content: string, need: WebEvalEvidenceNeed) {
  const normalized = content.toLocaleLowerCase();
  return need.groups.every((alternatives) => alternatives.some((term) => normalized.includes(term.toLocaleLowerCase())));
}

function domainOf(url: string) {
  try { return new URL(url).hostname.toLocaleLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function domainMatches(domain: string, expected: string[]) {
  return expected.some((item) => domain === item || domain.endsWith(`.${item}`));
}
