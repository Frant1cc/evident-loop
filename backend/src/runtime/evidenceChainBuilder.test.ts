import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEvidenceFromToolExecutions,
  claimExtractionOutput,
  describeEmptyClaimCompletion,
  parseEvidenceChainClaims
} from './evidenceChainBuilder.js';

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

test('removes duplicated tool data from the default step output used for claim extraction', () => {
  const output = {
    reply: 'The step conclusion.',
    sources: [{ content: 'duplicated source content' }],
    toolCalls: [{ result: { content: 'duplicated tool content' } }]
  };

  assert.deepEqual(claimExtractionOutput(output), { reply: 'The step conclusion.' });
  assert.deepEqual(output.sources, [{ content: 'duplicated source content' }]);
  assert.deepEqual(output.toolCalls, [{ result: { content: 'duplicated tool content' } }]);
});

test('keeps custom step output unchanged', () => {
  const output = { summary: 'Custom runner output', facts: ['one'] };

  assert.equal(claimExtractionOutput(output), output);
});

test('describes an empty claim completion with its raw payload', () => {
  const completion = { choices: [{ message: { role: 'assistant' as const, content: '' } }] };

  assert.equal(
    describeEmptyClaimCompletion(completion),
    'Claim extractor returned an empty response (choices: 1): {"choices":[{"message":{"role":"assistant","content":""}}]}'
  );
});

test('describes a completion with no choices', () => {
  assert.equal(
    describeEmptyClaimCompletion({ choices: [] }),
    'Claim extractor returned an empty response (choices: 0): {"choices":[]}'
  );
});

test('promotes each controlled web result into a web source and evidence item', () => {
  const result = buildEvidenceFromToolExecutions([{
    id: 'tool-execution-1',
    taskId: 'task-1',
    stepId: 'step-1',
    executionKey: 'step-1:web',
    toolName: 'retrieve_web_evidence',
    status: 'completed',
    arguments: { question: 'What do the official sources say?' },
    result: {
      verdict: 'sufficient',
      sources: [
        {
          id: 'web-source-1',
          file: 'https://docs.example.com/official-report',
          title: 'Official report',
          heading: 'docs.example.com',
          content: 'The report directly supports the first claim.',
          startLine: 3,
          endLine: 7,
          score: 0.91,
          contentType: 'text'
        },
        {
          id: 'web-source-2',
          file: 'https://data.example.org/statistics',
          title: 'Official statistics',
          heading: 'data.example.org',
          content: 'The statistics provide independent corroboration.',
          startLine: 1,
          endLine: 4,
          score: 0.82,
          contentType: 'text'
        }
      ]
    },
    startedAt: '2026-08-08T00:00:00.000Z',
    completedAt: '2026-08-08T00:00:01.000Z'
  }]);

  assert.deepEqual(result.sources, [
    {
      sourceKey: 'web:https://docs.example.com/official-report',
      type: 'web',
      title: 'Official report',
      uri: 'https://docs.example.com/official-report',
      toolExecutionId: 'tool-execution-1',
      metadata: { domain: 'docs.example.com', contentType: 'text' }
    },
    {
      sourceKey: 'web:https://data.example.org/statistics',
      type: 'web',
      title: 'Official statistics',
      uri: 'https://data.example.org/statistics',
      toolExecutionId: 'tool-execution-1',
      metadata: { domain: 'data.example.org', contentType: 'text' }
    }
  ]);
  assert.deepEqual(result.evidence, [
    {
      evidenceKey: 'web:web-source-1',
      sourceKey: 'web:https://docs.example.com/official-report',
      content: 'The report directly supports the first claim.',
      context: 'docs.example.com',
      locator: { startLine: 3, endLine: 7 },
      relevanceScore: 0.91
    },
    {
      evidenceKey: 'web:web-source-2',
      sourceKey: 'web:https://data.example.org/statistics',
      content: 'The statistics provide independent corroboration.',
      context: 'data.example.org',
      locator: { startLine: 1, endLine: 4 },
      relevanceScore: 0.82
    }
  ]);
});

test('omits empty optional web metadata and locator fields', () => {
  const result = buildEvidenceFromToolExecutions([{
    id: 'tool-execution-1',
    taskId: 'task-1',
    executionKey: 'task-1:web',
    toolName: 'retrieve_web_evidence',
    status: 'completed',
    arguments: { question: 'Minimal source' },
    result: {
      verdict: 'weak',
      sources: [{
        id: 'web-source-1',
        file: 'https://example.com/minimal',
        content: 'A usable but qualified piece of evidence.'
      }]
    },
    startedAt: '2026-08-08T00:00:00.000Z',
    completedAt: '2026-08-08T00:00:01.000Z'
  }]);

  assert.deepEqual(result.sources[0], {
    sourceKey: 'web:https://example.com/minimal',
    type: 'web',
    title: 'https://example.com/minimal',
    uri: 'https://example.com/minimal',
    toolExecutionId: 'tool-execution-1'
  });
  assert.deepEqual(result.evidence[0], {
    evidenceKey: 'web:web-source-1',
    sourceKey: 'web:https://example.com/minimal',
    content: 'A usable but qualified piece of evidence.'
  });
});

test('does not create evidence for an empty controlled web result', () => {
  const result = buildEvidenceFromToolExecutions([{
    id: 'tool-execution-1',
    taskId: 'task-1',
    executionKey: 'task-1:web',
    toolName: 'retrieve_web_evidence',
    status: 'completed',
    arguments: { question: 'No matching evidence' },
    result: { verdict: 'empty', sources: [] },
    startedAt: '2026-08-08T00:00:00.000Z',
    completedAt: '2026-08-08T00:00:01.000Z'
  }]);

  assert.deepEqual(result, { sources: [], evidence: [] });
});

test('keeps legacy search_docs evidence and records ranged read_document locators', () => {
  const base = {
    taskId: 'task-1',
    stepId: 'step-1',
    status: 'completed' as const,
    arguments: {},
    startedAt: '2026-08-08T00:00:00.000Z',
    completedAt: '2026-08-08T00:00:01.000Z'
  };
  const result = buildEvidenceFromToolExecutions([
    {
      ...base,
      id: 'legacy-search',
      executionKey: 'legacy-search',
      toolName: 'search_docs',
      result: { results: [{ file: 'legacy.md', line: 9, preview: 'historical evidence' }] }
    },
    {
      ...base,
      id: 'ranged-read',
      executionKey: 'ranged-read',
      toolName: 'read_document',
      result: {
        file: 'guide.md', content: 'selected lines', startLine: 20, endLine: 24,
        totalLines: 80, truncated: true, nextStartLine: 25, totalChars: 9000
      }
    }
  ]);

  assert.ok(result.evidence.some((item) => item.content === 'historical evidence'));
  assert.deepEqual(result.evidence.find((item) => item.content === 'selected lines')?.locator, {
    truncated: true,
    totalChars: 9000,
    startLine: 20,
    endLine: 24,
    totalLines: 80,
    nextStartLine: 25
  });
});

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
