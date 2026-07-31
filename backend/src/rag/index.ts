import type { ToolTrace } from '../agent/types.js';
import { assessRetrievalConfidence, type RetrievalConfidence, type RetrievalVerdict } from './confidence.js';
import { mergeAdjacentChunks } from './contextAssembly.js';
import { createEmbedding } from './embeddingClient.js';
import { defaultMaxChunksPerFile, limitChunksPerFile, rrfFuse } from './fusion.js';
import { getKeywordStore } from './keywordStore.js';
import { mergeRewriteFallback } from './queryFusion.js';
import {
  getDefaultQueryRewriteEnabled,
  rewriteRetrievalQuery,
  type QueryRewriteResult
} from './queryRewrite.js';
import type { RagSource } from './types.js';
import { getCollectionName, searchChunks, vectorCollectionExists } from './vectorStore.js';

type SearchKnowledgeArgs = {
  query?: unknown;
  limit?: unknown;
};

export type RetrievalMode = 'dense' | 'hybrid';
export type { RetrievalVerdict };

export type RetrieveKnowledgeResult = RetrievalConfidence & {
  results: RagSource[];
  retrievalQueries?: string[];
  queryCount?: number;
  rewriteTriggered?: boolean;
  rewriteDurationMs?: number;
  rewriteModel?: string;
  originalVerdict?: RetrievalVerdict;
};

/** 两路召回的候选规模：先取大候选集，融合后再截断到最终 limit */
const denseCandidateCount = 20;
const keywordCandidateCount = 20;
const adjacentContextLimits = {
  maxChunks: 4,
  maxTokens: 900
} as const;
/** A semantic-only score barely above sufficient can still be a false-positive topic match. */
const rewriteSemanticOnlyCeiling = 0.57;

export async function initRagIndex(): Promise<void> {
  await vectorCollectionExists();
}

/** 检索策略默认值由环境变量 RAG_HYBRID 控制（on/true/1/yes 开启），可被调用方显式覆盖 */
export function getDefaultRetrievalMode(): RetrievalMode {
  const flag = (process.env.RAG_HYBRID ?? '').trim().toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(flag) ? 'hybrid' : 'dense';
}

export type RetrieveKnowledgeOptions = {
  collection?: string;
  mode?: RetrievalMode;
  /** Explicit override; otherwise controlled by RAG_QUERY_REWRITE. */
  queryRewrite?: boolean;
  signal?: AbortSignal;
  /** Dependency injection for deterministic tests. */
  rewriteQuery?: (
    query: string,
    candidates: RagSource[],
    options: { signal?: AbortSignal; topicCatalog?: string[] }
  ) => Promise<QueryRewriteResult>;
};

/**
 * 统一检索入口：dense 为纯向量检索（与 dense-baseline 行为一致）；
 * hybrid 为 Dense Top20 + FTS5 Top20 → RRF 融合 → 受限相邻合并 → 同文档限流 → 截断。
 * Agent 工具与评测共用此入口，保证 A/B 比较的是同一条链路。
 */
