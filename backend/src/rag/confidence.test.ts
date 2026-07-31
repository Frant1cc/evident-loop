import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessRetrievalConfidence,
  retrievalConfidenceThresholds
} from './confidence.js';
import type { RagSource } from './types.js';

function source(scores: { semanticScore?: number; keywordScore?: number } = {}): RagSource {
  return {
    id: 'chunk-1',
    file: 'doc.md',
    title: 'Document',
    heading: 'Section',
    content: 'Evidence',
    startLine: 1,
    endLine: 2,
    score: scores.semanticScore ?? 0,
    ...scores
  };
}

test('semantic score at or above 0.55 is sufficient', () => {
  assert.equal(
    assessRetrievalConfidence([
      source({ semanticScore: retrievalConfidenceThresholds.sufficientSemanticScore })
    ]).verdict,
    'sufficient'
  );
});

test('semantic score from the calibrated weak boundary (inclusive) to sufficient is weak', () => {
  assert.equal(
    assessRetrievalConfidence([
      source({ semanticScore: retrievalConfidenceThresholds.weakSemanticScore })
    ]).verdict,
    'weak'
  );
  assert.equal(
    assessRetrievalConfidence([
      source({ semanticScore: retrievalConfidenceThresholds.sufficientSemanticScore - Number.EPSILON })
    ]).verdict,
    'weak'
  );
});

test('semantic score below the calibrated weak boundary or no results is empty', () => {
  assert.equal(
    assessRetrievalConfidence([
      source({ semanticScore: retrievalConfidenceThresholds.weakSemanticScore - Number.EPSILON })
    ]).verdict,
    'empty'
  );
  assert.deepEqual(assessRetrievalConfidence([]), { verdict: 'empty' });
});

test('keyword-only result uses the strong BM25 line and never the RRF score', () => {
  const sufficient = assessRetrievalConfidence([
    source({ keywordScore: retrievalConfidenceThresholds.strongKeywordScore })
  ]);
  const weak = assessRetrievalConfidence([
    source({ keywordScore: retrievalConfidenceThresholds.strongKeywordScore - 0.01 })
  ]);

  assert.equal(sufficient.verdict, 'sufficient');
  assert.equal(weak.verdict, 'weak');
  assert.equal(sufficient.topSemanticScore, undefined);
  assert.equal(sufficient.topKeywordScore, retrievalConfidenceThresholds.strongKeywordScore);
});

test('strong keyword evidence rescues an otherwise empty semantic result', () => {
  assert.equal(
    assessRetrievalConfidence([
      source({ semanticScore: 0.44, keywordScore: 50 })
    ]).verdict,
    'sufficient'
  );
});

test('borderline semantic plus a noisy lexical hit is empty, pure semantic paraphrase remains weak', () => {
  const semanticScore = retrievalConfidenceThresholds.noisyLexicalSemanticCeiling - 0.001;

  assert.equal(
    assessRetrievalConfidence([
      source({
        semanticScore,
        keywordScore: retrievalConfidenceThresholds.maxNoisyKeywordScore - 0.01
      })
    ]).verdict,
    'empty'
  );
  assert.equal(
    assessRetrievalConfidence([source({ semanticScore })]).verdict,
    'weak'
  );
  assert.equal(
    assessRetrievalConfidence([
      source({
        semanticScore,
        keywordScore: retrievalConfidenceThresholds.maxNoisyKeywordScore
      })
    ]).verdict,
    'weak'
  );
});
