import type { RagSource } from '../types.js';
import {
  retrievalConfidenceThresholds,
  type RetrievalVerdict
} from '../confidence.js';
import type { RetrieveKnowledgeResult } from '../index.js';
import type { RagEvalCase } from './fixtures.js';

export type RagEvalThresholds = {
  recallAtK: number;
  mrrAtK: number;
  minRejectionRecall: number;
  maxFalseRejections: number;
};

export type RagEvalRetrievedResult = Pick<RagSource, 'id' | 'file' | 'heading' | 'headingPath' | 'contextHeadings' | 'score'> & {
  rank: number;
  /** 文件级相关：命中期望文档 */
  relevant: boolean;
  /** 章节级相关：命中期望文档中的期望章节（chunk 级判定） */
  headingRelevant: boolean;
  /** 证据级相关：chunk 内容包含期望的原文锚点 */
  anchorRelevant: boolean;
};

export type RagEvalCaseResult = {
  id: string;
  query: string;
  category: NonNullable<RagEvalCase['category']>;
  answerable: boolean;
  expectedFiles: string[];
  expectedHeadings?: string[];
  retrieved: RagEvalRetrievedResult[];
  verdict: RetrievalVerdict;
  retrievalQueries: string[];
  queryCount: number;
  rewriteTriggered: boolean;
  rewriteDurationMs?: number;
  rewriteModel?: string;
  originalVerdict?: RetrievalVerdict;
  top1Score?: number;
  topKeywordScore?: number;
  recallAtK: number;
  reciprocalRank: number;
  headingRecallAtK?: number;
  headingReciprocalRank?: number;
  anchorRecallAtK?: number;
  anchorReciprocalRank?: number;
  passed: boolean;
};

export type RagEvalCategorySummary = {
  category: NonNullable<RagEvalCase['category']>;
  caseCount: number;
  passedCount: number;
  recallAtK: number;
  mrrAtK: number;
  passRate: number;
  headingRecallAtK?: number;
  anchorRecallAtK?: number;
};

export type RagEvalMetrics = {
  /** 全部用例数（含不可答） */
  caseCount: number;
  /** 参与 Recall/MRR 统计的可回答用例数 */
  answerableCaseCount: number;
  recallAtK: number;
  mrrAtK: number;
  passRate: number;
  /** 章节级（chunk 级）指标，统计定义了 expectedHeadings 的用例 */
  headingCaseCount: number;
  headingRecallAtK?: number;
  headingMrrAtK?: number;
  /** 证据级指标，统计定义了 expectedAnchors 的用例 */
  anchorCaseCount: number;
  anchorRecallAtK?: number;
  anchorMrrAtK?: number;
  /** 可回答用例 top1 相似度均值，用于后续置信度阈值选择 */
  answerableAvgTop1Score?: number;
  /** 不可答用例的检索分数分布，为置信度门控提供参照 */
  unanswerable?: {
    caseCount: number;
    avgTop1Score: number;
    maxTop1Score: number;
  };
  confidenceGate: {
    rejectedUnanswerableCount: number;
    rejectionRecall: number;
    falselyRejectedAnswerableCount: number;
    falseRejectionRate: number;
  };
  queryRewrite: {
    triggeredCaseCount: number;
    triggerRate: number;
    totalQueryCount: number;
    avgQueryCount: number;
    maxQueryCount: number;
    avgRewriteDurationMs?: number;
  };
};

export type RagEvalReport = {
  schemaVersion: 4;
  status: 'pass' | 'fail';
  evaluatedAt: string;
  durationMs: number;
  config: {
    k: number;
    collection: string;
    embeddingModel: string;
    /** 检索策略：dense（纯向量）或 hybrid（Dense+FTS5+RRF+同文档限流），用于 A/B 对比 */
    retrieval?: 'dense' | 'hybrid';
    queryRewrite?: boolean;
    confidenceGate: typeof retrievalConfidenceThresholds;
  };
  thresholds: RagEvalThresholds;
  metrics: RagEvalMetrics;
  categories: RagEvalCategorySummary[];
  cases: RagEvalCaseResult[];
};

