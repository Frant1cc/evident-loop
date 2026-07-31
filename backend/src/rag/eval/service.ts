import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { getEmbeddingModel } from '../embeddingClient.js';
import { getDefaultRetrievalMode, retrieveKnowledge, type RetrievalMode } from '../index.js';
import { getDefaultQueryRewriteEnabled } from '../queryRewrite.js';
import { syncRagIndex } from '../sync.js';
import { loadRepositoryEvaluationCorpus } from './corpus.js';
import { ragEvalCases, ragEvalConfig } from './fixtures.js';
import { runRagEvaluation, type RagEvalProgress, type RagEvalThresholds } from './run.js';
import {
  createEvaluationRecord,
  getEvaluationRecord,
  updateEvaluationRecord,
  type RagEvaluationConfig,
  type RagEvaluationRecord
} from './store.js';

export type RagEvaluationEvent = {
  type: 'progress' | 'completed' | 'failed';
  evaluation: RagEvaluationRecord;
  progress?: RagEvalProgress;
};

type ExecuteRagEvaluationOptions = {
  k?: number;
  thresholds?: Partial<RagEvalThresholds>;
  retrieval?: RetrievalMode;
  queryRewrite?: boolean;
  onProgress?: (progress: RagEvalProgress) => void | Promise<void>;
};

const events = new EventEmitter();
events.setMaxListeners(100);

export function resolveRagEvaluationConfig(options: ExecuteRagEvaluationOptions = {}): RagEvaluationConfig {
  const k = options.k ?? ragEvalConfig.k;
  const recallAtK = options.thresholds?.recallAtK ?? ragEvalConfig.thresholds.recallAtK;
  const mrrAtK = options.thresholds?.mrrAtK ?? ragEvalConfig.thresholds.mrrAtK;
  const minRejectionRecall = options.thresholds?.minRejectionRecall ?? ragEvalConfig.thresholds.minRejectionRecall;
  const maxFalseRejections = options.thresholds?.maxFalseRejections ?? ragEvalConfig.thresholds.maxFalseRejections;
  const retrieval = options.retrieval ?? getDefaultRetrievalMode();
  const queryRewrite = options.queryRewrite ?? getDefaultQueryRewriteEnabled();

  if (!Number.isInteger(k) || k < 1 || k > 10) throw new Error('k must be an integer between 1 and 10');
  if (!isMetric(recallAtK) || !isMetric(mrrAtK) || !isMetric(minRejectionRecall)) {
    throw new Error('metric thresholds must be between 0 and 1');
  }
  if (!Number.isInteger(maxFalseRejections) || maxFalseRejections < 0) {
    throw new Error('maxFalseRejections must be a non-negative integer');
  }
  if (retrieval !== 'dense' && retrieval !== 'hybrid') throw new Error('retrieval must be "dense" or "hybrid"');
  if (typeof queryRewrite !== 'boolean') throw new Error('queryRewrite must be a boolean');

  return {
    k,
    thresholds: { recallAtK, mrrAtK, minRejectionRecall, maxFalseRejections },
    collection: process.env.RAG_EVAL_COLLECTION ?? 'rag_eval',
    embeddingModel: getEmbeddingModel(),
    retrieval,
    queryRewrite,
    caseCount: ragEvalCases.length
  };
}

export async function executeRagEvaluation(options: ExecuteRagEvaluationOptions = {}) {
  const config = resolveRagEvaluationConfig(options);
  const corpus = await loadRepositoryEvaluationCorpus();
  if (!corpus.length) throw new Error('No Markdown files found in docs/knowledge');
  await syncRagIndex({ documents: corpus, collection: config.collection });

  return runRagEvaluation({
    cases: ragEvalCases,
    ...config,
    search: (query, limit) => retrieveKnowledge(query, limit, {
      collection: config.collection,
      mode: config.retrieval,
      queryRewrite: config.queryRewrite
    }),
    onProgress: options.onProgress
  });
}

export function createAndStartRagEvaluation(input: ExecuteRagEvaluationOptions & { name?: string } = {}) {
  const config = resolveRagEvaluationConfig(input);
  const now = new Date().toISOString();
  const record = createEvaluationRecord({
    id: randomUUID(),
    name: input.name?.trim().slice(0, 80) || `RAG Eval · ${formatRunName(now)}`,
    status: 'queued',
    completedCases: 0,
    totalCases: config.caseCount,
    config,
    createdAt: now,
    updatedAt: now
  });

  setImmediate(() => void runPersistedEvaluation(record.id, input));
  return record;
}

export function subscribeToRagEvaluation(id: string, listener: (event: RagEvaluationEvent) => void) {
  const eventName = `evaluation:${id}`;
  events.on(eventName, listener);
  return () => events.off(eventName, listener);
}

async function runPersistedEvaluation(id: string, options: ExecuteRagEvaluationOptions) {
  try {
    updateEvaluationRecord(id, { status: 'running', startedAt: new Date().toISOString() });
    const report = await executeRagEvaluation({
      ...options,
      onProgress: async (progress) => {
        const record = updateEvaluationRecord(id, {
          completedCases: progress.completed,
          currentCaseId: progress.completed === progress.total ? undefined : progress.currentCase?.id
        });
        if (record) emit(id, { type: 'progress', evaluation: record, progress });
      }
    });
    const completed = updateEvaluationRecord(id, {
      status: 'completed',
      completedCases: report.metrics.caseCount,
      currentCaseId: undefined,
      report,
      completedAt: new Date().toISOString()
    });
    if (completed) emit(id, { type: 'completed', evaluation: completed });
  } catch (error) {
    const failed = updateEvaluationRecord(id, {
      status: 'failed',
      currentCaseId: undefined,
      error: error instanceof Error ? error.message : 'RAG evaluation failed',
      completedAt: new Date().toISOString()
    });
    if (failed) emit(id, { type: 'failed', evaluation: failed });
  }
}

function emit(id: string, event: RagEvaluationEvent) {
  events.emit(`evaluation:${id}`, event);
}

function isMetric(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function formatRunName(value: string) {
  return value.slice(0, 16).replace('T', ' ');
}
