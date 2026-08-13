import assert from 'node:assert/strict';
import test from 'node:test';

import { getWebEvalCases, webEvalCases, webEvalSuiteVersion } from './fixtures.js';

test('keeps the versioned web benchmark deep enough for regression', () => {
  assert.equal(webEvalSuiteVersion, 2);
  assert.equal(webEvalCases.length, 36);
  assert.equal(getWebEvalCases().length, 10);
  assert.equal(webEvalCases.filter((item) => item.suites.includes('regression')).length, 36);
  assert.equal(new Set(webEvalCases.map((item) => item.id)).size, webEvalCases.length);
  assert.equal(webEvalCases.filter((item) => item.answerable && item.expectedEvidence.length === 0).length, 0);
  assert.ok(webEvalCases.some((item) => !item.answerable));
  assert.ok(webEvalCases.filter((item) => item.difficulty === 'hard').length >= 9);
});