export type RagEvalProgress = {
  completed: number;
  total: number;
  currentCase?: Pick<RagEvalCase, 'id' | 'query' | 'category'>;
  result?: RagEvalCaseResult;
};

export type RunRagEvaluationOptions = {
  cases: RagEvalCase[];
  k: number;
  thresholds: RagEvalThresholds;
  collection: string;
  embeddingModel: string;
  retrieval?: 'dense' | 'hybrid';
  queryRewrite?: boolean;
  search: (query: string, limit: number) => Promise<RetrieveKnowledgeResult>;
  onProgress?: (progress: RagEvalProgress) => void | Promise<void>;
};

export async function runRagEvaluation(options: RunRagEvaluationOptions): Promise<RagEvalReport> {
  const startedAt = Date.now();
  const cases: RagEvalCaseResult[] = [];

  await options.onProgress?.({ completed: 0, total: options.cases.length });
  for (const testCase of options.cases) {
    await options.onProgress?.({
      completed: cases.length,
      total: options.cases.length,
      currentCase: testCase
    });
    const result = await evaluateCase(testCase, options);
    cases.push(result);
    await options.onProgress?.({
      completed: cases.length,
      total: options.cases.length,
      currentCase: testCase,
      result
    });
  }

  const metrics = summarizeMetrics(cases);
  const confidenceGatePassed = (!metrics.unanswerable
    || metrics.confidenceGate.rejectionRecall >= options.thresholds.minRejectionRecall)
    && metrics.confidenceGate.falselyRejectedAnswerableCount <= options.thresholds.maxFalseRejections;
  const status = metrics.recallAtK >= options.thresholds.recallAtK
    && metrics.mrrAtK >= options.thresholds.mrrAtK
    && confidenceGatePassed
    ? 'pass'
    : 'fail';

  return {
    schemaVersion: 4,
    status,
    evaluatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    config: {
      k: options.k,
      collection: options.collection,
      embeddingModel: options.embeddingModel,
      retrieval: options.retrieval,
      queryRewrite: options.queryRewrite,
      confidenceGate: retrievalConfidenceThresholds
    },
    thresholds: options.thresholds,
    metrics,
    categories: summarizeCategories(cases),
    cases
  };
}

