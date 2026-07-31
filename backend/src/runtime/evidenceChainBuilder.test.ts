import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEvidenceChainClaims } from './evidenceChainBuilder.js';

function supportedClaim(evidenceKey: string) {
  return JSON.stringify({
    claims: [{
      text: 'MVCC 使用版本链提供一致性读取。',
      status: 'supported',
      confidence: 0.9,
      evidenceLinks: [{
        evidenceKey,
        relation: 'supports',
        rationale: '原文直接支持。'
      }]
    }]
  });
}

test('keeps an exact evidence key', () => {
  const evidenceKey = 'knowledge:database-internals.md:6.-mvcc:section-1:part-1';
  const result = parseEvidenceChainClaims(supportedClaim(evidenceKey), new Set([evidenceKey]));

  assert.equal(result.links[0].evidenceKey, evidenceKey);
});

test('repairs a uniquely matched evidence key with an omitted namespace', () => {
  const chunkId = 'database-internals.md:6.-mvcc:section-1:part-1';
  const evidenceKey = `knowledge:${chunkId}`;
  const result = parseEvidenceChainClaims(supportedClaim(chunkId), new Set([evidenceKey]));

  assert.equal(result.links[0].evidenceKey, evidenceKey);
});

test('rejects an omitted namespace when the evidence key is ambiguous', () => {
  const chunkId = 'shared-chunk';

  assert.throws(
    () => parseEvidenceChainClaims(
      supportedClaim(chunkId),
      new Set([`knowledge:${chunkId}`, `docs:${chunkId}`])
    ),
    /referenced unknown evidence shared-chunk/
  );
});
