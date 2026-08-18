import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAuxiliaryState } from './auxiliaryState';
import type { WordArtifact } from '../types/artifacts';
import type { ResearchStep } from '../types/research';

const step = (overrides: Partial<ResearchStep>): ResearchStep => ({
  id: 'step-1',
  conversationId: 'conv-1',
  messageId: 'msg-1',
  sequence: 1,
  type: 'tool',
  status: 'complete',
  title: 'generate_word_document',
  startedAt: '2026-01-01T00:00:00.000Z',
  ...overrides
});

const artifact = (id: string, messageId: string): WordArtifact => ({
  artifactId: id,
  fileName: `${id}.docx`,
  downloadUrl: `/api/artifacts/${id}/download`,
  previewUrl: `/api/artifacts/${id}/preview`,
  size: 1024,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-08T00:00:00.000Z'
});

test('returns empty map when no signals are present', () => {
  const result = buildAuxiliaryState([], new Map());
  assert.equal(result.size, 0);
});

test('reports running when a tool step is still in flight, even with zero artifacts', () => {
  const result = buildAuxiliaryState(
    [step({ status: 'running' })],
    new Map()
  );
  const state = result.get('msg-1');
  assert.ok(state);
  assert.equal(state.status, 'running');
  assert.equal(state.label, '生成的文档');
  assert.equal(state.activity, '正在生成文档…');
  assert.equal(state.count, 0);
});

test('reports complete and counts finished artifacts', () => {
  const artifacts = new Map<string, WordArtifact[]>([
    ['msg-1', [artifact('a-1', 'msg-1'), artifact('a-2', 'msg-1')]]
  ]);
  const result = buildAuxiliaryState([step({ status: 'complete' })], artifacts);
  const state = result.get('msg-1');
  assert.equal(state?.status, 'complete');
  assert.equal(state?.count, 2);
});

test('reports error when the tool step failed and nothing is running', () => {
  const result = buildAuxiliaryState(
    [step({ status: 'error', error: 'tool failed' })],
    new Map()
  );
  const state = result.get('msg-1');
  assert.equal(state?.status, 'error');
});

test('keeps running state over a later error so a fresh attempt is not masked by an old failure', () => {
  const result = buildAuxiliaryState(
    [
      step({ id: 'old', status: 'error', error: 'old failure' }),
      step({ id: 'new', status: 'running' })
    ],
    new Map()
  );
  const state = result.get('msg-1');
  assert.equal(state?.status, 'running');
});

test('aggregates per-message state across multiple steps', () => {
  const artifacts = new Map<string, WordArtifact[]>([
    ['msg-1', [artifact('a-1', 'msg-1')]],
    ['msg-2', [artifact('a-2', 'msg-2'), artifact('a-3', 'msg-2')]]
  ]);
  const result = buildAuxiliaryState(
    [
      step({ id: 's1', messageId: 'msg-1', status: 'complete' }),
      step({ id: 's2', messageId: 'msg-2', status: 'complete' }),
      step({ id: 's3', messageId: 'msg-2', status: 'complete' })
    ],
    artifacts
  );
  assert.equal(result.get('msg-1')?.count, 1);
  assert.equal(result.get('msg-1')?.status, 'complete');
  assert.equal(result.get('msg-2')?.count, 2);
});

test('ignores non-tool steps (e.g. llm planning)', () => {
  const result = buildAuxiliaryState(
    [
      step({ id: 'llm', type: 'llm', status: 'complete' }),
      step({ id: 'tool', status: 'complete' })
    ],
    new Map([['msg-1', [artifact('a-1', 'msg-1')]]])
  );
  assert.equal(result.get('msg-1')?.status, 'complete');
  assert.equal(result.get('msg-1')?.count, 1);
});

test('falls back to generic labels when the tool name is unknown', () => {
  const result = buildAuxiliaryState(
    [step({ title: 'mystery_tool', status: 'running' })],
    new Map()
  );
  const state = result.get('msg-1');
  assert.equal(state?.label, '附件');
  assert.equal(state?.activity, '正在加载附件…');
});
