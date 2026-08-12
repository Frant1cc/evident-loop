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
};

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
};

export type WebEvalReport = {
  schemaVersion: 1;
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
    schemaVersion: 1 as const,
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
    stopReason: result.diagnostics.stopReason
  };
}

function aggregate(cases: WebEvalCaseResult[]): WebEvalMetrics {
  const count = cases.length || 1;
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
    avgDurationMs: average(cases.map((item) => item.durationMs), count)
  };
}

function average(values: number[], denominator = values.length || 1) {
  return values.reduce((sum, value) => sum + value, 0) / denominator;
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
