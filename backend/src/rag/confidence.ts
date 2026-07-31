import { defaultRrfOptions } from './fusion.js';
import type { RagSource } from './types.js';

export type RetrievalVerdict = 'sufficient' | 'weak' | 'empty';

export type RetrievalConfidence = {
  verdict: RetrievalVerdict;
  /** Top-ranked result's cosine similarity. RRF scores are never used for gating. */
  topSemanticScore?: number;
  /** Top-ranked result's BM25 score, retained for keyword-only confidence decisions and diagnostics. */
  topKeywordScore?: number;
};

export const retrievalConfidenceThresholds = {
  sufficientSemanticScore: 0.55,
  weakSemanticScore: 0.46,
  noisyLexicalSemanticCeiling: 0.481,
  maxNoisyKeywordScore: 6,
  strongKeywordScore: defaultRrfOptions.keywordStrongScore
} as const;

/**
 * Three-state retrieval confidence gate calibrated from the frozen 119-case evaluation set:
 * P2 answerable top1 cosine avg=0.629; unanswerable avg=0.443, max=0.526.
 * The weak boundary plus a dual-signal noise rule rejects 7/10 frozen unanswerable cases
 * while keeping false rejections at 2/109. The noise rule only applies when both a weak
 * keyword hit and a borderline semantic hit point to the same top result; pure semantic
 * paraphrases are not penalized for having no lexical match.
 *
 * Hybrid `score` is an RRF rank-fusion score and has no absolute semantic meaning, so this
 * function only reads the top result's original semantic score. A strong BM25 hit is sufficient
 * even when semantic similarity is low: the first live gate run showed that this rescues exact
 * terminology cases without rescuing any of the 10 frozen unanswerable cases.
 */
export function assessRetrievalConfidence(results: RagSource[]): RetrievalConfidence {
  const top = results[0];
  if (!top) return { verdict: 'empty' };

  const topSemanticScore = finiteScore(top.semanticScore);
  const topKeywordScore = finiteScore(top.keywordScore);
  const diagnostics = {
    ...(topSemanticScore === undefined ? {} : { topSemanticScore }),
    ...(topKeywordScore === undefined ? {} : { topKeywordScore })
  };

  if (
    topKeywordScore !== undefined
    && topKeywordScore >= retrievalConfidenceThresholds.strongKeywordScore
  ) {
    return { verdict: 'sufficient', ...diagnostics };
  }

  if (topSemanticScore !== undefined) {
    if (topSemanticScore >= retrievalConfidenceThresholds.sufficientSemanticScore) {
      return { verdict: 'sufficient', ...diagnostics };
    }
    if (topSemanticScore >= retrievalConfidenceThresholds.weakSemanticScore) {
      if (
        topSemanticScore < retrievalConfidenceThresholds.noisyLexicalSemanticCeiling
        && topKeywordScore !== undefined
        && topKeywordScore < retrievalConfidenceThresholds.maxNoisyKeywordScore
      ) {
        return { verdict: 'empty', ...diagnostics };
      }
      return { verdict: 'weak', ...diagnostics };
    }
    return { verdict: 'empty', ...diagnostics };
  }

  return { verdict: 'weak', ...diagnostics };
}

function finiteScore(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
