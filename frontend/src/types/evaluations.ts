export type RagEvaluationStatus = 'queued' | 'running' | 'completed' | 'failed';
export type RagEvaluationCategory = 'exact' | 'semantic' | 'distractor' | 'multi_document' | 'unanswerable';
export type RetrievalVerdict = 'sufficient' | 'weak' | 'empty';

export type RagEvaluationCaseResult = {
  id: string;
  query: string;
  category: RagEvaluationCategory;
  /** schemaVersion 2 起提供；旧报告默认视为可回答 */
  answerable?: boolean;
  expectedFiles: string[];
  expectedHeadings?: string[];
  retrieved: Array<{
    id: string;
    file: string;
    heading?: string;
    headingPath?: string[];
    contextHeadings?: string[];
    score: number;
    rank: number;
    relevant: boolean;
    headingRelevant?: boolean;
    anchorRelevant?: boolean;
  }>;
  /** schemaVersion 3 起提供 */
  verdict?: RetrievalVerdict;
  /** schemaVersion 4 起提供 */
  retrievalQueries?: string[];
  queryCount?: number;
  rewriteTriggered?: boolean;
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

export type RagEvaluationMetrics = {
  caseCount: number;
  recallAtK: number;
  mrrAtK: number;
  passRate: number;
  /** 以下字段自 schemaVersion 2 起提供 */
  answerableCaseCount?: number;
  headingCaseCount?: number;
  headingRecallAtK?: number;
  headingMrrAtK?: number;
  anchorCaseCount?: number;
  anchorRecallAtK?: number;
  anchorMrrAtK?: number;
  answerableAvgTop1Score?: number;
  unanswerable?: {
    caseCount: number;
    avgTop1Score: number;
    maxTop1Score: number;
  };
  confidenceGate?: {
    rejectedUnanswerableCount: number;
    rejectionRecall: number;
    falselyRejectedAnswerableCount: number;
    falseRejectionRate: number;
  };
  queryRewrite?: {
    triggeredCaseCount: number;
    triggerRate: number;
    totalQueryCount: number;
    avgQueryCount: number;
    maxQueryCount: number;
    avgRewriteDurationMs?: number;
  };
};

export type RagEvaluationReport = {
  schemaVersion: 1 | 2 | 3 | 4;
  status: 'pass' | 'fail';
  evaluatedAt: string;
  durationMs: number;
  config: {
    k: number;
    collection: string;
    embeddingModel: string;
    retrieval?: 'dense' | 'hybrid';
    queryRewrite?: boolean;
    confidenceGate?: {
      sufficientSemanticScore: number;
      weakSemanticScore: number;
      noisyLexicalSemanticCeiling?: number;
      maxNoisyKeywordScore?: number;
      strongKeywordScore: number;
    };
  };
  thresholds: {
    recallAtK: number;
    mrrAtK: number;
    minRejectionRecall?: number;
    maxFalseRejections?: number;
  };
  metrics: RagEvaluationMetrics;
  categories: Array<{
    category: RagEvaluationCategory;
    caseCount: number;
    passedCount: number;
    recallAtK: number;
    mrrAtK: number;
    passRate: number;
    headingRecallAtK?: number;
    anchorRecallAtK?: number;
  }>;
  cases: RagEvaluationCaseResult[];
};

export type RagEvaluation = {
  id: string;
  name: string;
  status: RagEvaluationStatus;
  completedCases: number;
  totalCases: number;
  currentCaseId?: string;
  config: {
    k: number;
    thresholds: {
      recallAtK: number;
      mrrAtK: number;
      minRejectionRecall?: number;
      maxFalseRejections?: number;
    };
    collection: string;
    embeddingModel: string;
    retrieval?: 'dense' | 'hybrid';
    queryRewrite?: boolean;
    caseCount: number;
  };
  report?: RagEvaluationReport;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type RagEvaluationStreamEvent = {
  type: 'snapshot' | 'progress' | 'completed' | 'failed';
  evaluation: RagEvaluation;
};

export type RagEvaluationCaseChange = {
  id: string;
  query: string;
  category: RagEvaluationCategory;
};

export type RagEvaluationDiff = {
  baseline: { id: string; name: string; createdAt: string };
  deltas: {
    recallAtK: number;
    mrrAtK: number;
    passRate: number;
    headingRecallAtK?: number;
    anchorRecallAtK?: number;
  };
  regressions: RagEvaluationCaseChange[];
  improvements: RagEvaluationCaseChange[];
  addedCases: RagEvaluationCaseChange[];
  removedCases: RagEvaluationCaseChange[];
};
