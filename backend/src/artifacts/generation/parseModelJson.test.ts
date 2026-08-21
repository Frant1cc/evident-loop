import assert from 'node:assert/strict';
import test from 'node:test';

import { parseModelJsonObject } from './parseModelJson.js';

test('parses fenced JSON objects', () => {
  const parsed = parseModelJsonObject('```json\n{"title":"研究"}\n```');
  assert.deepEqual(parsed, { title: '研究' });
});

test('repairs missing commas between array string elements', () => {
  const parsed = parseModelJsonObject(`{
    "bullets": [
      "第一点"
      "第二点"
    ]
  }`);
  assert.deepEqual(parsed, { bullets: ['第一点', '第二点'] });
});

test('repairs trailing commas in nested plan-shaped objects', () => {
  const parsed = parseModelJsonObject(`{
    "brief": { "title": "研究", },
    "presentation": { "slides": [ { "id": "t", }, ], },
  }`);
  assert.equal((parsed as { brief: { title: string } }).brief.title, '研究');
});