export async function retrieveKnowledge(
  query: string,
  limit: number,
  options: RetrieveKnowledgeOptions = {}
): Promise<RetrieveKnowledgeResult> {
  const collection = options.collection ?? getCollectionName();
  const mode = options.mode ?? getDefaultRetrievalMode();
  const queryRewrite = options.queryRewrite ?? getDefaultQueryRewriteEnabled();
  const candidateLimit = queryRewrite ? Math.max(8, limit * 2) : limit;
  const original = await retrieveSingleQuery(query, candidateLimit, collection, mode);
  const baseDiagnostics = {
    retrievalQueries: [query],
    queryCount: 1,
    rewriteTriggered: false
  };

  // Empty stays a hard rejection: rewriting an out-of-domain question from unrelated headings
  // can manufacture a false-positive topic. Besides weak, rewrite the narrow semantic-only
  // boundary just above "sufficient"; P2 A/B showed this catches one false-positive topic match
  // without turning strong lexical or high-cosine hits into extra LLM calls.
  const shouldRewrite = original.verdict === 'weak'
    || (
      original.verdict === 'sufficient'
      && original.topKeywordScore === undefined
      && (original.topSemanticScore ?? 1) < rewriteSemanticOnlyCeiling
    );
  if (!queryRewrite || !shouldRewrite) {
    const results = original.results.slice(0, limit);
    return { ...assessRetrievalConfidence(results), results, ...baseDiagnostics };
  }

  const topics = (await getKeywordStore()).listDocumentTopics(collection)
    .map((topic) => `${topic.file}：${topic.title}`);
  const rewrite = await (options.rewriteQuery ?? rewriteRetrievalQuery)(
    query,
    original.results,
    { signal: options.signal, topicCatalog: topics }
  );
  if (!rewrite.queries.length) {
    const results = original.results.slice(0, limit);
    return {
      ...assessRetrievalConfidence(results),
      results,
      retrievalQueries: [query],
      queryCount: 1,
      rewriteTriggered: true,
      rewriteDurationMs: rewrite.durationMs,
      rewriteModel: rewrite.model,
      originalVerdict: original.verdict
    };
  }

  const rewritten = await Promise.all(rewrite.queries.map((rewrittenQuery) =>
    retrieveSingleQuery(rewrittenQuery, candidateLimit, collection, mode)
  ));
  const results = mergeRewriteFallback(
    original.results,
    rewritten.map((result) => result.results),
    limit
  );
  return {
    ...assessRetrievalConfidence(results),
    results,
    retrievalQueries: [query, ...rewrite.queries],
    queryCount: 1 + rewrite.queries.length,
    rewriteTriggered: true,
    rewriteDurationMs: rewrite.durationMs,
    rewriteModel: rewrite.model,
    originalVerdict: original.verdict
  };
}

async function retrieveSingleQuery(
  query: string,
  limit: number,
  collection: string,
  mode: RetrievalMode
): Promise<RetrievalConfidence & { results: RagSource[] }> {
  const queryEmbedding = await createEmbedding(query);

  if (mode === 'dense') {
    const candidates = await searchChunks(queryEmbedding, Math.max(denseCandidateCount, limit * 3), collection);
    const results = mergeAdjacentChunks(candidates, adjacentContextLimits).slice(0, limit);
    return { ...assessRetrievalConfidence(results), results };
  }

  const dense = await searchChunks(queryEmbedding, denseCandidateCount, collection);
  const keyword = (await getKeywordStore()).searchKeyword(query, keywordCandidateCount, collection);
  const fused = rrfFuse(dense, keyword);
  const assembled = mergeAdjacentChunks(fused, adjacentContextLimits);
  const results = limitChunksPerFile(assembled, defaultMaxChunksPerFile).slice(0, limit);
  return { ...assessRetrievalConfidence(results), results };
}

export async function searchKnowledge(
  args: unknown,
  options: Pick<RetrieveKnowledgeOptions, 'signal'> = {}
): Promise<{ query: string } & RetrieveKnowledgeResult> {
  const { query, limit } = parseSearchKnowledgeArgs(args);
  const retrieval = await retrieveKnowledge(query, limit, options);

  return { query, ...retrieval };
}

export function getRagSourcesFromToolTraces(toolCalls: ToolTrace[]): RagSource[] {
  const sources = new Map<string, RagSource>();

  for (const toolCall of toolCalls) {
    if (
      toolCall.name !== 'search_knowledge'
      || !isSearchKnowledgeResult(toolCall.result)
      || toolCall.result.verdict === 'empty'
    ) continue;

    for (const source of toolCall.result.results) {
      sources.set(source.id, source);
    }
  }

  return [...sources.values()];
}

function parseSearchKnowledgeArgs(args: unknown) {
  if (!args || typeof args !== 'object') {
    throw new Error('search_knowledge requires a query string');
  }

  const { query, limit } = args as SearchKnowledgeArgs;

  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('search_knowledge requires a query string');
  }

  return {
    query: query.trim(),
    limit: typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10) : 5
  };
}

function isSearchKnowledgeResult(value: unknown): value is { results: RagSource[]; verdict?: RetrievalVerdict } {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { results?: unknown }).results));
}
