import type { RagSource } from './types.js';

const queryRrfK = 60;
const defaultPromotionMargin = 0.08;
const defaultStrongKeywordScore = 25;

/** Reciprocal-rank fusion across the original query and its rewritten variants. */
export function fuseQueryResults(runs: RagSource[][]): RagSource[] {
  const fused = new Map<string, { source: RagSource; score: number }>();

  for (const results of runs) {
    results.forEach((source, index) => {
      const contribution = 1 / (queryRrfK + index + 1);
      const existing = fused.get(source.id);
      if (!existing) {
        fused.set(source.id, { source, score: contribution });
        return;
      }

      existing.score += contribution;
      existing.source = preferSource(existing.source, source);
    });
  }

  return [...fused.values()]
    .sort((left, right) =>
      right.score - left.score
      || (right.source.semanticScore ?? 0) - (left.source.semanticScore ?? 0)
      || left.source.id.localeCompare(right.source.id)
    )
    .map(({ source, score }) => ({ ...source, score }));
}

/**
 * Conservative rewrite fallback:
 * - the original TopK remains the baseline;
 * - at most one rewritten candidate is promoted;
 * - promotion requires a materially stronger semantic score or strong lexical evidence;
 * - rewritten chunks from an already retrieved document never replace original chunks;
 * - a genuinely new document consumes only the last baseline slot and stays at rank K, so
 *   speculative rewrites cannot damage the original result order or MRR.
 *
 * This prevents a plausible but wrong rewrite from letting two generated queries outvote the
 * user's original wording, while still allowing a strong rewrite to recover one missing topic.
 */
export function mergeRewriteFallback(
  original: RagSource[],
  rewrittenRuns: RagSource[][],
  limit: number,
  options: { promotionMargin?: number; strongKeywordScore?: number } = {}
) {
  if (limit < 1) throw new Error('limit must be at least 1');
  const baseline = original.slice(0, limit);
  if (!baseline.length || !rewrittenRuns.length) return baseline;

  const promotionMargin = options.promotionMargin ?? defaultPromotionMargin;
  const strongKeywordScore = options.strongKeywordScore ?? defaultStrongKeywordScore;
  const weakestSemantic = Math.min(...baseline.map((source) => source.semanticScore ?? 0));
  const baselineFiles = new Set(baseline.map((source) => source.file));
  const candidate = fuseQueryResults(rewrittenRuns).find((source) =>
    !baselineFiles.has(source.file)
    && (
      (source.semanticScore ?? 0) >= weakestSemantic + promotionMargin
      || (source.keywordScore ?? 0) >= strongKeywordScore
    )
  );
  if (!candidate) return baseline;

  return dedupeById([...baseline.slice(0, Math.max(0, limit - 1)), candidate]).slice(0, limit);
}

function preferSource(left: RagSource, right: RagSource) {
  const preferred = (right.semanticScore ?? 0) > (left.semanticScore ?? 0)
    || (
      (right.semanticScore ?? 0) === (left.semanticScore ?? 0)
      && (right.tokenCount ?? 0) > (left.tokenCount ?? 0)
    )
    ? right
    : left;

  return {
    ...preferred,
    semanticScore: maxDefined(left.semanticScore, right.semanticScore),
    keywordScore: maxDefined(left.keywordScore, right.keywordScore)
  };
}

function maxDefined(left: number | undefined, right: number | undefined) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function dedupeById(results: RagSource[]) {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.id)) return false;
    seen.add(result.id);
    return true;
  });
}