async function evaluateCase(testCase: RagEvalCase, options: RunRagEvaluationOptions): Promise<RagEvalCaseResult> {
  const retrieval = await options.search(testCase.query, options.k);
  const results = retrieval.results;
  const answerable = testCase.answerable ?? true;
  const expectedFiles = new Set(testCase.expectedFiles);
  const expectedHeadings = (testCase.expectedHeadings ?? []).map(normalizeHeading);
  const anchors = testCase.expectedAnchors ?? [];

  const retrieved = results.map((result, index) => {
    const relevant = expectedFiles.has(result.file);
    const resultHeadings = sourceHeadings(result);
    const headingRelevant = relevant
      && expectedHeadings.length > 0
      && expectedHeadings.some((heading) => resultHeadings.includes(heading));
    const anchorRelevant = relevant
      && anchors.length > 0
      && anchors.some((anchor) => result.content.includes(anchor));

    return {
      id: result.id,
      file: result.file,
      heading: result.heading,
      headingPath: result.headingPath,
      contextHeadings: result.contextHeadings,
      score: result.score,
      rank: index + 1,
      relevant,
      headingRelevant,
      anchorRelevant
    };
  });

  // 门控校准要用余弦相似度：hybrid 模式下 score 是 RRF 融合分（仅名次信息，量级 ~1/k），
  // 不同策略间不可比。top1 为关键词单路命中（无语义分）时记为 undefined，不污染分布统计。
  const top1Score = retrieval.topSemanticScore;
  const retrievalDiagnostics = {
    retrievalQueries: retrieval.retrievalQueries ?? [testCase.query],
    queryCount: retrieval.queryCount ?? 1,
    rewriteTriggered: retrieval.rewriteTriggered ?? false,
    rewriteDurationMs: retrieval.rewriteDurationMs,
    rewriteModel: retrieval.rewriteModel,
    originalVerdict: retrieval.originalVerdict
  };

  if (!answerable) {
    return {
      id: testCase.id,
      query: testCase.query,
      category: testCase.category ?? 'unanswerable',
      answerable: false,
      expectedFiles: testCase.expectedFiles,
      retrieved,
      verdict: retrieval.verdict,
      ...retrievalDiagnostics,
      top1Score,
      topKeywordScore: retrieval.topKeywordScore,
      recallAtK: 0,
      reciprocalRank: 0,
      passed: retrieval.verdict === 'empty'
    };
  }

  const retrievedFiles = new Set(retrieved.filter((result) => result.relevant).map((result) => result.file));
  const recallAtK = testCase.expectedFiles.length
    ? retrievedFiles.size / testCase.expectedFiles.length
    : 1;
  const firstRelevant = retrieved.find((result) => result.relevant);

  let headingRecallAtK: number | undefined;
  let headingReciprocalRank: number | undefined;
  if (expectedHeadings.length) {
    const matchedHeadings = new Set(expectedHeadings.filter((expectedHeading) =>
      results.some((result, index) =>
        retrieved[index]?.relevant && sourceHeadings(result).includes(expectedHeading)
      )
    ));
    headingRecallAtK = matchedHeadings.size / expectedHeadings.length;
    const firstHeadingHit = retrieved.find((result) => result.headingRelevant);
    headingReciprocalRank = firstHeadingHit ? 1 / firstHeadingHit.rank : 0;
  }

  let anchorRecallAtK: number | undefined;
  let anchorReciprocalRank: number | undefined;
  if (anchors.length) {
    const matchedAnchors = anchors.filter((anchor) =>
      results.some((result, index) => retrieved[index]?.relevant && result.content.includes(anchor))
    );
    anchorRecallAtK = matchedAnchors.length / anchors.length;
    const firstAnchorHit = retrieved.find((result) => result.anchorRelevant);
    anchorReciprocalRank = firstAnchorHit ? 1 / firstAnchorHit.rank : 0;
  }

  return {
    id: testCase.id,
    query: testCase.query,
    category: testCase.category ?? 'semantic',
    answerable: true,
    expectedFiles: testCase.expectedFiles,
    expectedHeadings: testCase.expectedHeadings,
    retrieved,
    verdict: retrieval.verdict,
    ...retrievalDiagnostics,
    top1Score,
    topKeywordScore: retrieval.topKeywordScore,
    recallAtK,
    reciprocalRank: firstRelevant ? 1 / firstRelevant.rank : 0,
    headingRecallAtK,
    headingReciprocalRank,
    anchorRecallAtK,
    anchorReciprocalRank,
    passed: recallAtK === 1 && Boolean(firstRelevant)
  };
}

