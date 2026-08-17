import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveExecutionMode } from './executionMode.js';

const snapshot = { id: 'technology-comparison', version: '1.0.0', digest: 'abc' };

test('no skill and none policy is quick', () => {
  assert.equal(resolveExecutionMode(undefined, { mode: 'none' }), 'quick');
});

test('no skill with selected tools is research', () => {
  assert.equal(resolveExecutionMode(undefined, { mode: 'selected', names: ['search_knowledge'] }), 'research');
});

test('no skill with all tools is research', () => {
  assert.equal(resolveExecutionMode(undefined, { mode: 'all' }), 'research');
});

test('a skill is always research even with none policy', () => {
  assert.equal(resolveExecutionMode(snapshot, { mode: 'none' }), 'research');
});

test('a skill with tools is research', () => {
  assert.equal(resolveExecutionMode(snapshot, { mode: 'all' }), 'research');
});