function summarizeMetrics(cases: RagEvalCaseResult[]): RagEvalMetrics {
  const answerable = cases.filter((result) => result.answerable);
  const unanswerable = cases.filter((result) => !result.answerable);
  const headingCases = answerable.filter((result) => result.headingRecallAtK !== undefined);
  const anchorCases = answerable.filter((result) => result.anchorRecallAtK !== undefined);
  const answerableTop1 = answerable
    .map((result) => result.top1Score)
    .filter((score): score is number => score !== undefined);
  const unanswerableTop1 = unanswerable
    .map((result) => result.top1Score)
    .filter((score): score is number => score !== undefined);
  const rejectedUnanswerableCount = unanswerable.filter((result) => result.verdict === 'empty').length;
  const falselyRejectedAnswerableCount = answerable.filter((result) => result.verdict === 'empty').length;
  const rewrittenCases = cases.filter((result) => result.rewriteTriggered);
  const rewriteDurations = rewrittenCases
    .map((result) => result.rewriteDurationMs)
    .filter((duration): duration is number => duration !== undefined);

  return {
    caseCount: cases.length,
    answerableCaseCount: answerable.length,
    recallAtK: average(answerable.map((result) => result.recallAtK)),
    mrrAtK: average(answerable.map((result) => result.reciprocalRank)),
    passRate: average(answerable.map((result) => result.passed ? 1 : 0)),
    headingCaseCount: headingCases.length,
    headingRecallAtK: headingCases.length
      ? average(headingCases.map((result) => result.headingRecallAtK as number))
      : undefined,
    headingMrrAtK: headingCases.length
      ? average(headingCases.map((result) => result.headingReciprocalRank ?? 0))
      : undefined,
    anchorCaseCount: anchorCases.length,
    anchorRecallAtK: anchorCases.length
      ? average(anchorCases.map((result) => result.anchorRecallAtK as number))
      : undefined,
    anchorMrrAtK: anchorCases.length
      ? average(anchorCases.map((result) => result.anchorReciprocalRank ?? 0))
      : undefined,
    answerableAvgTop1Score: answerableTop1.length ? average(answerableTop1) : undefined,
    unanswerable: unanswerable.length
      ? {
        caseCount: unanswerable.length,
        avgTop1Score: unanswerableTop1.length ? average(unanswerableTop1) : 0,
        maxTop1Score: unanswerableTop1.length ? Math.max(...unanswerableTop1) : 0
      }
      : undefined,
    confidenceGate: {
      rejectedUnanswerableCount,
      rejectionRecall: unanswerable.length ? rejectedUnanswerableCount / unanswerable.length : 0,
      falselyRejectedAnswerableCount,
      falseRejectionRate: answerable.length ? falselyRejectedAnswerableCount / answerable.length : 0
    },
    queryRewrite: {
      triggeredCaseCount: rewrittenCases.length,
      triggerRate: cases.length ? rewrittenCases.length / cases.length : 0,
      totalQueryCount: cases.reduce((total, result) => total + result.queryCount, 0),
      avgQueryCount: cases.length ? average(cases.map((result) => result.queryCount)) : 0,
      maxQueryCount: cases.length ? Math.max(...cases.map((result) => result.queryCount)) : 0,
      avgRewriteDurationMs: rewriteDurations.length ? average(rewriteDurations) : undefined
    }
  };
}

function summarizeCategories(cases: RagEvalCaseResult[]): RagEvalCategorySummary[] {
  const categories: Array<RagEvalCaseResult['category']> = ['exact', 'semantic', 'distractor', 'multi_document'];
  return categories.flatMap((category) => {
    const matches = cases.filter((result) => result.answerable && result.category === category);
    if (!matches.length) return [];
    const passedCount = matches.filter((result) => result.passed).length;
    const headingCases = matches.filter((result) => result.headingRecallAtK !== undefined);
    const anchorCases = matches.filter((result) => result.anchorRecallAtK !== undefined);
    return [{
      category,
      caseCount: matches.length,
      passedCount,
      recallAtK: average(matches.map((result) => result.recallAtK)),
      mrrAtK: average(matches.map((result) => result.reciprocalRank)),
      passRate: passedCount / matches.length,
      headingRecallAtK: headingCases.length
        ? average(headingCases.map((result) => result.headingRecallAtK as number))
        : undefined,
      anchorRecallAtK: anchorCases.length
        ? average(anchorCases.map((result) => result.anchorRecallAtK as number))
        : undefined
    }];
  });
}

function normalizeHeading(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function sourceHeadings(source: Pick<RagSource, 'heading' | 'headingPath' | 'contextHeadings'>) {
  return [...new Set([
    ...(source.contextHeadings ?? []),
    ...(source.headingPath ?? []),
    ...(source.heading ? [source.heading] : [])
  ].map(normalizeHeading))];
}

function average(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}
